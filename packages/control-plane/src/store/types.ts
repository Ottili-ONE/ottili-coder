import type {
  AgentId,
  AgentMessageId,
  AgentRole,
  ApprovalId,
  CheckpointId,
  GoalId,
  JsonObject,
  JsonValue,
  PermissionPolicy,
  ResourceScope,
  RunBudget,
  RunId,
  RunLease,
  SandboxPolicy,
  TaskId,
  TaskStatus,
  ToolDefinition,
  ToolIdempotency,
  ToolRecoveryStrategy,
  ToolSideEffectClass,
} from "@ottili/core";

export interface Clock {
  now(): Date;
}

/** The subset of a lease that fences a durable write. */
export type FencedLease = Pick<RunLease, "generation" | "executorId" | "runId">;

export interface CreateRunInput {
  readonly budget?: RunBudget;
  readonly initialGoal?: {
    readonly description: string;
    readonly title: string;
  };
  readonly permissions?: PermissionPolicy;
  readonly prompt: string;
  /** The coordinator's starting sandbox. Delegates inherit and may narrow it. */
  readonly sandbox?: SandboxPolicy;
  readonly requirements?: readonly {
    readonly id?: string;
    readonly title: string;
    readonly required?: boolean;
  }[];
  readonly title?: string;
  readonly workspaceUri: string;
}

export interface RequirementRecord {
  readonly evidence: readonly {
    readonly id: string;
    readonly kind: "artifact" | "command" | "inspection" | "review" | "test";
    readonly strength: "strong" | "supporting" | "weak";
    readonly summary: string;
  }[];
  readonly id: string;
  readonly required: boolean;
  readonly status: "contradicted" | "proven" | "unproven" | "waived";
  readonly title: string;
}

export interface CheckpointRecord {
  readonly id: CheckpointId;
  readonly label: string;
  readonly manifest: JsonObject;
  readonly reason: string;
  readonly runId: RunId;
  readonly sequence: number;
  readonly workspaceRef?: string;
  readonly createdAt: string;
}

export interface ValidationRecord {
  readonly createdAt: string;
  readonly id: string;
  readonly independent: boolean;
  readonly name: string;
  readonly passed: boolean;
  readonly runId: RunId;
  readonly summary: string;
}

export type DurableRunCommand = "cancel" | "pause" | "resume";

export interface ScheduledAction {
  readonly actionType: "continue_goal";
  readonly attempt: number;
  readonly runId: RunId;
}

export interface SpawnAgentInput {
  readonly lease?: FencedLease;
  readonly parentAgentId?: AgentId;
  readonly permissions?: PermissionPolicy;
  readonly role: AgentRole;
  readonly runId: RunId;
  readonly sandbox?: SandboxPolicy;
  readonly taskId?: TaskId;
  readonly worktreeUri?: string;
}

export interface CreateTaskInput {
  readonly dependencies?: readonly TaskId[];
  readonly description: string;
  readonly goalId?: GoalId;
  /** Required for executor-owned writes; omitted only by control-plane tools. */
  readonly lease?: FencedLease;
  readonly requirementIds?: readonly string[];
  readonly resourceScopes?: readonly ResourceScope[];
  readonly runId: RunId;
  readonly title: string;
}

export interface TransitionTaskInput {
  readonly error?: string;
  readonly lease?: FencedLease;
  readonly result?: JsonValue;
  readonly taskId: TaskId;
  readonly to: TaskStatus;
}

export interface ClaimTaskInput {
  readonly agentId: AgentId;
  readonly lease: FencedLease;
  readonly taskId: TaskId;
}

export interface ListTasksOptions {
  readonly ownerAgentId?: AgentId;
  readonly status?: readonly TaskStatus[];
}

export type AgentMessageKind =
  | "task_assignment"
  | "task_result"
  | "question"
  | "answer"
  | "review_request"
  | "review_result"
  | "status";

export interface AgentMessage {
  readonly id: AgentMessageId;
  readonly runId: RunId;
  readonly fromAgentId?: AgentId;
  readonly toAgentId: AgentId;
  readonly taskId?: TaskId;
  readonly kind: AgentMessageKind;
  readonly body: JsonObject;
  readonly status: "delivered" | "pending";
  readonly createdAt: string;
  readonly deliveredAt?: string;
}

export interface SendAgentMessageInput {
  readonly body: JsonObject;
  readonly fromAgentId?: AgentId;
  readonly kind: AgentMessageKind;
  readonly lease: FencedLease;
  readonly taskId?: TaskId;
  readonly toAgentId: AgentId;
}

export interface RecoveredGraphWork {
  readonly agentIds: readonly AgentId[];
  readonly taskIds: readonly TaskId[];
}

export interface ToolIntentInput {
  readonly agentId?: AgentId;
  /** A one-shot, already approved policy authorization for this intent. */
  readonly approvalId?: ApprovalId;
  readonly definition: Pick<
    ToolDefinition,
    "idempotency" | "name" | "recovery" | "sideEffectClass"
  >;
  readonly input: JsonValue;
  readonly lease: Pick<RunLease, "generation" | "executorId" | "runId">;
  readonly taskId?: TaskId;
}

export interface UnknownToolCall {
  readonly id: string;
  readonly name: string;
  readonly runId: RunId;
  readonly recovery: ToolRecoveryStrategy;
  readonly sideEffectClass: ToolSideEffectClass;
  readonly idempotency: ToolIdempotency;
}

export interface RecordProblemInput {
  readonly alternateActionAvailable: boolean;
  readonly lease?: FencedLease;
  readonly externalDependency: boolean;
  readonly fingerprint: string;
  readonly meaningful?: boolean;
  readonly note?: string;
  readonly runId: RunId;
  readonly summary: string;
  readonly taskId?: TaskId;
}

export interface RequestApprovalInput {
  readonly agentId?: AgentId;
  readonly lease?: Pick<RunLease, "generation" | "executorId" | "runId">;
  readonly runId: RunId;
  readonly summary: string;
  readonly toolCallId?: string;
}
