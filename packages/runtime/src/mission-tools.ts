import type { FencedLease, RunStore } from "@ottili/control-plane";
import type {
  Agent,
  AgentId,
  AgentRole,
  JsonObject,
  RunId,
  TaskId,
} from "@ottili/protocol";

import { ToolRegistry, type ToolDefinition, type ToolResult } from "./tools.js";

export interface MissionToolContext {
  /** The Agent whose turn is executing; every write is attributed to it. */
  readonly agent: Agent;
  readonly lease: FencedLease;
  readonly runId: RunId;
  readonly store: RunStore;
}

const AGENT_ROLES: readonly AgentRole[] = [
  "coordinator",
  "debugger",
  "implementer",
  "researcher",
  "reviewer",
  "specialist",
  "verifier",
];

const EVIDENCE_KINDS = [
  "artifact",
  "command",
  "inspection",
  "review",
  "test",
] as const;
const EVIDENCE_STRENGTHS = ["strong", "supporting", "weak"] as const;

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return value;
}

function optionalString(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string.`);
  return value;
}

function oneOf<Value extends string>(
  value: string,
  allowed: readonly Value[],
  key: string,
): Value {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new Error(`${key} must be one of: ${allowed.join(", ")}.`);
  }
  return match;
}

function objectArray(
  input: Record<string, unknown>,
  key: string,
): readonly Record<string, unknown>[] {
  const value = input[key];
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) =>
        typeof entry !== "object" || entry === null || Array.isArray(entry),
    )
  ) {
    throw new Error(`${key} must be an array of objects.`);
  }
  return value as readonly Record<string, unknown>[];
}

function stringArray(
  input: Record<string, unknown>,
  key: string,
): readonly string[] {
  const value = input[key];
  if (value === undefined || value === null) return [];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`${key} must be an array of strings.`);
  }
  return value as readonly string[];
}

/** Control-plane tools never leave the process; they are `none` side effects. */
function controlPlaneTool(
  input: Pick<ToolDefinition, "description" | "name"> & {
    readonly execute: ToolDefinition["execute"];
  },
): ToolDefinition {
  return {
    description: input.description,
    execute: input.execute,
    idempotency: "conditional",
    name: input.name,
    permissions: { required: ["read"] },
    recovery: "retry",
    resourceScopes: () => [],
    sideEffect: "none",
    supportsBackground: false,
  };
}

/**
 * Durable Task Graph, Agent Graph, and evidence tools.
 *
 * Without these the model can read and edit a workspace but cannot record the
 * requirements, evidence, or task structure the completion gate depends on,
 * which makes an evidence-gated Run impossible to finish honestly. Every write
 * carries the executor's lease, so a superseded executor cannot mutate the
 * graph after a takeover.
 */
export function createMissionTools(context: MissionToolContext): ToolRegistry {
  const registry = new ToolRegistry();
  const { agent, lease, runId, store } = context;

  registry.register(
    controlPlaneTool({
      description:
        "Create durable tasks for this Run. Dependencies may reference an existing task id or the title of another task in the same call.",
      name: "plan_tasks",
      async execute(input): Promise<ToolResult> {
        const requested = objectArray(input, "tasks");
        if (requested.length === 0) {
          throw new Error("plan_tasks requires at least one task.");
        }
        const existing = store.listTasks(runId);
        const idsByTitle = new Map<string, TaskId>(
          existing.map((task) => [task.title, task.id]),
        );
        const created: string[] = [];
        for (const entry of requested) {
          const title = requiredString(entry, "title");
          const dependencies = stringArray(entry, "dependsOn").map(
            (reference) => {
              const resolved =
                idsByTitle.get(reference) ?? (reference as TaskId);
              if (
                !existing.some((task) => task.id === resolved) &&
                !created.includes(resolved)
              ) {
                throw new Error(
                  `Task dependency '${reference}' does not name a known task.`,
                );
              }
              return resolved;
            },
          );
          const task = store.createTask({
            dependencies,
            description: requiredString(entry, "description"),
            lease,
            requirementIds: stringArray(entry, "requirementIds"),
            runId,
            title,
          });
          idsByTitle.set(title, task.id);
          created.push(task.id);
        }
        return {
          output: JSON.stringify({
            created: created.length,
            tasks: store
              .listTasks(runId)
              .map(({ id, status, title }) => ({ id, status, title })),
          }),
        };
      },
    }),
  );

  registry.register(
    controlPlaneTool({
      description:
        "List the durable Task Graph with status, ownership, and dependencies.",
      name: "list_tasks",
      async execute(): Promise<ToolResult> {
        return {
          output: JSON.stringify(
            store.listTasks(runId).map((task) => ({
              dependencyIds: task.dependencyIds,
              id: task.id,
              ownerAgentId: task.ownerAgentId ?? null,
              status: task.status,
              title: task.title,
            })),
          ),
        };
      },
    }),
  );

  registry.register(
    controlPlaneTool({
      description:
        "Finish a task this agent owns, optionally recording evidence against a requirement.",
      name: "complete_task",
      async execute(input): Promise<ToolResult> {
        const taskId = requiredString(input, "taskId") as TaskId;
        const task = ownedTask(store, agent, taskId);
        const summary = requiredString(input, "summary");
        for (const entry of objectArray(
          { evidence: input.evidence ?? [] },
          "evidence",
        )) {
          store.addEvidence({
            kind: oneOf(
              requiredString(entry, "kind"),
              EVIDENCE_KINDS,
              "evidence.kind",
            ),
            lease,
            requirementId: requiredString(entry, "requirementId"),
            runId,
            strength: oneOf(
              requiredString(entry, "strength"),
              EVIDENCE_STRENGTHS,
              "evidence.strength",
            ),
            summary: requiredString(entry, "summary"),
            taskId: task.id,
          });
        }
        const completed = store.transitionTask({
          lease,
          result: { summary },
          taskId: task.id,
          to: "completed",
        });
        return {
          output: JSON.stringify({
            readyTasks: store
              .listTasks(runId, { status: ["ready"] })
              .map((candidate) => candidate.id),
            status: completed.status,
            taskId: completed.id,
          }),
        };
      },
    }),
  );

  registry.register(
    controlPlaneTool({
      description:
        "Report that a task this agent owns could not be finished. The task becomes retryable rather than terminal.",
      name: "fail_task",
      async execute(input): Promise<ToolResult> {
        const taskId = requiredString(input, "taskId") as TaskId;
        const task = ownedTask(store, agent, taskId);
        const failed = store.transitionTask({
          error: requiredString(input, "error"),
          lease,
          taskId: task.id,
          to: "failed",
        });
        return {
          output: JSON.stringify({ status: failed.status, taskId: failed.id }),
        };
      },
    }),
  );

  registry.register(
    controlPlaneTool({
      description:
        "Delegate a task to a new durable sub-agent with a specific role. The sub-agent survives a daemon restart and reports back through the mailbox.",
      name: "delegate_task",
      async execute(input): Promise<ToolResult> {
        const taskId = requiredString(input, "taskId") as TaskId;
        const task = store.getTask(taskId);
        if (task === undefined || task.runId !== runId) {
          throw new Error(`Task '${taskId}' does not belong to this Run.`);
        }
        if (task.ownerAgentId !== undefined) {
          throw new Error(
            `Task '${taskId}' is already owned by agent '${task.ownerAgentId}'.`,
          );
        }
        const role = oneOf(requiredString(input, "role"), AGENT_ROLES, "role");
        const child = store.spawnAgent({
          lease,
          parentAgentId: agent.id,
          // A delegate never gains capability its parent does not hold.
          permissions: agent.permissions,
          role,
          runId,
          sandbox: agent.sandbox,
          taskId: task.id,
        });
        store.transitionAgent({ agentId: child.id, lease, to: "queued" });
        store.sendAgentMessage({
          body: {
            instructions: requiredString(input, "instructions"),
            taskId: task.id,
            title: task.title,
          },
          fromAgentId: agent.id,
          kind: "task_assignment",
          lease,
          taskId: task.id,
          toAgentId: child.id,
        });
        return {
          output: JSON.stringify({
            agentId: child.id,
            role: child.role,
            taskId: task.id,
          }),
        };
      },
    }),
  );

  registry.register(
    controlPlaneTool({
      description:
        "Send a durable message to another agent in this Run. Messages persist across daemon restarts.",
      name: "message_agent",
      async execute(input): Promise<ToolResult> {
        const toAgentId = requiredString(input, "agentId") as AgentId;
        const body = input.body;
        const message = store.sendAgentMessage({
          body:
            typeof body === "object" && body !== null && !Array.isArray(body)
              ? (body as JsonObject)
              : { text: requiredString(input, "text") },
          fromAgentId: agent.id,
          kind: oneOf(
            optionalString(input, "kind") ?? "status",
            [
              "answer",
              "question",
              "review_request",
              "review_result",
              "status",
              "task_assignment",
              "task_result",
            ] as const,
            "kind",
          ),
          lease,
          toAgentId,
        });
        return { output: JSON.stringify({ messageId: message.id }) };
      },
    }),
  );

  registry.register(
    controlPlaneTool({
      description:
        "Declare a durable requirement this Run must prove before it may complete.",
      name: "add_requirement",
      async execute(input): Promise<ToolResult> {
        const requirement = store.addRequirement({
          lease,
          required: input.required !== false,
          runId,
          title: requiredString(input, "title"),
          ...(optionalString(input, "id") === undefined
            ? {}
            : { id: requiredString(input, "id") }),
        });
        return {
          output: JSON.stringify({
            id: requirement.id,
            status: requirement.status,
          }),
        };
      },
    }),
  );

  registry.register(
    controlPlaneTool({
      description:
        "Record evidence against a requirement. Only `strong` evidence can prove a requirement.",
      name: "record_evidence",
      async execute(input): Promise<ToolResult> {
        const evidenceId = store.addEvidence({
          kind: oneOf(requiredString(input, "kind"), EVIDENCE_KINDS, "kind"),
          lease,
          requirementId: requiredString(input, "requirementId"),
          runId,
          strength: oneOf(
            requiredString(input, "strength"),
            EVIDENCE_STRENGTHS,
            "strength",
          ),
          summary: requiredString(input, "summary"),
          ...(agent.taskId === undefined ? {} : { taskId: agent.taskId }),
        });
        return { output: JSON.stringify({ evidenceId }) };
      },
    }),
  );

  registry.register(
    controlPlaneTool({
      description:
        "Record a validation result, such as a test run. A failing validation blocks completion.",
      name: "record_validation",
      async execute(input): Promise<ToolResult> {
        const passed = input.passed === true;
        const name = requiredString(input, "name");
        const validationId = store.recordValidation({
          independent: input.independent === true,
          lease,
          name,
          passed,
          runId,
          summary: requiredString(input, "summary"),
        });
        // Echoing the name keeps the result self-describing, so a later turn
        // can tell which validation it already recorded.
        return { output: JSON.stringify({ id: validationId, name, passed }) };
      },
    }),
  );

  registry.register(
    controlPlaneTool({
      description:
        "Mark a requirement as proven. This is rejected unless strong evidence already exists.",
      name: "prove_requirement",
      async execute(input): Promise<ToolResult> {
        const requirementId = requiredString(input, "requirementId");
        store.setRequirementStatus(runId, requirementId, "proven", lease);
        return {
          output: JSON.stringify({
            requirementId,
            status: store
              .listRequirements(runId)
              .find((candidate) => candidate.id === requirementId)?.status,
          }),
        };
      },
    }),
  );

  return registry;
}

function ownedTask(
  store: RunStore,
  agent: Agent,
  taskId: TaskId,
): { readonly id: TaskId; readonly title: string } {
  const task = store.getTask(taskId);
  if (task === undefined) throw new Error(`Task '${taskId}' was not found.`);
  if (task.ownerAgentId !== agent.id) {
    throw new Error(
      `Agent '${agent.id}' does not own task '${taskId}'; it is owned by '${task.ownerAgentId ?? "nobody"}'.`,
    );
  }
  return { id: task.id, title: task.title };
}
