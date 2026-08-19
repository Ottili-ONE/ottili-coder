import {
  isAgentStatus,
  isGoalStatus,
  isRunStatus,
  isTaskStatus,
  type Agent,
  type AgentId,
  type AgentMessageId,
  type Approval,
  type ApprovalId,
  type Artifact,
  type ArtifactId,
  type CheckpointId,
  type ContextSnapshot,
  type ContextSnapshotId,
  type CostRecord,
  type CostRecordId,
  type Decision,
  type DecisionId,
  type Goal,
  type GoalId,
  type GitChange,
  type GitChangeId,
  type JsonObject,
  type JsonValue,
  type MemoryEntry,
  type MemoryEntryId,
  type Milestone,
  type MilestoneId,
  type MissionId,
  type Mission,
  type PermissionPolicy,
  type Problem,
  type ProblemId,
  type RecoveryState,
  type RecoveryStateId,
  type Run,
  type RunBudget,
  type RunEvent,
  type RunEventType,
  type RunId,
  type SandboxPolicy,
  type SessionEpoch,
  type Task,
  type TaskId,
} from "@ottili/core";

import type { SqliteDatabase, SqlRow } from "../database.js";
import type { AgentMessage } from "./types.js";
import {
  asNumber,
  asOneOf,
  asString,
  optionalNumber,
  optionalString,
  parseJson,
} from "./row-helpers.js";

/**
 * Maps a raw SQLite row to its typed durable entity.
 *
 * These are free functions of `(database, row)` rather than `RunStore`
 * methods — every one of them only ever needed the database handle, never any
 * other state on the store — so they carry no transactional or fencing
 * behavior of their own and are safe to read in isolation from the rest of
 * the control plane.
 */

export function agentMessageFromRow(
  _database: SqliteDatabase,
  row: SqlRow,
): AgentMessage {
  const fromAgentId = optionalString(row, "from_agent_id");
  const taskId = optionalString(row, "task_id");
  const deliveredAt = optionalString(row, "delivered_at");
  return {
    body: parseJson<JsonObject>(asString(row, "body_json")),
    createdAt: asString(row, "created_at"),
    id: asString(row, "id") as AgentMessageId,
    kind: asOneOf(row, "kind", [
      "answer",
      "question",
      "review_request",
      "review_result",
      "status",
      "task_assignment",
      "task_result",
    ] as const),
    runId: asString(row, "run_id") as RunId,
    status: asOneOf(row, "status", ["delivered", "pending"] as const),
    toAgentId: asString(row, "to_agent_id") as AgentId,
    ...(fromAgentId === undefined
      ? {}
      : { fromAgentId: fromAgentId as AgentId }),
    ...(taskId === undefined ? {} : { taskId: taskId as TaskId }),
    ...(deliveredAt === undefined ? {} : { deliveredAt }),
  };
}

export function milestoneFromRow(
  database: SqliteDatabase,
  row: SqlRow,
): Milestone {
  const id = asString(row, "id") as MilestoneId;
  return {
    createdAt: asString(row, "created_at"),
    id,
    runId: asString(row, "run_id") as RunId,
    status: asOneOf(row, "status", [
      "pending",
      "active",
      "completed",
      "cancelled",
    ] as const),
    taskIds: database
      .all(
        "SELECT task_id FROM milestone_tasks WHERE milestone_id = ? ORDER BY task_id",
        id,
      )
      .map((item) => asString(item, "task_id") as TaskId),
    title: asString(row, "title"),
    updatedAt: asString(row, "updated_at"),
  };
}

export function decisionFromRow(
  _database: SqliteDatabase,
  row: SqlRow,
): Decision {
  return {
    alternatives: parseJson<readonly string[]>(
      asString(row, "alternatives_json"),
    ),
    createdAt: asString(row, "created_at"),
    evidenceIds: parseJson<readonly string[]>(
      asString(row, "evidence_ids_json"),
    ) as Decision["evidenceIds"],
    id: asString(row, "id") as DecisionId,
    rationale: asString(row, "rationale"),
    runId: asString(row, "run_id") as RunId,
    title: asString(row, "title"),
    updatedAt: asString(row, "updated_at"),
  };
}

export function problemFromRow(
  _database: SqliteDatabase,
  row: SqlRow,
): Problem {
  return {
    alternateActionAvailable: asNumber(row, "alternate_action_available") === 1,
    createdAt: asString(row, "created_at"),
    externalDependency: asNumber(row, "external_dependency") === 1,
    fingerprint: asString(row, "fingerprint"),
    id: asString(row, "id") as ProblemId,
    meaningfulAttempts: asNumber(row, "meaningful_attempts"),
    runId: asString(row, "run_id") as RunId,
    status: asOneOf(row, "status", [
      "open",
      "waiting",
      "resolved",
      "blocked",
    ] as const),
    summary: asString(row, "summary"),
    updatedAt: asString(row, "updated_at"),
  };
}

export function artifactFromRow(
  _database: SqliteDatabase,
  row: SqlRow,
): Artifact {
  const mediaType = optionalString(row, "media_type");
  const sizeBytes = optionalNumber(row, "size_bytes");
  const checksum = optionalString(row, "checksum");
  return {
    createdAt: asString(row, "created_at"),
    id: asString(row, "id") as ArtifactId,
    label: asString(row, "label"),
    runId: asString(row, "run_id") as RunId,
    uri: asString(row, "uri"),
    updatedAt: asString(row, "updated_at"),
    ...(mediaType === undefined ? {} : { mediaType }),
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    ...(checksum === undefined ? {} : { checksum }),
  };
}

export function gitChangeFromRow(
  _database: SqliteDatabase,
  row: SqlRow,
): GitChange {
  return {
    createdAt: asString(row, "created_at"),
    id: asString(row, "id") as GitChangeId,
    repositoryUri: asString(row, "repository_uri"),
    revision: asString(row, "revision"),
    runId: asString(row, "run_id") as RunId,
    summary: asString(row, "summary"),
    taskIds: parseJson<readonly string[]>(
      asString(row, "task_ids_json"),
    ) as GitChange["taskIds"],
    updatedAt: asString(row, "updated_at"),
  };
}

export function costRecordFromRow(
  _database: SqliteDatabase,
  row: SqlRow,
): CostRecord {
  const agentId = optionalString(row, "agent_id");
  const sessionEpochId = optionalString(row, "session_epoch_id");
  return {
    cachedTokens: asNumber(row, "cached_tokens"),
    costUsd: asNumber(row, "cost_usd"),
    createdAt: asString(row, "created_at"),
    id: asString(row, "id") as CostRecordId,
    inputTokens: asNumber(row, "input_tokens"),
    outputTokens: asNumber(row, "output_tokens"),
    runId: asString(row, "run_id") as RunId,
    updatedAt: asString(row, "updated_at"),
    ...(agentId === undefined ? {} : { agentId: agentId as AgentId }),
    ...(sessionEpochId === undefined
      ? {}
      : { sessionEpochId: sessionEpochId as SessionEpoch["id"] }),
  };
}

export function recoveryStateFromRow(
  _database: SqliteDatabase,
  row: SqlRow,
): RecoveryState {
  const lastCheckpointId = optionalString(row, "last_checkpoint_id");
  const reason = optionalString(row, "reason");
  return {
    createdAt: asString(row, "created_at"),
    id: asString(row, "id") as RecoveryStateId,
    runId: asString(row, "run_id") as RunId,
    status: asOneOf(row, "status", [
      "idle",
      "required",
      "reconciling",
      "recovered",
      "manual_intervention",
    ] as const),
    unknownToolCallIds: parseJson<readonly string[]>(
      asString(row, "unknown_tool_call_ids_json"),
    ) as RecoveryState["unknownToolCallIds"],
    updatedAt: asString(row, "updated_at"),
    ...(lastCheckpointId === undefined
      ? {}
      : { lastCheckpointId: lastCheckpointId as CheckpointId }),
    ...(reason === undefined ? {} : { reason }),
  };
}

export function contextSnapshotFromRow(
  _database: SqliteDatabase,
  row: SqlRow,
): ContextSnapshot {
  const agentId = optionalString(row, "agent_id");
  const sessionEpochId = optionalString(row, "session_epoch_id");
  const checkpointId = optionalString(row, "checkpoint_id");
  return {
    createdAt: asString(row, "created_at"),
    id: asString(row, "id") as ContextSnapshotId,
    runId: asString(row, "run_id") as RunId,
    summary: asString(row, "summary"),
    tokenCount: asNumber(row, "token_count"),
    updatedAt: asString(row, "updated_at"),
    ...(agentId === undefined ? {} : { agentId: agentId as AgentId }),
    ...(sessionEpochId === undefined
      ? {}
      : { sessionEpochId: sessionEpochId as SessionEpoch["id"] }),
    ...(checkpointId === undefined
      ? {}
      : { checkpointId: checkpointId as CheckpointId }),
  };
}

export function memoryEntryFromRow(
  _database: SqliteDatabase,
  row: SqlRow,
): MemoryEntry {
  const agentId = optionalString(row, "agent_id");
  return {
    confidence: asNumber(row, "confidence"),
    content: asString(row, "content"),
    createdAt: asString(row, "created_at"),
    id: asString(row, "id") as MemoryEntryId,
    runId: asString(row, "run_id") as RunId,
    scope: asOneOf(row, "scope", ["run", "project", "agent"] as const),
    sourceEvidenceIds: parseJson<readonly string[]>(
      asString(row, "source_evidence_ids_json"),
    ) as MemoryEntry["sourceEvidenceIds"],
    updatedAt: asString(row, "updated_at"),
    ...(agentId === undefined ? {} : { agentId: agentId as AgentId }),
  };
}

export function approvalFromRow(
  _database: SqliteDatabase,
  row: SqlRow,
): Approval {
  const agentId = optionalString(row, "agent_id");
  const toolCallId = optionalString(row, "tool_call_id");
  const resolvedAt = optionalString(row, "resolved_at");
  const resolverId = optionalString(row, "resolver_id");
  return {
    createdAt: asString(row, "created_at"),
    id: asString(row, "id") as ApprovalId,
    requestedAt: asString(row, "requested_at"),
    runId: asString(row, "run_id") as RunId,
    status: asOneOf(row, "status", [
      "pending",
      "approved",
      "consumed",
      "rejected",
      "expired",
    ] as const),
    summary: asString(row, "summary"),
    updatedAt: asString(row, "updated_at"),
    ...(agentId === undefined ? {} : { agentId: agentId as AgentId }),
    ...(toolCallId === undefined
      ? {}
      : {
          toolCallId: toolCallId as Exclude<Approval["toolCallId"], undefined>,
        }),
    ...(resolvedAt === undefined ? {} : { resolvedAt }),
    ...(resolverId === undefined ? {} : { resolverId }),
  };
}

export function runFromRow(_database: SqliteDatabase, row: SqlRow): Run {
  const status = asString(row, "status");
  if (!isRunStatus(status))
    throw new Error(`Invalid persisted Run status '${status}'.`);
  const currentGoalId = optionalString(row, "current_goal_id");
  const startedAt = optionalString(row, "started_at");
  const completedAt = optionalString(row, "completed_at");
  const blockedReason = optionalString(row, "blocked_reason");
  return {
    budget: parseJson<RunBudget>(asString(row, "budget_json")),
    createdAt: asString(row, "created_at"),
    id: asString(row, "id") as RunId,
    missionId: asString(row, "mission_id") as MissionId,
    revision: asNumber(row, "revision"),
    status,
    title: asString(row, "title"),
    updatedAt: asString(row, "updated_at"),
    usage: parseJson<Run["usage"]>(asString(row, "usage_json")),
    ...(currentGoalId === undefined
      ? {}
      : { currentGoalId: currentGoalId as GoalId }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(blockedReason === undefined ? {} : { blockedReason }),
  };
}

export function missionFromRow(
  _database: SqliteDatabase,
  row: SqlRow,
): Mission {
  const metadataJson = optionalString(row, "metadata_json");
  return {
    createdAt: asString(row, "created_at"),
    id: asString(row, "id") as MissionId,
    prompt: asString(row, "prompt"),
    title: asString(row, "title"),
    updatedAt: asString(row, "updated_at"),
    workspaceUri: asString(row, "workspace_uri"),
    ...(metadataJson === undefined
      ? {}
      : { metadata: parseJson<JsonObject>(metadataJson) }),
  };
}

export function goalFromRow(_database: SqliteDatabase, row: SqlRow): Goal {
  const status = asString(row, "status");
  if (!isGoalStatus(status))
    throw new Error(`Invalid persisted Goal status '${status}'.`);
  const parentGoalId = optionalString(row, "parent_goal_id");
  const blockerFingerprint = optionalString(row, "blocker_fingerprint");
  const completedAt = optionalString(row, "completed_at");
  return {
    continuationCount: asNumber(row, "continuation_count"),
    createdAt: asString(row, "created_at"),
    description: asString(row, "description"),
    id: asString(row, "id") as GoalId,
    runId: asString(row, "run_id") as RunId,
    status,
    title: asString(row, "title"),
    updatedAt: asString(row, "updated_at"),
    ...(parentGoalId === undefined
      ? {}
      : { parentGoalId: parentGoalId as GoalId }),
    ...(blockerFingerprint === undefined ? {} : { blockerFingerprint }),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

export function taskFromRow(database: SqliteDatabase, row: SqlRow): Task {
  const status = asString(row, "status");
  if (!isTaskStatus(status))
    throw new Error(`Invalid persisted Task status '${status}'.`);
  const id = asString(row, "id") as TaskId;
  const goalId = optionalString(row, "goal_id");
  const ownerAgentId = optionalString(row, "owner_agent_id");
  const resultJson = optionalString(row, "result_json");
  const completedAt = optionalString(row, "completed_at");
  const lastError = optionalString(row, "last_error");
  return {
    attempt: Number(row["attempt"] ?? 0),
    blockerIds: database
      .all(
        "SELECT problem_id FROM task_problems WHERE task_id = ? ORDER BY problem_id",
        id,
      )
      .map((problem) => asString(problem, "problem_id") as ProblemId),
    createdAt: asString(row, "created_at"),
    dependencyIds: database
      .all(
        "SELECT dependency_id FROM task_dependencies WHERE task_id = ? ORDER BY dependency_id",
        id,
      )
      .map((dependency) => asString(dependency, "dependency_id") as TaskId),
    description: asString(row, "description"),
    evidenceIds: database
      .all(
        "SELECT evidence_id FROM task_evidence WHERE task_id = ? ORDER BY evidence_id",
        id,
      )
      .map(
        (evidence) =>
          asString(evidence, "evidence_id") as Task["evidenceIds"][number],
      ),
    id,
    requirementIds: database
      .all(
        "SELECT requirement_id FROM task_requirements WHERE task_id = ? ORDER BY requirement_id",
        id,
      )
      .map(
        (requirement) =>
          asString(
            requirement,
            "requirement_id",
          ) as Task["requirementIds"][number],
      ),
    resourceScopes: database
      .all("SELECT * FROM task_resource_scopes WHERE task_id = ?", id)
      .map((scope) => ({
        access: asOneOf(scope, "access_mode", ["read", "write"] as const),
        identifier: asString(scope, "identifier"),
        kind: asOneOf(scope, "kind", [
          "custom",
          "database",
          "deployment",
          "file",
          "git",
          "process",
          "repository",
          "service",
        ] as const),
      })),
    runId: asString(row, "run_id") as RunId,
    status,
    title: asString(row, "title"),
    updatedAt: asString(row, "updated_at"),
    ...(goalId === undefined ? {} : { goalId: goalId as GoalId }),
    ...(ownerAgentId === undefined
      ? {}
      : { ownerAgentId: ownerAgentId as AgentId }),
    ...(resultJson === undefined
      ? {}
      : { result: parseJson<JsonValue>(resultJson) }),
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(lastError === undefined ? {} : { lastError }),
  };
}

export function agentFromRow(database: SqliteDatabase, row: SqlRow): Agent {
  const status = asString(row, "status");
  if (!isAgentStatus(status))
    throw new Error(`Invalid persisted Agent status '${status}'.`);
  const id = asString(row, "id") as AgentId;
  const taskId = optionalString(row, "task_id");
  const worktreeUri = optionalString(row, "worktree_uri");
  const closedAt = optionalString(row, "closed_at");
  const parentAgentId = findParentAgentId(database, id);
  return {
    createdAt: asString(row, "created_at"),
    id,
    permissions: parseJson<PermissionPolicy>(asString(row, "permissions_json")),
    role: asOneOf(row, "role", [
      "coordinator",
      "debugger",
      "implementer",
      "researcher",
      "reviewer",
      "specialist",
      "verifier",
    ] as const),
    runId: asString(row, "run_id") as RunId,
    sandbox: parseJson<SandboxPolicy>(asString(row, "sandbox_json")),
    sessionEpochIds: database
      .all(
        "SELECT id FROM session_epochs WHERE agent_id = ? ORDER BY ordinal",
        id,
      )
      .map(
        (epoch) => asString(epoch, "id") as Agent["sessionEpochIds"][number],
      ),
    spawnedAt: asString(row, "spawned_at"),
    status,
    updatedAt: asString(row, "updated_at"),
    ...(taskId === undefined ? {} : { taskId: taskId as TaskId }),
    ...(worktreeUri === undefined ? {} : { worktreeUri }),
    ...(closedAt === undefined ? {} : { closedAt }),
    ...(parentAgentId === undefined ? {} : { parentAgentId }),
  };
}

export function findParentAgentId(
  database: SqliteDatabase,
  agentId: AgentId,
): AgentId | undefined {
  const edge = database.get(
    "SELECT parent_agent_id FROM agent_edges WHERE child_agent_id = ?",
    agentId,
  );
  return edge === undefined
    ? undefined
    : (asString(edge, "parent_agent_id") as AgentId);
}

export function eventFromRow(_database: SqliteDatabase, row: SqlRow): RunEvent {
  const now = asString(row, "created_at");
  return {
    createdAt: now,
    id: asString(row, "id") as RunEvent["id"],
    payload: parseJson<JsonObject>(asString(row, "payload_json")),
    runId: asString(row, "run_id") as RunId,
    sequence: asNumber(row, "seq"),
    type: asString(row, "type") as RunEventType,
    updatedAt: now,
  };
}

export function sessionEpochFromRow(
  _database: SqliteDatabase,
  row: SqlRow,
): SessionEpoch {
  const endedAt = optionalString(row, "ended_at");
  const endReason = optionalString(row, "end_reason");
  const handoffContextSnapshotId = optionalString(
    row,
    "handoff_context_snapshot_id",
  );
  return {
    agentId: asString(row, "agent_id") as AgentId,
    createdAt: asString(row, "created_at"),
    id: asString(row, "id") as SessionEpoch["id"],
    model: asString(row, "model"),
    ordinal: asNumber(row, "ordinal"),
    provider: asString(row, "provider"),
    startedAt: asString(row, "started_at"),
    updatedAt: asString(row, "updated_at"),
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(handoffContextSnapshotId === undefined
      ? {}
      : {
          handoffContextSnapshotId:
            handoffContextSnapshotId as ContextSnapshotId,
        }),
    ...(endReason === undefined
      ? {}
      : {
          endReason: endReason as Exclude<SessionEpoch["endReason"], undefined>,
        }),
  };
}
