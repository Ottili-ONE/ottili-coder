import { createHash } from "node:crypto";

import type { RunActionExecutor, ScheduledAction } from "@ottili/control-plane";
import type { RunStore } from "@ottili/control-plane";
import {
  PermissionDeniedError,
  evaluatePermission,
  permissionActionsForTool,
  type ToolDefinition as PolicyToolDefinition,
} from "@ottili/core";
import type {
  Agent,
  ApprovalId,
  JsonObject,
  JsonValue,
  ResourceScope,
  RunId,
  RunLease,
} from "@ottili/protocol";
import {
  CompletionGate,
  DeterministicIndependentVerifier,
  type IndependentVerifier,
} from "@ottili/validation";

import { AgentTurnEngine } from "./engine.js";
import {
  classifyProviderFailure,
  retryDelayMs,
  type ProviderFailure,
  type RuntimeMessage,
  type TurnProvider,
} from "./provider.js";
import {
  ToolApprovalRequiredError,
  ToolRegistry,
  type ToolDefinition,
  type ToolResult,
} from "./tools.js";

export interface RunCoordinatorOptions {
  readonly completionGate?: CompletionGate;
  readonly independentVerifier?: IndependentVerifier;
  readonly maxToolCalls?: number;
  readonly model: string;
  readonly provider: TurnProvider;
  readonly tools: ToolRegistry | WorkspaceToolResolver;
}

export type WorkspaceToolResolver = (input: {
  readonly runId: string;
  readonly workspaceUri: string;
}) => ToolRegistry;

/**
 * Bridges a stateless model/tool turn with the lease-fenced durable Run. The
 * coordinator itself is replaceable: all mission truth is written through the
 * control plane before/after every side effect.
 */
export class RunCoordinator implements RunActionExecutor {
  private readonly completionGate: CompletionGate;

  public constructor(
    private readonly store: RunStore,
    private readonly options: RunCoordinatorOptions,
  ) {
    this.completionGate =
      options.completionGate ??
      new CompletionGate(
        options.independentVerifier ?? new DeterministicIndependentVerifier(),
      );
  }

  public async execute(input: {
    readonly action: ScheduledAction;
    readonly lease: RunLease;
    readonly signal: AbortSignal;
  }): Promise<{ readonly requeue: boolean }> {
    if (input.signal.aborted) return { requeue: true };
    const run = this.store.getRun(input.action.runId);
    if (run === undefined || run.currentGoalId === undefined)
      return { requeue: false };
    const coordinator = this.store
      .listAgents(run.id)
      .find((agent) => agent.role === "coordinator");
    if (coordinator === undefined)
      throw new Error(`Run '${run.id}' has no coordinator Agent.`);
    const mission = this.store.getMission(run.missionId);
    if (mission === undefined)
      throw new Error(`Run '${run.id}' has no Mission.`);

    const epoch = this.store.startSessionEpoch({
      agentId: coordinator.id,
      lease: input.lease,
      model: this.options.model,
      provider: this.options.provider.id,
    });
    this.store.appendFencedEvent({
      lease: input.lease,
      payload: { agentId: coordinator.id, sessionEpochId: epoch.id },
      type: "agent.turn_started",
    });

    const sourceTools = this.resolveTools(mission.workspaceUri, run.id);
    const durableTools = this.createDurableTools(
      input.lease,
      coordinator,
      sourceTools,
      mission.workspaceUri,
    );
    const engine = new AgentTurnEngine(this.options.provider, durableTools);
    try {
      const result = await engine.run({
        ...(this.options.maxToolCalls === undefined
          ? {}
          : { maxToolCalls: this.options.maxToolCalls }),
        messages: this.messagesForRun(run.id, mission.prompt),
        model: this.options.model,
        signal: input.signal,
      });
      if (input.signal.aborted) return this.handleAbort(input.lease, epoch.id);
      this.store.recordUsageFenced(input.lease, result.usage);
      this.store.recordCost({
        agentId: coordinator.id,
        lease: input.lease,
        runId: run.id,
        sessionEpochId: epoch.id,
        ...(result.usage.cachedTokens === undefined
          ? {}
          : { cachedTokens: result.usage.cachedTokens }),
        ...(result.usage.costUsd === undefined
          ? {}
          : { costUsd: result.usage.costUsd }),
        ...(result.usage.inputTokens === undefined
          ? {}
          : { inputTokens: result.usage.inputTokens }),
        ...(result.usage.outputTokens === undefined
          ? {}
          : { outputTokens: result.usage.outputTokens }),
      });
      for (const event of result.events) {
        if (event.type === "assistant_text" && event.text !== undefined) {
          this.store.appendFencedEvent({
            lease: input.lease,
            payload: {
              agentId: coordinator.id,
              sessionEpochId: epoch.id,
              text: event.text,
            },
            type: "agent.message",
          });
        }
      }
      this.store.endSessionEpoch({
        id: epoch.id,
        lease: input.lease,
        reason: "completed",
      });

      const requestedCompletion = result.toolExecutions.some(
        (execution) =>
          execution.status === "succeeded" &&
          sourceTools.get(execution.call.name)?.completesRun === true,
      );
      if (!requestedCompletion) return { requeue: true };
      const decision = await this.completionGate.evaluate({
        requirements: this.store.listRequirements(run.id),
        validations: this.store.listValidations(run.id).map((validation) => ({
          id: validation.id,
          passed: validation.passed,
          summary: validation.summary,
        })),
      });
      if (decision.accepted && decision.verifier?.complete === true) {
        this.store.recordValidation({
          independent: true,
          lease: input.lease,
          name: "completion-ledger-audit",
          passed: true,
          runId: run.id,
          summary:
            "A separate deterministic verifier re-audited the durable requirement ledger and validation records.",
        });
      }
      this.store.proposeCompletion({
        accepted: decision.accepted,
        independentlyVerified: decision.verifier?.complete === true,
        lease: input.lease,
        reasons: decision.reasons,
        runId: run.id,
      });
      return { requeue: !decision.accepted };
    } catch (error: unknown) {
      if (input.signal.aborted) return this.handleAbort(input.lease, epoch.id);
      if (error instanceof ToolApprovalRequiredError) {
        return this.handleApprovalWait({
          action: input.action,
          approvalId: error.approvalId as ApprovalId,
          epochId: epoch.id,
          lease: input.lease,
        });
      }
      const failure = classifyProviderFailure(error);
      return this.handleFailure(input.action, input.lease, epoch.id, failure);
    }
  }

  /** A pause/cancel is not a provider outage and must never schedule a retry. */
  private handleAbort(
    lease: RunLease,
    epochId: string,
  ): { readonly requeue: true } {
    this.store.endSessionEpoch({
      id: epochId as never,
      lease,
      reason: "aborted",
    });
    return { requeue: true };
  }

  private createDurableTools(
    lease: RunLease,
    agent: Agent,
    sourceTools: ToolRegistry,
    workspaceUri: string,
  ): ToolRegistry {
    const durable = new ToolRegistry();
    for (const original of sourceTools.list()) {
      durable.register({
        ...original,
        execute: async (input, signal): Promise<ToolResult> => {
          const requestedScopes = original.resourceScopes(input);
          const approvalId = this.authorizeTool({
            agent,
            input,
            lease,
            requestedScopes,
            tool: original,
          });
          const scopes = requestedScopes.map((value) => {
            const scope = runtimeScope(value);
            return {
              ...scope,
              identifier: `${workspaceUri}:${scope.identifier}`,
            };
          });
          if (scopes.length > 0) {
            this.store.acquireResourceLocks({
              executorId: lease.executorId,
              runId: lease.runId,
              scopes,
              ttlMs: 15 * 60_000,
            });
          }
          const toolCallId = this.store.recordToolIntent({
            agentId: agent.id,
            ...(approvalId === undefined ? {} : { approvalId }),
            definition: {
              idempotency: original.idempotency,
              name: original.name,
              recovery: original.recovery,
              sideEffectClass: original.sideEffect,
            },
            input: jsonValue(input),
            lease,
          });
          try {
            const result = await original.execute(input, signal);
            this.store.completeToolCall({
              lease,
              output: jsonValue({
                artifacts: result.artifacts ?? [],
                output: result.output,
              }),
              toolCallId,
            });
            return result;
          } catch (error: unknown) {
            const message =
              error instanceof Error
                ? error.message
                : "Tool failed with an unknown error.";
            this.store.completeToolCall({
              error: { code: "tool_failed", message },
              lease,
              toolCallId,
            });
            throw error;
          } finally {
            if (scopes.length > 0) {
              this.store.releaseResourceLocks(lease.executorId, lease.runId);
            }
          }
        },
      } satisfies ToolDefinition);
    }
    return durable;
  }

  /**
   * Evaluates the durable delegated Agent policy and its sandbox before a
   * resource lock, intent row, or tool executor can produce a side effect.
   * The approval summary is a stable capability fingerprint, so an approval
   * cannot be replayed for a different input or resource scope.
   */
  private authorizeTool(input: {
    readonly agent: Agent;
    readonly input: Record<string, unknown>;
    readonly lease: RunLease;
    readonly requestedScopes: readonly string[];
    readonly tool: ToolDefinition;
  }): ApprovalId | undefined {
    const policyScopes = input.requestedScopes.map(runtimeScope);
    const scoped = policyScopes.length === 0 ? [undefined] : policyScopes;
    const evaluations = permissionActionsForTool(
      policyDefinition(input.tool),
    ).flatMap((action) =>
      scoped.map((resourceScope) =>
        evaluatePermission({
          action,
          ...(resourceScope === undefined ? {} : { resourceScope }),
          ...(input.tool.permissions?.requiresApproval === true
            ? { requiresApproval: true }
            : {}),
          runPolicy: input.agent.permissions,
          sandbox: input.agent.sandbox,
          toolName: input.tool.name,
        }),
      ),
    );
    const denied = evaluations.find(
      (evaluation) => evaluation.decision === "deny",
    );
    if (denied !== undefined) {
      this.store.appendFencedEvent({
        lease: input.lease,
        payload: {
          action: denied.action,
          agentId: input.agent.id,
          decision: "deny",
          reasons: [...denied.reasons],
          toolName: input.tool.name,
        },
        type: "agent.progress",
      });
      throw new PermissionDeniedError(
        denied.action,
        `Tool '${input.tool.name}' is blocked by ${denied.reasons.join(", ")}.`,
      );
    }
    const prompts = evaluations.filter(
      (evaluation) => evaluation.decision === "prompt",
    );
    if (prompts.length === 0) return undefined;

    const summary = approvalSummary({
      input: input.input,
      prompts,
      scopes: policyScopes,
      tool: input.tool,
    });
    const latest = this.store
      .listApprovals(input.lease.runId)
      .filter((approval) => approval.summary === summary)
      .at(-1);
    if (latest?.status === "approved") return latest.id;
    if (latest?.status === "pending") {
      throw new ToolApprovalRequiredError(latest.id);
    }
    if (latest?.status === "rejected") {
      throw new PermissionDeniedError(
        prompts[0]?.action ?? "approve",
        `The matching durable approval for tool '${input.tool.name}' was rejected.`,
      );
    }

    const approval = this.store.requestApproval({
      agentId: input.agent.id,
      lease: input.lease,
      runId: input.lease.runId,
      summary,
    });
    throw new ToolApprovalRequiredError(approval.id);
  }

  private handleApprovalWait(input: {
    readonly action: ScheduledAction;
    readonly approvalId: ApprovalId;
    readonly epochId: string;
    readonly lease: RunLease;
  }): { readonly requeue: boolean } {
    this.store.endSessionEpoch({
      id: input.epochId as never,
      lease: input.lease,
      reason: "completed",
    });
    const approval = this.store
      .listApprovals(input.lease.runId)
      .find((candidate) => candidate.id === input.approvalId);
    const run = this.store.getRun(input.action.runId);
    if (approval?.status === "pending" && run?.status === "running") {
      this.store.transitionRun({
        lease: input.lease,
        reason: `Awaiting approval '${input.approvalId}'.`,
        runId: input.action.runId,
        to: "waiting_external",
      });
    }
    // If resolution raced the turn teardown, a `true` requeue guarantees the
    // scheduler recreates the continuation after releasing the old claim. If
    // it remains pending, the waiting state suppresses that continuation.
    return { requeue: true };
  }

  private resolveTools(workspaceUri: string, runId: string): ToolRegistry {
    return this.options.tools instanceof ToolRegistry
      ? this.options.tools
      : this.options.tools({ runId, workspaceUri });
  }

  /**
   * Rebuilds a bounded transcript only from durable events, snapshots, and
   * memory. No live chat connection is consulted, so a replacement daemon can
   * continue a goal without requiring a new user prompt.
   */
  private messagesForRun(
    runId: RunId,
    missionPrompt: string,
  ): readonly RuntimeMessage[] {
    const history: RuntimeMessage[] = [];
    for (const event of this.store.listEvents(runId)) {
      const payload = event.payload;
      if (
        event.type === "steering.received" &&
        typeof payload.text === "string"
      ) {
        history.push({ content: payload.text, role: "user" });
      } else if (
        event.type === "agent.message" &&
        typeof payload.text === "string"
      ) {
        history.push({ content: payload.text, role: "assistant" });
      } else if (
        event.type === "tool.call_started" &&
        typeof payload.name === "string"
      ) {
        history.push({
          content: `Tool invoked: ${payload.name}.`,
          role: "assistant",
        });
      } else if (
        event.type === "tool.call_finished" &&
        typeof payload.toolCallId === "string"
      ) {
        const output = payload.output;
        const content =
          output === undefined
            ? "Tool finished without serializable output."
            : stringifyForContext(output);
        history.push({ content, role: "tool", toolCallId: payload.toolCallId });
      }
    }
    const snapshots = this.store.listContextSnapshots(runId);
    const latestSnapshot = snapshots.at(-1);
    const memories = this.store
      .listMemoryEntries(runId)
      .filter((entry) => entry.confidence >= 0.5)
      .slice(-4);
    const retained = trimMessages(history, 48, 48_000);
    return [
      {
        content:
          "You are the Ottili mission coordinator. Continue toward durable, independently verifiable completion. A normal response never finishes the Run.",
        role: "system",
      },
      { content: missionPrompt, role: "user" },
      ...(latestSnapshot === undefined
        ? []
        : [
            {
              content: `Prior context checkpoint:\n${latestSnapshot.summary}`,
              role: "system" as const,
            },
          ]),
      ...memories.map((entry) => ({
        content: `Durable memory: ${entry.content}`,
        role: "system" as const,
      })),
      ...retained,
    ];
  }

  private handleFailure(
    action: ScheduledAction,
    lease: RunLease,
    epochId: string,
    failure: ProviderFailure,
  ): { readonly requeue: boolean } {
    if (failure.kind === "context_overflow") {
      const summary = summarizeContext(this.store.listEvents(lease.runId));
      this.store.createContextSnapshot({
        lease,
        runId: lease.runId,
        sessionEpochId: epochId as never,
        summary,
        tokenCount: estimateTokens(summary),
      });
    }
    this.store.endSessionEpoch({
      id: epochId as never,
      lease,
      reason:
        failure.kind === "context_overflow" ? "context_overflow" : "failed",
    });
    this.store.appendFencedEvent({
      lease,
      payload: { kind: failure.kind, message: failure.message },
      type: "provider.failed",
    });
    if (failure.kind === "context_overflow") {
      this.store.appendFencedEvent({
        lease,
        payload: { action: "new_session_epoch", reason: "context_overflow" },
        type: "context.compacted",
      });
      return { requeue: true };
    }
    if (failure.retryable) {
      const delay = retryDelayMs(action.attempt, failure.retryAfterMs);
      this.store.scheduleWake({
        lease,
        runId: action.runId,
        wakeAt: new Date(Date.now() + delay),
      });
      this.store.appendFencedEvent({
        lease,
        payload: { delayMs: delay, kind: failure.kind },
        type: "run.retry_scheduled",
      });
      return { requeue: false };
    }
    // Non-retryable provider failures need a human/alternate provider rather
    // than silently ending a durable Run.
    this.store.transitionRun({
      lease,
      reason: `Provider failure: ${failure.kind}`,
      runId: action.runId,
      to: "waiting_external",
    });
    return { requeue: false };
  }
}

function stringifyForContext(value: JsonValue): string {
  const encoded = JSON.stringify(value);
  return encoded.length <= 8_000
    ? encoded
    : `${encoded.slice(0, 8_000)}\n[durable tool output truncated]`;
}

function trimMessages(
  messages: readonly RuntimeMessage[],
  maximumMessages: number,
  maximumCharacters: number,
): readonly RuntimeMessage[] {
  const retained: RuntimeMessage[] = [];
  let characters = 0;
  for (const message of [...messages].reverse()) {
    if (
      retained.length >= maximumMessages ||
      characters + message.content.length > maximumCharacters
    )
      break;
    retained.push(message);
    characters += message.content.length;
  }
  return retained.reverse();
}

function summarizeContext(
  events: readonly { readonly type: string; readonly payload: JsonObject }[],
): string {
  const lines = events
    .filter((event) =>
      ["steering.received", "agent.message", "tool.call_finished"].includes(
        event.type,
      ),
    )
    .slice(-40)
    .map((event) => `${event.type}: ${stringifyForContext(event.payload)}`);
  const joined = lines.join("\n");
  return joined.length <= 24_000 ? joined : joined.slice(-24_000);
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function runtimeScope(value: string): ResourceScope {
  const separator = value.indexOf(":");
  const suppliedKind = separator < 0 ? "custom" : value.slice(0, separator);
  const identifier = separator < 0 ? value : value.slice(separator + 1);
  const kind = [
    "custom",
    "database",
    "deployment",
    "file",
    "git",
    "process",
    "repository",
    "service",
  ].includes(suppliedKind)
    ? (suppliedKind as ResourceScope["kind"])
    : "custom";
  return { access: "write", identifier, kind };
}

function policyDefinition(tool: ToolDefinition): PolicyToolDefinition {
  return {
    ...(tool.completesRun === undefined
      ? {}
      : { completesRun: tool.completesRun }),
    description: tool.description,
    idempotency: tool.idempotency,
    name: tool.name,
    permissions: tool.permissions ?? { required: [] },
    recovery: tool.recovery,
    resourceScopes: [],
    sideEffectClass: tool.sideEffect,
    supportsBackground: tool.supportsBackground,
  };
}

function approvalSummary(input: {
  readonly input: Record<string, unknown>;
  readonly prompts: readonly {
    readonly action: string;
    readonly reasons: readonly string[];
  }[];
  readonly scopes: readonly ResourceScope[];
  readonly tool: ToolDefinition;
}): string {
  const requestDigest = createHash("sha256")
    .update(canonicalJson(jsonValue(input.input)))
    .digest("hex");
  const actions = input.prompts
    .map((prompt) => `${prompt.action}:${[...prompt.reasons].sort().join(",")}`)
    .sort()
    .join(";");
  const scopes = input.scopes
    .map((scope) => `${scope.kind}:${scope.identifier}:${scope.access}`)
    .sort()
    .join(",");
  return `Policy approval required for tool '${input.tool.name}' (request=${requestDigest}; actions=${actions}; scopes=${scopes || "global"}).`;
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function jsonValue(value: unknown): JsonValue {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return null;
  return JSON.parse(encoded) as JsonValue;
}

export function toolDefinitionFromRuntime(tool: ToolDefinition): JsonObject {
  return {
    idempotency: tool.idempotency,
    name: tool.name,
    recovery: tool.recovery,
    sideEffectClass: tool.sideEffect,
  };
}
