import { fileURLToPath } from "node:url";

import type { AgentMessage, RunStore } from "@ottili/control-plane";
import {
  planContext,
  readRepositoryFiles,
  RepoMap,
  SemanticIndex,
  type ContextItem,
  type ContextPlan,
  type RepoMapFile,
} from "@ottili/context";
import type {
  Agent,
  JsonObject,
  JsonValue,
  Mission,
  Run,
  RunId,
  Task,
} from "@ottili/protocol";
import { GitService, type GitStatus } from "@ottili/workspace";

import type { RuntimeMessage } from "./provider.js";

/** Diagnostics a language server can contribute without the runtime owning it. */
export interface WorkspaceDiagnostic {
  readonly path: string;
  readonly line: number;
  readonly severity: "error" | "hint" | "information" | "warning";
  readonly message: string;
}

/**
 * Ports for capabilities that must not pull process supervision into the turn
 * loop. A composition root supplies them; the runtime only consumes results.
 */
export interface DiagnosticsProvider {
  diagnostics(workspacePath: string): Promise<readonly WorkspaceDiagnostic[]>;
}

export interface RunContextRequest {
  readonly activeTask: Task | undefined;
  readonly agent: Agent;
  readonly inbox: readonly AgentMessage[];
  readonly mission: Mission;
  readonly run: Run;
  readonly signal?: AbortSignal;
}

export interface CompiledContext {
  readonly messages: readonly RuntimeMessage[];
  /** Sources the budget could not fit, surfaced for durable diagnostics. */
  readonly omitted: readonly string[];
  readonly usedTokens: number;
}

export interface ContextCompiler {
  compile(request: RunContextRequest): Promise<CompiledContext>;
}

export interface RunContextCompilerOptions {
  /** Total budget for the compiled system context, excluding the transcript. */
  readonly budgetTokens?: number;
  readonly diagnostics?: DiagnosticsProvider;
  /** Injectable so tests and non-Git workspaces stay deterministic. */
  readonly gitServiceFactory?: (workspacePath: string) => GitService;
  readonly maxRepoMapTokens?: number;
  readonly maxSemanticResults?: number;
  readonly maxTranscriptCharacters?: number;
  readonly maxTranscriptMessages?: number;
  readonly repoMap?: RepoMap;
  readonly semanticIndex?: SemanticIndex;
  /** Caps the workspace scan so a huge repository cannot stall a turn. */
  readonly maxWorkspaceFiles?: number;
}

interface WorkspaceView {
  readonly diagnostics: readonly WorkspaceDiagnostic[];
  readonly path: string;
  readonly repoMapText?: string;
  readonly semanticText?: string;
  readonly status?: GitStatus;
  readonly diff?: string;
}

const DEFAULT_BUDGET_TOKENS = 12_000;

function workspacePathOf(mission: Mission): string | undefined {
  if (!mission.workspaceUri.startsWith("file:")) return undefined;
  try {
    return fileURLToPath(mission.workspaceUri);
  } catch {
    return undefined;
  }
}

function stringifyForContext(value: JsonValue, limit = 8_000): string {
  const encoded = JSON.stringify(value);
  return encoded.length <= limit
    ? encoded
    : `${encoded.slice(0, limit)}\n[durable tool output truncated]`;
}

function roleBriefing(agent: Agent): string {
  const shared =
    "Record durable evidence with record_evidence/record_validation; the completion gate re-audits the ledger and ignores any claim of being finished. A normal response never finishes the Run.";
  switch (agent.role) {
    case "coordinator":
      return `You are the Ottili mission coordinator. Break the mission into durable tasks, delegate specialised work with delegate_task, and drive toward independently verifiable completion. ${shared}`;
    case "researcher":
      return `You are an Ottili research agent. Investigate the workspace and report findings to the coordinator. Do not change code. ${shared}`;
    case "implementer":
      return `You are an Ottili implementation agent. Make the smallest correct change that satisfies your task. ${shared}`;
    case "debugger":
      return `You are an Ottili debugging agent. Reproduce the failure first, then explain and fix its cause. ${shared}`;
    case "reviewer":
      return `You are an Ottili review agent. Review the change critically and independently; do not accept it because it was requested. ${shared}`;
    case "verifier":
      return `You are an Ottili verification agent. Re-derive whether the requirements are actually proven by the recorded evidence. ${shared}`;
    default:
      return `You are an Ottili specialist agent working one task of a larger mission. ${shared}`;
  }
}

/**
 * Compiles one turn's context from durable state plus the live workspace.
 *
 * The compiler is deliberately not a source of truth: everything it reads is
 * either a control-plane projection or the checked-out workspace, so a
 * replacement daemon rebuilds an equivalent context without inheriting any
 * in-memory conversation. Sources compete for an explicit token budget through
 * the context planner rather than being concatenated until something breaks.
 */
export class RunContextCompiler implements ContextCompiler {
  private readonly repoMap: RepoMap;
  private readonly semanticIndex: SemanticIndex;
  private readonly workspaceFingerprints = new Map<string, string>();

  public constructor(
    private readonly store: RunStore,
    private readonly options: RunContextCompilerOptions = {},
  ) {
    this.repoMap = options.repoMap ?? new RepoMap();
    this.semanticIndex = options.semanticIndex ?? new SemanticIndex();
  }

  public async compile(request: RunContextRequest): Promise<CompiledContext> {
    const workspace = await this.readWorkspace(request);
    const plan = planContext({
      budgetTokens: this.options.budgetTokens ?? DEFAULT_BUDGET_TOKENS,
      candidates: this.candidateItems(request, workspace),
      fixed: this.fixedItems(request),
    });
    return {
      messages: [
        { content: roleBriefing(request.agent), role: "system" },
        { content: request.mission.prompt, role: "user" },
        { content: plan.text, role: "system" },
        ...this.transcript(request.run.id),
      ],
      omitted: plan.omitted.map((item) => `${item.source}:${item.reason}`),
      usedTokens: plan.usedTokens,
    };
  }

  /** Mission-critical context that must never be dropped for budget reasons. */
  private fixedItems(request: RunContextRequest): readonly ContextItem[] {
    const { activeTask, agent, run } = request;
    const goal =
      run.currentGoalId === undefined
        ? undefined
        : this.store.getGoal(run.currentGoalId);
    const items: ContextItem[] = [
      {
        content:
          activeTask === undefined
            ? "You own no task right now. Use plan_tasks to break the mission down, or take the next ready task."
            : `Current task '${activeTask.title}' (${activeTask.id}): ${activeTask.description}${
                activeTask.lastError === undefined
                  ? ""
                  : `\nPrevious attempt failed: ${activeTask.lastError} (attempt ${activeTask.attempt})`
              }`,
        id: "task.active",
        priority: 10,
        source: "task",
      },
      {
        content: `Run status: ${run.status}. Agent role: ${agent.role}. Budget used: ${JSON.stringify(run.usage)}${
          run.budget === undefined ? "" : ` of ${JSON.stringify(run.budget)}`
        }.`,
        id: "run.state",
        priority: 8,
        source: "run_state",
      },
    ];
    if (goal !== undefined) {
      items.push({
        content: `Goal '${goal.title}': ${goal.description} (${goal.status})`,
        id: "goal.active",
        priority: 9,
        source: "goal",
      });
    }
    const requirements = this.store.listRequirements(run.id);
    if (requirements.length > 0) {
      items.push({
        content: `Requirements the completion gate will re-audit:\n${requirements
          .map(
            (requirement) =>
              `- ${requirement.id} [${requirement.status}${requirement.required ? ", required" : ", optional"}] ${requirement.title}` +
              (requirement.evidence.length === 0
                ? ""
                : `\n    evidence: ${requirement.evidence
                    .map((item) => `${item.kind}/${item.strength}`)
                    .join(", ")}`),
          )
          .join("\n")}`,
        id: "requirements",
        priority: 9,
        source: "validation",
      });
    }
    return items;
  }

  /** Everything else competes for the remaining budget on relevance. */
  private candidateItems(
    request: RunContextRequest,
    workspace: WorkspaceView | undefined,
  ): readonly ContextItem[] {
    const runId = request.run.id;
    const items: ContextItem[] = [];
    const tasks = this.store.listTasks(runId);
    if (tasks.length > 0) {
      items.push({
        allowTruncate: true,
        content: `Task graph:\n${tasks
          .map(
            (task) =>
              `- ${task.id} [${task.status}] ${task.title}${
                task.dependencyIds.length === 0
                  ? ""
                  : ` (after ${task.dependencyIds.join(", ")})`
              }${task.ownerAgentId === undefined ? "" : ` owner=${task.ownerAgentId}`}`,
          )
          .join("\n")}`,
        id: "task.graph",
        relevance: 0.95,
        source: "task",
      });
    }
    if (request.inbox.length > 0) {
      items.push({
        content: `Messages addressed to you:\n${request.inbox
          .map(
            (message) =>
              `- ${message.kind} from ${message.fromAgentId ?? "the run"}: ${JSON.stringify(message.body)}`,
          )
          .join("\n")}`,
        id: "agent.inbox",
        priority: 7,
        relevance: 1,
        source: "run_state",
      });
    }
    const validations = this.store
      .listValidations(runId)
      .filter((validation) => !validation.passed)
      .slice(-5);
    if (validations.length > 0) {
      items.push({
        content: `Failing validations that still block completion:\n${validations
          .map((validation) => `- ${validation.name}: ${validation.summary}`)
          .join("\n")}`,
        id: "validation.failing",
        priority: 6,
        relevance: 1,
        source: "validation",
      });
    }
    const snapshot = this.store.listContextSnapshots(runId).at(-1);
    if (snapshot !== undefined) {
      items.push({
        allowTruncate: true,
        content: `Prior context checkpoint:\n${snapshot.summary}`,
        id: "context.snapshot",
        relevance: 0.8,
        source: "run_state",
      });
    }
    const memories = this.store
      .listMemoryEntries(runId)
      .filter((entry) => entry.confidence >= 0.5)
      .slice(-8);
    for (const entry of memories) {
      items.push({
        content: `Durable memory: ${entry.content}`,
        id: `memory.${entry.id}`,
        relevance: entry.confidence,
        source: "memory",
      });
    }
    const problems = this.store
      .listProblems(runId)
      .filter((problem) => problem.status !== "resolved")
      .slice(-5);
    if (problems.length > 0) {
      items.push({
        content: `Open problems:\n${problems
          .map((problem) => `- ${problem.summary}`)
          .join("\n")}`,
        id: "problems",
        relevance: 0.85,
        source: "run_state",
      });
    }
    if (workspace !== undefined) {
      if (workspace.status !== undefined) {
        items.push({
          allowTruncate: true,
          content: `Git: branch ${workspace.status.branch ?? "detached"} at ${workspace.status.head ?? "no commit"}.\n${
            workspace.status.entries.length === 0
              ? "The working tree is clean."
              : workspace.status.entries
                  .slice(0, 40)
                  .map(
                    (entry) =>
                      `- ${entry.indexStatus}${entry.worktreeStatus} ${entry.path}`,
                  )
                  .join("\n")
          }`,
          id: "git.status",
          priority: 5,
          relevance: 0.9,
          source: "git",
        });
      }
      if (workspace.diff !== undefined && workspace.diff.length > 0) {
        items.push({
          allowTruncate: true,
          content: `Uncommitted diff:\n${workspace.diff}`,
          id: "git.diff",
          maxTokens: 2_000,
          relevance: 0.85,
          source: "git",
        });
      }
      if (workspace.diagnostics.length > 0) {
        items.push({
          allowTruncate: true,
          content: `Language server diagnostics:\n${workspace.diagnostics
            .slice(0, 40)
            .map(
              (diagnostic) =>
                `- ${diagnostic.severity} ${diagnostic.path}:${diagnostic.line} ${diagnostic.message}`,
            )
            .join("\n")}`,
          id: "lsp.diagnostics",
          priority: 5,
          relevance: 0.9,
          source: "lsp",
        });
      }
      if (workspace.semanticText !== undefined) {
        items.push({
          allowTruncate: true,
          content: workspace.semanticText,
          id: "semantic.matches",
          relevance: 0.8,
          source: "semantic",
        });
      }
      if (workspace.repoMapText !== undefined) {
        items.push({
          allowTruncate: true,
          content: `Repository map:\n${workspace.repoMapText}`,
          id: "repo.map",
          relevance: 0.6,
          source: "repo_map",
        });
      }
    }
    return items;
  }

  /**
   * Reads the live workspace. Every failure is tolerated: a missing or
   * non-Git workspace must degrade the context, never end a durable Run.
   */
  private async readWorkspace(
    request: RunContextRequest,
  ): Promise<WorkspaceView | undefined> {
    const path = workspacePathOf(request.mission);
    if (path === undefined) return undefined;
    const git = this.options.gitServiceFactory?.(path) ?? new GitService(path);
    let status: GitStatus | undefined;
    let diff: string | undefined;
    try {
      if (await git.isRepository()) {
        status = await git.getStatus();
        diff = await git.getDiff();
      }
    } catch {
      status = undefined;
    }

    const files = await this.readSourceFiles(path);
    const query = [
      request.activeTask?.title,
      request.activeTask?.description,
      request.mission.prompt,
    ]
      .filter((value): value is string => value !== undefined)
      .join(" ");
    let repoMapText: string | undefined;
    let semanticText: string | undefined;
    if (files.length > 0) {
      try {
        repoMapText = this.repoMap.build(files, {
          activeFiles: (status?.entries ?? []).map((entry) => entry.path),
          maxTokens: this.options.maxRepoMapTokens ?? 1_500,
          query,
        }).text;
      } catch {
        repoMapText = undefined;
      }
      semanticText = await this.searchSemanticIndex(path, files, query);
    }

    let diagnostics: readonly WorkspaceDiagnostic[] = [];
    try {
      diagnostics = (await this.options.diagnostics?.diagnostics(path)) ?? [];
    } catch {
      diagnostics = [];
    }

    return {
      diagnostics,
      path,
      ...(diff === undefined ? {} : { diff }),
      ...(repoMapText === undefined ? {} : { repoMapText }),
      ...(semanticText === undefined ? {} : { semanticText }),
      ...(status === undefined ? {} : { status }),
    };
  }

  private async readSourceFiles(
    workspacePath: string,
  ): Promise<readonly RepoMapFile[]> {
    try {
      // One walk feeds both the repository map and the semantic index.
      return await readRepositoryFiles(workspacePath, {
        maxFiles: this.options.maxWorkspaceFiles ?? 600,
      });
    } catch {
      return [];
    }
  }

  private async searchSemanticIndex(
    workspacePath: string,
    files: readonly RepoMapFile[],
    query: string,
  ): Promise<string | undefined> {
    if (query.trim().length === 0) return undefined;
    const fingerprint = `${files.length}:${files
      .map((file) => `${file.path}:${file.content.length}`)
      .join("|")}`;
    try {
      if (this.workspaceFingerprints.get(workspacePath) !== fingerprint) {
        await this.semanticIndex.index(files);
        this.workspaceFingerprints.set(workspacePath, fingerprint);
      }
      const response = this.semanticIndex.search(query, {
        maxResults: this.options.maxSemanticResults ?? 5,
      });
      if (response.results.length === 0) return undefined;
      return `Semantically relevant code:\n${response.results
        .map(
          (result) =>
            `--- ${result.path}:${result.startLine}-${result.endLine}\n${result.text}`,
        )
        .join("\n")}`;
    } catch {
      return undefined;
    }
  }

  /**
   * Rebuilds the bounded transcript from durable events only. Tool results keep
   * their call ids so a provider still sees a well-formed exchange.
   */
  private transcript(runId: RunId): readonly RuntimeMessage[] {
    const history: RuntimeMessage[] = [];
    for (const event of this.store.listEvents(runId)) {
      const payload: JsonObject = event.payload;
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
        history.push({
          content:
            output === undefined
              ? "Tool finished without serializable output."
              : stringifyForContext(output),
          role: "tool",
          toolCallId: payload.toolCallId,
        });
      }
    }
    return trimMessages(
      history,
      this.options.maxTranscriptMessages ?? 48,
      this.options.maxTranscriptCharacters ?? 48_000,
    );
  }
}

/** Keeps the most recent exchange rather than the oldest. */
export function trimMessages(
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

export type { ContextPlan };
