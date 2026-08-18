/**
 * Stable, serialisable identifiers used on every durable protocol boundary.
 *
 * IDs are intentionally derived from caller-supplied stable material rather
 * than process-local counters.  This makes retries and imported event logs
 * deterministic while retaining a readable entity prefix.
 */

declare const entityIdBrand: unique symbol;

export const ENTITY_KINDS = [
  "mission",
  "run",
  "goal",
  "task",
  "agent",
  "session-epoch",
  "milestone",
  "checkpoint",
  "requirement",
  "evidence",
  "decision",
  "problem",
  "validation",
  "artifact",
  "tool-call",
  "git-change",
  "cost-record",
  "recovery-state",
  "lease",
  "event",
  "context-snapshot",
  "memory-entry",
  "approval",
  "agent-message",
] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];

export type EntityId<Kind extends EntityKind = EntityKind> = string & {
  readonly [entityIdBrand]: Kind;
};

export type MissionId = EntityId<"mission">;
export type RunId = EntityId<"run">;
export type GoalId = EntityId<"goal">;
export type TaskId = EntityId<"task">;
export type AgentId = EntityId<"agent">;
export type SessionEpochId = EntityId<"session-epoch">;
export type MilestoneId = EntityId<"milestone">;
export type CheckpointId = EntityId<"checkpoint">;
export type RequirementId = EntityId<"requirement">;
export type EvidenceId = EntityId<"evidence">;
export type DecisionId = EntityId<"decision">;
export type ProblemId = EntityId<"problem">;
export type ValidationId = EntityId<"validation">;
export type ArtifactId = EntityId<"artifact">;
export type ToolCallId = EntityId<"tool-call">;
export type GitChangeId = EntityId<"git-change">;
export type CostRecordId = EntityId<"cost-record">;
export type RecoveryStateId = EntityId<"recovery-state">;
export type AgentMessageId = EntityId<"agent-message">;
export type RunLeaseId = EntityId<"lease">;
export type RunEventId = EntityId<"event">;
export type ContextSnapshotId = EntityId<"context-snapshot">;
export type MemoryEntryId = EntityId<"memory-entry">;
export type ApprovalId = EntityId<"approval">;

const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;
const HASH_WIDTH = 13;

/**
 * A deterministic 64-bit FNV-1a hash. It is not a security primitive; use it
 * only for reproducible identifiers and fingerprints.
 */
export function deterministicHash(value: string): string {
  let hash = FNV64_OFFSET;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * FNV64_PRIME) & UINT64_MASK;
  }

  return hash.toString(36).padStart(HASH_WIDTH, "0");
}

/** Creates a stable entity ID from a stable seed. */
export function createDeterministicId<Kind extends EntityKind>(
  kind: Kind,
  seed: string,
): EntityId<Kind> {
  if (!ENTITY_KINDS.includes(kind)) {
    throw new TypeError(`Unknown entity kind: ${kind}`);
  }

  if (seed.length === 0) {
    throw new TypeError("A deterministic ID seed must not be empty");
  }

  return `${kind}_${deterministicHash(`${kind}:${seed}`)}` as EntityId<Kind>;
}

/** Concise alias for callers that already supply a stable seed. */
export const createId = createDeterministicId;

export function isEntityId<Kind extends EntityKind>(
  kind: Kind,
  value: unknown,
): value is EntityId<Kind> {
  if (typeof value !== "string") {
    return false;
  }

  const pattern = new RegExp(`^${escapeRegExp(kind)}_[0-9a-z]{${HASH_WIDTH}}$`);
  return pattern.test(value);
}

/**
 * Parses an externally supplied ID without manufacturing a value that looks
 * valid. Callers should use this at HTTP/database boundaries.
 */
export function parseEntityId<Kind extends EntityKind>(
  kind: Kind,
  value: unknown,
): EntityId<Kind> | undefined {
  return isEntityId(kind, value) ? value : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
