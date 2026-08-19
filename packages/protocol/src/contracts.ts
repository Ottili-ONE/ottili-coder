import type {
  AgentId,
  ApprovalId,
  ArtifactId,
  CheckpointId,
  ContextSnapshotId,
  CostRecordId,
  DecisionId,
  EntityId,
  EvidenceId,
  GitChangeId,
  GoalId,
  MemoryEntryId,
  MilestoneId,
  MissionId,
  ProblemId,
  RecoveryStateId,
  RequirementId,
  RunEventId,
  RunId,
  RunLeaseId,
  SessionEpochId,
  TaskId,
  ValidationId,
} from "./ids.js";
import type {
  ArtifactReference,
  BudgetUsage,
  JsonObject,
  JsonValue,
  PermissionPolicy,
  ResourceScope,
  RunBudget,
  SandboxPolicy,
  ToolCall,
} from "./policy.js";

export const PROTOCOL_VERSION = "v1" as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;
export type IsoTimestamp = string;

export const RUN_STATUSES = [
  "queued",
  "running",
  "waiting_external",
  "paused",
  "recovering",
  "blocked",
  "budget_limited",
  "usage_limited",
  "failed",
  "completed",
  "cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export type RunTerminalStatus = Extract<
  RunStatus,
  "failed" | "completed" | "cancelled"
>;

export const GOAL_STATUSES = [
  "active",
  "paused",
  "blocked",
  "waiting_external",
  "budget_limited",
  "usage_limited",
  "complete",
  "cancelled",
] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export type GoalTerminalStatus = Extract<GoalStatus, "complete" | "cancelled">;

export const TASK_STATUSES = [
  "pending",
  "ready",
  "running",
  "waiting",
  "blocked",
  "completed",
  "failed",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskTerminalStatus = Extract<TaskStatus, "completed" | "cancelled">;

export const AGENT_STATUSES = [
  "created",
  "queued",
  "running",
  "waiting",
  "suspended",
  "recovering",
  "completed",
  "failed",
  "stopped",
  "closed",
] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];
/** Completed, failed, and stopped agents retain a durable close/recovery edge. */
export type AgentTerminalStatus = Extract<AgentStatus, "closed">;

export const AGENT_ROLES = [
  "coordinator",
  "researcher",
  "implementer",
  "debugger",
  "reviewer",
  "verifier",
  "specialist",
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export interface Timestamps {
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface Mission extends Timestamps {
  readonly id: MissionId;
  readonly title: string;
  readonly prompt: string;
  readonly workspaceUri: string;
  readonly metadata?: JsonObject;
}

export interface Run extends Timestamps {
  readonly id: RunId;
  readonly missionId: MissionId;
  readonly status: RunStatus;
  readonly title: string;
  readonly budget: RunBudget;
  readonly usage: BudgetUsage;
  readonly currentGoalId?: GoalId;
  readonly startedAt?: IsoTimestamp;
  readonly completedAt?: IsoTimestamp;
  readonly blockedReason?: string;
  readonly revision: number;
}

export interface Goal extends Timestamps {
  readonly id: GoalId;
  readonly runId: RunId;
  readonly parentGoalId?: GoalId;
  readonly title: string;
  readonly description: string;
  readonly status: GoalStatus;
  readonly continuationCount: number;
  readonly blockerFingerprint?: string;
  readonly completedAt?: IsoTimestamp;
}

export interface Task extends Timestamps {
  readonly id: TaskId;
  readonly runId: RunId;
  readonly goalId?: GoalId;
  readonly title: string;
  readonly description: string;
  readonly status: TaskStatus;
  readonly dependencyIds: readonly TaskId[];
  readonly blockerIds: readonly ProblemId[];
  readonly ownerAgentId?: AgentId;
  readonly requirementIds: readonly RequirementId[];
  readonly resourceScopes: readonly ResourceScope[];
  readonly result?: JsonValue;
  readonly evidenceIds: readonly EvidenceId[];
  /** Increments whenever the task fails or is reclaimed after a takeover. */
  readonly attempt: number;
  readonly lastError?: string;
  readonly completedAt?: IsoTimestamp;
}

export interface AgentRoleProfile {
  readonly role: AgentRole;
  readonly permissions: PermissionPolicy;
  readonly allowWrite: boolean;
  readonly allowDeploy: boolean;
  readonly independentContext: boolean;
}

export interface Agent extends Timestamps {
  readonly id: AgentId;
  readonly runId: RunId;
  readonly parentAgentId?: AgentId;
  readonly taskId?: TaskId;
  readonly role: AgentRole;
  readonly status: AgentStatus;
  readonly sessionEpochIds: readonly SessionEpochId[];
  readonly worktreeUri?: string;
  readonly permissions: PermissionPolicy;
  readonly sandbox: SandboxPolicy;
  readonly spawnedAt: IsoTimestamp;
  readonly closedAt?: IsoTimestamp;
}

export interface SessionEpoch extends Timestamps {
  readonly id: SessionEpochId;
  readonly agentId: AgentId;
  readonly ordinal: number;
  readonly provider: string;
  readonly model: string;
  readonly startedAt: IsoTimestamp;
  readonly endedAt?: IsoTimestamp;
  readonly handoffContextSnapshotId?: ContextSnapshotId;
  readonly endReason?:
    | "completed"
    | "compacted"
    | "context_overflow"
    | "provider_changed"
    | "aborted"
    | "failed";
}

export interface Milestone extends Timestamps {
  readonly id: MilestoneId;
  readonly runId: RunId;
  readonly title: string;
  readonly status: "pending" | "active" | "completed" | "cancelled";
  readonly taskIds: readonly TaskId[];
}

export interface Checkpoint extends Timestamps {
  readonly id: CheckpointId;
  readonly runId: RunId;
  readonly sequence: number;
  readonly label: string;
  readonly reason: string;
  readonly workspaceRevision?: string;
  readonly contextSnapshotId?: ContextSnapshotId;
  readonly artifactIds: readonly ArtifactId[];
}

export interface Requirement extends Timestamps {
  readonly id: RequirementId;
  readonly runId: RunId;
  readonly text: string;
  readonly status: "open" | "in_progress" | "satisfied" | "waived" | "failed";
  readonly evidenceIds: readonly EvidenceId[];
}

export interface Evidence extends Timestamps {
  readonly id: EvidenceId;
  readonly runId: RunId;
  readonly kind:
    "test" | "inspection" | "artifact" | "command" | "review" | "external";
  readonly summary: string;
  readonly artifacts: readonly ArtifactReference[];
  readonly taskId?: TaskId;
  readonly requirementId?: RequirementId;
}

export interface Decision extends Timestamps {
  readonly id: DecisionId;
  readonly runId: RunId;
  readonly title: string;
  readonly rationale: string;
  readonly alternatives: readonly string[];
  readonly evidenceIds: readonly EvidenceId[];
}

export interface Problem extends Timestamps {
  readonly id: ProblemId;
  readonly runId: RunId;
  readonly fingerprint: string;
  readonly summary: string;
  readonly externalDependency: boolean;
  readonly alternateActionAvailable: boolean;
  readonly meaningfulAttempts: number;
  readonly status: "open" | "waiting" | "resolved" | "blocked";
}

export interface Validation extends Timestamps {
  readonly id: ValidationId;
  readonly runId: RunId;
  readonly taskId?: TaskId;
  readonly name: string;
  readonly status: "pending" | "running" | "passed" | "failed" | "skipped";
  readonly evidenceIds: readonly EvidenceId[];
  readonly summary?: string;
}

export interface Artifact extends Timestamps {
  readonly id: ArtifactId;
  readonly runId: RunId;
  readonly label: string;
  readonly uri: string;
  readonly mediaType?: string;
  readonly sizeBytes?: number;
  readonly checksum?: string;
}

export interface GitChange extends Timestamps {
  readonly id: GitChangeId;
  readonly runId: RunId;
  readonly repositoryUri: string;
  readonly revision: string;
  readonly summary: string;
  readonly taskIds: readonly TaskId[];
}

export interface CostRecord extends Timestamps {
  readonly id: CostRecordId;
  readonly runId: RunId;
  readonly agentId?: AgentId;
  readonly sessionEpochId?: SessionEpochId;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly costUsd: number;
}

export interface RecoveryState extends Timestamps {
  readonly id: RecoveryStateId;
  readonly runId: RunId;
  readonly status:
    "idle" | "required" | "reconciling" | "recovered" | "manual_intervention";
  readonly lastCheckpointId?: CheckpointId;
  readonly unknownToolCallIds: readonly EntityId<"tool-call">[];
  readonly reason?: string;
}

export interface RunLease extends Timestamps {
  readonly id: RunLeaseId;
  readonly runId: RunId;
  readonly executorId: string;
  readonly generation: number;
  readonly expiresAt: IsoTimestamp;
  readonly heartbeatAt: IsoTimestamp;
  readonly host: string;
  readonly process: string;
}

/** The fencing token carried by every executor-owned state-changing write. */
export interface RunLeaseFence {
  readonly runId: RunId;
  readonly executorId: string;
  readonly generation: number;
}

export type RunEventType =
  | "run.created"
  | "run.status_changed"
  | "goal.status_changed"
  | "task.status_changed"
  | "agent.status_changed"
  | "agent.turn_started"
  | "agent.worktree_assigned"
  | "agent.message"
  | "agent.progress"
  | "agent.failed"
  | "agent.completed"
  | "agent.message_sent"
  | "agent.message_delivered"
  | "task.assigned"
  | "task.recovered"
  | "provider.failed"
  | "context.compacted"
  | "run.retry_scheduled"
  | "tool.call_started"
  | "tool.call_finished"
  | "checkpoint.created"
  | "checkpoint.restored"
  | "approval.requested"
  | "approval.resolved"
  | "recovery.required"
  | "validation.finished"
  | "steering.received";

export interface RunEvent extends Timestamps {
  readonly id: RunEventId;
  readonly runId: RunId;
  readonly sequence: number;
  readonly type: RunEventType;
  readonly actorAgentId?: AgentId;
  readonly taskId?: TaskId;
  readonly sessionEpochId?: SessionEpochId;
  readonly correlationId?: string;
  readonly leaseGeneration?: number;
  readonly payload: JsonObject;
}

export interface ContextSnapshot extends Timestamps {
  readonly id: ContextSnapshotId;
  readonly runId: RunId;
  readonly agentId?: AgentId;
  readonly sessionEpochId?: SessionEpochId;
  readonly summary: string;
  readonly tokenCount: number;
  readonly checkpointId?: CheckpointId;
}

export interface MemoryEntry extends Timestamps {
  readonly id: MemoryEntryId;
  readonly runId: RunId;
  readonly scope: "run" | "project" | "agent";
  readonly content: string;
  readonly confidence: number;
  readonly agentId?: AgentId;
  readonly sourceEvidenceIds: readonly EvidenceId[];
}

export interface Approval extends Timestamps {
  readonly id: ApprovalId;
  readonly runId: RunId;
  readonly agentId?: AgentId;
  readonly toolCallId?: EntityId<"tool-call">;
  /** `consumed` means an approved decision authorized exactly one tool call. */
  readonly status: "pending" | "approved" | "consumed" | "rejected" | "expired";
  readonly summary: string;
  readonly requestedAt: IsoTimestamp;
  readonly resolvedAt?: IsoTimestamp;
  readonly resolverId?: string;
}

export type RunWakeCondition =
  | {
      readonly kind: "timer";
      readonly wakeAt: IsoTimestamp;
    }
  | {
      readonly kind: "event";
      readonly eventType: string;
      readonly correlationId?: string;
    }
  | {
      readonly kind: "external_state";
      readonly resource: string;
      readonly expectedState: string;
    }
  | {
      readonly kind: "manual";
      readonly reason?: string;
    }
  | {
      readonly kind: "webhook";
      readonly webhookKey: string;
    };

export interface BlockerObservation {
  readonly fingerprint: string;
  readonly occurredAt: IsoTimestamp;
  readonly meaningful: boolean;
  readonly externalDependency: boolean;
  readonly alternateActionAvailable: boolean;
  readonly note?: string;
}

export interface DaemonError {
  readonly code:
    | "invalid_request"
    | "not_found"
    | "conflict"
    | "permission_denied"
    | "budget_exceeded"
    | "lease_conflict"
    | "unsupported"
    | "internal";
  readonly message: string;
  readonly details?: JsonObject;
  readonly retryable: boolean;
}

export type ApiResult<Value> =
  | {
      readonly ok: true;
      readonly value: Value;
    }
  | {
      readonly ok: false;
      readonly error: DaemonError;
    };

export interface HealthResponse {
  /** Stable only for one daemon lifetime; protects descriptor PID actions. */
  readonly instanceId?: string;
  readonly status: "ok";
  readonly version: ProtocolVersion;
}

export interface ReadyResponse {
  readonly ready: boolean;
  readonly reason?: string;
}

export interface VersionResponse {
  readonly protocolVersion: ProtocolVersion;
  readonly serverVersion: string;
}

/**
 * Cooperative shutdown request. `instanceId` binds the request to one daemon
 * lifetime so a stale client cannot stop a replacement daemon that reused the
 * same endpoint or process id.
 */
export interface ShutdownDaemonRequest {
  readonly instanceId: string;
  readonly reason?: string;
}

export interface ShutdownDaemonResponse {
  readonly accepted: true;
  readonly instanceId: string;
}

export interface CreateRunRequest {
  readonly mission: {
    readonly title: string;
    readonly prompt: string;
    readonly workspaceUri: string;
  };
  readonly budget?: RunBudget;
  readonly permissions?: PermissionPolicy;
  readonly sandbox?: SandboxPolicy;
  readonly initialGoal?: {
    readonly title: string;
    readonly description: string;
  };
}

export interface CreateRunResponse {
  readonly mission: Mission;
  readonly run: Run;
  readonly goal?: Goal;
}

export interface ListRunsRequest {
  readonly status?: RunStatus;
  readonly limit?: number;
  readonly after?: RunId;
}

export interface ListRunsResponse {
  readonly runs: readonly Run[];
  readonly nextAfter?: RunId;
}

export interface RunCommandRequest {
  readonly command: "pause" | "resume" | "cancel";
  readonly reason?: string;
}

export interface SteeringInputRequest {
  readonly text: string;
  readonly targetGoalId?: GoalId;
  readonly targetAgentId?: AgentId;
}

export interface AgentEventListResponse {
  readonly events: readonly RunEvent[];
  readonly nextSequence: number;
}

export interface CheckpointListResponse {
  readonly checkpoints: readonly Checkpoint[];
}

export interface RestoreCheckpointResponse {
  readonly checkpointId: CheckpointId;
  readonly restoredRef: string;
  /** A private ref captured just before restoring, so the restore itself is undoable. */
  readonly preRestoreRef: string;
  readonly restoredAt: IsoTimestamp;
}

export interface ApprovalListResponse {
  readonly approvals: readonly Approval[];
}

/** A human or policy service resolves a previously durable approval request. */
export interface ResolveApprovalRequest {
  readonly resolverId: string;
  readonly status: "approved" | "rejected";
}

export interface ResolveApprovalResponse {
  readonly approval: Approval;
}

/** An SSE frame carries the durable event sequence needed for reconnect. */
export interface SseEvent {
  readonly id: string;
  readonly event: RunEventType;
  readonly data: RunEvent;
}

export interface ProtocolRoutes {
  readonly health: "/v1/health";
  readonly ready: "/v1/ready";
  readonly version: "/v1/version";
  readonly runs: "/v1/runs";
  readonly run: "/v1/runs/:runId";
  readonly runCommand: "/v1/runs/:runId/commands";
  readonly steering: "/v1/runs/:runId/steering";
  readonly agents: "/v1/runs/:runId/agents";
  readonly agentEvents: "/v1/runs/:runId/agents/:agentId/events";
  readonly checkpoints: "/v1/runs/:runId/checkpoints";
  readonly approvals: "/v1/runs/:runId/approvals";
  readonly approval: "/v1/runs/:runId/approvals/:approvalId";
  readonly events: "/v1/runs/:runId/events";
}

export const PROTOCOL_ROUTES: ProtocolRoutes = {
  health: "/v1/health",
  ready: "/v1/ready",
  version: "/v1/version",
  runs: "/v1/runs",
  run: "/v1/runs/:runId",
  runCommand: "/v1/runs/:runId/commands",
  steering: "/v1/runs/:runId/steering",
  agents: "/v1/runs/:runId/agents",
  agentEvents: "/v1/runs/:runId/agents/:agentId/events",
  checkpoints: "/v1/runs/:runId/checkpoints",
  approvals: "/v1/runs/:runId/approvals",
  approval: "/v1/runs/:runId/approvals/:approvalId",
  events: "/v1/runs/:runId/events",
};

/** Structural relation used by the agent graph persistence layer. */
export interface AgentSpawnEdge extends Timestamps {
  readonly parentAgentId: AgentId;
  readonly childAgentId: AgentId;
  readonly runId: RunId;
  readonly taskId?: TaskId;
}

export interface ToolCallEventPayload {
  readonly toolCall: ToolCall;
}
