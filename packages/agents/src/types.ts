import type {
  Agent,
  AgentId,
  AgentRole,
  AgentRoleProfile,
  AgentSpawnEdge,
  IsoTimestamp,
  JsonValue,
  RunId,
  SessionEpochId,
  TaskId,
} from "@ottili/protocol";

/**
 * A spawn edge is retained after a child stops so the historical topology can
 * be reconstructed.  Closing an edge removes it from active scheduling while
 * retaining it for audit and descendant inspection.
 */
export type AgentSpawnEdgeState = "open" | "closed";

export interface AgentGraphEdge extends AgentSpawnEdge {
  /** Stable, derivable identity: it is not a process-local edge number. */
  readonly key: string;
  readonly state: AgentSpawnEdgeState;
  readonly closedAt?: IsoTimestamp;
  readonly closeReason?: string;
}

/** A serialisable graph can be written to any durable store without adapters. */
export interface AgentGraphSnapshot {
  readonly runId: RunId;
  readonly agents: readonly Agent[];
  readonly edges: readonly AgentGraphEdge[];
}

export interface AgentPathSegment {
  readonly agentId: AgentId;
  readonly taskId?: TaskId;
}

/**
 * A topology-derived path.  It uses durable IDs rather than array positions,
 * so inserting a sibling never changes another agent's path.
 */
export interface AgentTaskPath {
  readonly agentIds: readonly AgentId[];
  readonly taskIds: readonly TaskId[];
  readonly segments: readonly AgentPathSegment[];
  readonly key: string;
}

export const AGENT_MESSAGE_KINDS = [
  "input",
  "steering",
  "handoff",
  "control",
  "system",
] as const;
export type AgentMessageKind = (typeof AGENT_MESSAGE_KINDS)[number];

export const AGENT_MESSAGE_STATUSES = [
  "queued",
  "delivered",
  "acknowledged",
  "cancelled",
] as const;
export type AgentMessageStatus = (typeof AGENT_MESSAGE_STATUSES)[number];

/**
 * Mailbox entries are immutable messages with a monotonic sequence per Run.
 * Delivery is explicit so a daemon can requeue an interrupted delivery after
 * recovering a lease.
 */
export interface AgentMailboxMessage {
  readonly id: string;
  readonly runId: RunId;
  readonly sequence: number;
  readonly recipientAgentId: AgentId;
  readonly senderAgentId?: AgentId;
  readonly kind: AgentMessageKind;
  readonly payload: JsonValue;
  readonly idempotencyKey?: string;
  readonly status: AgentMessageStatus;
  readonly deliveryAttempts: number;
  readonly deliveryId?: string;
  readonly deliveredAt?: IsoTimestamp;
  readonly acknowledgedAt?: IsoTimestamp;
  readonly cancelledAt?: IsoTimestamp;
  readonly cancellationReason?: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface AgentMailboxSnapshot {
  readonly runId: RunId;
  readonly nextSequence: number;
  readonly messages: readonly AgentMailboxMessage[];
}

/** The complete durable-agnostic state needed to restore agent coordination. */
export interface AgentRuntimeSnapshot {
  readonly graph: AgentGraphSnapshot;
  readonly mailbox: AgentMailboxSnapshot;
}

export interface SpawnAgentInput {
  readonly agent: Agent;
  readonly parentAgentId: AgentId;
  readonly taskId?: TaskId;
  readonly openedAt?: IsoTimestamp;
}

export interface EnqueueAgentMessageInput {
  readonly recipientAgentId: AgentId;
  readonly kind: AgentMessageKind;
  readonly payload: JsonValue;
  readonly createdAt: IsoTimestamp;
  readonly senderAgentId?: AgentId;
  /** Retry-safe caller key, unique for this recipient within the Run. */
  readonly idempotencyKey?: string;
  /** Optional externally persisted message identity. */
  readonly messageId?: string;
}

export interface ClaimAgentMessagesInput {
  readonly recipientAgentId: AgentId;
  readonly deliveredAt: IsoTimestamp;
  readonly deliveryId?: string;
  readonly limit?: number;
}

export interface AgentResumeOptions {
  readonly statuses?: readonly Agent["status"][];
  readonly limit?: number;
  /** Include branches whose historical spawn edge was deliberately closed. */
  readonly includeClosedEdges?: boolean;
}

export type AgentWaitState = "queued" | "running" | "waiting" | "finished";

export interface AgentWaitView {
  readonly agent: Agent;
  readonly state: AgentWaitState;
  readonly queuedMessageCount: number;
  readonly openChildCount: number;
}

export interface AgentCapacityAssessment {
  readonly maximumResidentAgents: number;
  readonly residentAgentIds: readonly AgentId[];
  readonly queuedAgentIds: readonly AgentId[];
  readonly availableSlots: number;
  readonly overCapacity: boolean;
}

export interface AgentResidency {
  readonly agentId: AgentId;
  readonly sessionEpochId?: SessionEpochId;
  readonly executorId: string;
  readonly observedAt: IsoTimestamp;
}

export type AgentRoleProfiles = Readonly<Record<AgentRole, AgentRoleProfile>>;
