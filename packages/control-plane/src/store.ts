import { randomUUID } from "node:crypto";
import {
  EMPTY_BUDGET_USAGE,
  addBudgetUsage,
  assertAgentTransition,
  assertGoalTransition,
  assertRunTransition,
  assertTaskTransition,
  createId,
  evaluateBudget,
  isAgentStatus,
  isGoalStatus,
  isRunStatus,
  isTaskStatus,
  resourceScopesConflict,
  shouldContinueGoal,
  type Agent,
  type AgentId,
  type AgentRole,
  type AgentStatus,
  type Approval,
  type ApprovalId,
  type Artifact,
  type ArtifactId,
  type BudgetDelta,
  type CheckpointId,
  type ContextSnapshot,
  type ContextSnapshotId,
  type CostRecord,
  type CostRecordId,
  type Decision,
  type DecisionId,
  type Goal,
  type GoalId,
  type GoalStatus,
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
  type ResourceScope,
  type Run,
  type RunBudget,
  type RunEvent,
  type RunEventType,
  type RunId,
  type RunLease,
  type RunStatus,
  type SandboxPolicy,
  type SessionEpoch,
  type Task,
  type TaskId,
  type TaskStatus,
  type ToolDefinition,
  type ToolIdempotency,
  type ToolRecoveryStrategy,
  type ToolSideEffectClass,
} from "@ottili/core";

import { SqliteDatabase, type SqlRow } from "./database.js";

export class LeaseFencedError extends Error {
  public constructor(
    readonly runId: RunId,
    message: string,
  ) {
    super(message);
    this.name = "LeaseFencedError";
  }
}

export class RevisionConflictError extends Error {
  public constructor(
    readonly runId: RunId,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(
      `Run '${runId}' revision conflict: expected ${expected}, found ${actual}.`,
    );
    this.name = "RevisionConflictError";
  }
}

export class ResourceLockConflictError extends Error {
  public constructor(readonly scope: ResourceScope) {
    super(
      `Resource scope '${scope.kind}:${scope.identifier}' is locked by another task.`,
    );
    this.name = "ResourceLockConflictError";
  }
}

export interface Clock {
  now(): Date;
}

const systemClock: Clock = { now: () => new Date() };

const defaultPermissions: PermissionPolicy = { mode: "standard" };
const defaultSandbox: SandboxPolicy = {
  filesystem: { readOnlyRoots: [], writableRoots: [] },
  network: { allowedDestinations: [], enabled: false },
  permissions: defaultPermissions,
  process: { enabled: true },
};

export interface CreateRunInput {
  readonly budget?: RunBudget;
  readonly initialGoal?: {
    readonly description: string;
    readonly title: string;
  };
  readonly permissions?: PermissionPolicy;
  readonly prompt: string;
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
  readonly requirementIds?: readonly string[];
  readonly resourceScopes?: readonly ResourceScope[];
  readonly runId: RunId;
  readonly title: string;
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

export class RunStore {
  public constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: Clock = systemClock,
  ) {}

  public createRun(input: CreateRunInput): {
    readonly agent: Agent;
    readonly goal: Goal;
    readonly run: Run;
  } {
    const now = this.timestamp();
    const seed = randomUUID();
    const missionId = createId("mission", seed);
    const runId = createId("run", seed);
    const goalId = createId("goal", seed);
    const agentId = createId("agent", `${seed}:coordinator`);
    const title = input.title ?? summarizeTitle(input.prompt);
    const goalTitle = input.initialGoal?.title ?? title;
    const goalDescription = input.initialGoal?.description ?? input.prompt;
    const budget = input.budget ?? {};

    return this.database.transaction(() => {
      this.database.run(
        "INSERT INTO missions (id, title, prompt, workspace_uri, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        missionId,
        title,
        input.prompt,
        input.workspaceUri,
        now,
        now,
      );
      this.database.run(
        `INSERT INTO runs (id, mission_id, status, title, budget_json, usage_json, current_goal_id, started_at, created_at, updated_at)
         VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
        runId,
        missionId,
        title,
        stringify(budget),
        stringify(EMPTY_BUDGET_USAGE),
        goalId,
        now,
        now,
        now,
      );
      this.database.run(
        `INSERT INTO goals (id, run_id, goal_version, title, description, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
        goalId,
        runId,
        randomUUID(),
        goalTitle,
        goalDescription,
        now,
        now,
      );
      this.database.run(
        `INSERT INTO agents (id, run_id, role, status, permissions_json, sandbox_json, spawned_at, created_at, updated_at)
         VALUES (?, ?, 'coordinator', 'queued', ?, ?, ?, ?, ?)`,
        agentId,
        runId,
        stringify(input.permissions ?? defaultPermissions),
        stringify(defaultSandbox),
        now,
        now,
        now,
      );
      for (const [index, requirement] of (input.requirements ?? []).entries()) {
        const requirementId =
          requirement.id ??
          `requirement_${createId("requirement", `${seed}:${index}`).split("_").at(-1) ?? index}`;
        this.database.run(
          `INSERT INTO requirements (id, run_id, title, required, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'unproven', ?, ?)`,
          requirementId,
          runId,
          requirement.title,
          requirement.required === false ? 0 : 1,
          now,
          now,
        );
      }
      this.appendEventInternal(runId, "run.created", { missionId, title }, now);
      this.transitionRunInternal(runId, "running", now);
      this.transitionAgentInternal(agentId, "running", now);
      this.ensureContinuationInternal(runId, now);
      return {
        agent: this.mustAgent(agentId),
        goal: this.mustGoal(goalId),
        run: this.mustRun(runId),
      };
    });
  }

  public getRun(runId: RunId): Run | undefined {
    const row = this.database.get("SELECT * FROM runs WHERE id = ?", runId);
    return row === undefined ? undefined : this.runFromRow(row);
  }

  public getMission(missionId: MissionId): Mission | undefined {
    const row = this.database.get(
      "SELECT * FROM missions WHERE id = ?",
      missionId,
    );
    return row === undefined ? undefined : this.missionFromRow(row);
  }

  public listRuns(): readonly Run[] {
    return this.database
      .all("SELECT * FROM runs ORDER BY created_at DESC")
      .map((row) => this.runFromRow(row));
  }

  public getGoal(goalId: GoalId): Goal | undefined {
    const row = this.database.get("SELECT * FROM goals WHERE id = ?", goalId);
    return row === undefined ? undefined : this.goalFromRow(row);
  }

  public listGoals(runId: RunId): readonly Goal[] {
    return this.database
      .all("SELECT * FROM goals WHERE run_id = ? ORDER BY created_at", runId)
      .map((row) => this.goalFromRow(row));
  }

  public listAgents(runId: RunId): readonly Agent[] {
    return this.database
      .all("SELECT * FROM agents WHERE run_id = ? ORDER BY created_at", runId)
      .map((row) => this.agentFromRow(row));
  }

  public listEvents(runId: RunId, afterSequence = 0): readonly RunEvent[] {
    return this.database
      .all(
        "SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq",
        runId,
        afterSequence,
      )
      .map((row) => this.eventFromRow(row));
  }

  public listRequirements(runId: RunId): readonly RequirementRecord[] {
    return this.database
      .all("SELECT * FROM requirements WHERE run_id = ? ORDER BY id", runId)
      .map((row) => {
        const id = asString(row, "id");
        const evidence = this.database
          .all(
            "SELECT * FROM evidence WHERE requirement_id = ? ORDER BY created_at",
            id,
          )
          .map((item) => ({
            id: asString(item, "id"),
            kind: asOneOf(item, "kind", [
              "artifact",
              "command",
              "inspection",
              "review",
              "test",
            ] as const),
            strength: asOneOf(item, "strength", [
              "strong",
              "supporting",
              "weak",
            ] as const),
            summary: asString(item, "summary"),
          }));
        return {
          evidence,
          id,
          required: asNumber(row, "required") === 1,
          status: asOneOf(row, "status", [
            "contradicted",
            "proven",
            "unproven",
            "waived",
          ] as const),
          title: asString(row, "title"),
        };
      });
  }

  public listCheckpoints(runId: RunId): readonly CheckpointRecord[] {
    return this.database
      .all(
        "SELECT * FROM checkpoints WHERE run_id = ? ORDER BY sequence",
        runId,
      )
      .map((row) => {
        const workspaceRef = optionalString(row, "workspace_ref");
        return {
          createdAt: asString(row, "created_at"),
          id: asString(row, "id") as CheckpointId,
          label: asString(row, "label"),
          manifest: parseJson<JsonObject>(asString(row, "manifest_json")),
          reason: asString(row, "reason"),
          runId: asString(row, "run_id") as RunId,
          sequence: asNumber(row, "sequence"),
          ...(workspaceRef === undefined ? {} : { workspaceRef }),
        };
      });
  }

  public listValidations(runId: RunId): readonly ValidationRecord[] {
    return this.database
      .all(
        "SELECT * FROM validations WHERE run_id = ? ORDER BY created_at, id",
        runId,
      )
      .map((row) => ({
        createdAt: asString(row, "created_at"),
        id: asString(row, "id"),
        independent: asNumber(row, "independent") === 1,
        name: asString(row, "name"),
        passed: asString(row, "status") === "passed",
        runId: asString(row, "run_id") as RunId,
        summary: asString(row, "summary"),
      }));
  }

  public createMilestone(input: {
    readonly runId: RunId;
    readonly status?: Milestone["status"];
    readonly taskIds?: readonly TaskId[];
    readonly title: string;
  }): Milestone {
    const now = this.timestamp();
    const id = createId("milestone", `${input.runId}:${randomUUID()}`);
    return this.database.transaction(() => {
      for (const taskId of input.taskIds ?? []) {
        if (this.mustTask(taskId).runId !== input.runId) {
          throw new Error("Milestone tasks must belong to the same Run.");
        }
      }
      this.database.run(
        "INSERT INTO milestones (id, run_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        id,
        input.runId,
        input.title,
        input.status ?? "pending",
        now,
        now,
      );
      for (const taskId of input.taskIds ?? []) {
        this.database.run(
          "INSERT INTO milestone_tasks (milestone_id, task_id) VALUES (?, ?)",
          id,
          taskId,
        );
      }
      return this.mustMilestone(id);
    });
  }

  public listMilestones(runId: RunId): readonly Milestone[] {
    return this.database
      .all(
        "SELECT * FROM milestones WHERE run_id = ? ORDER BY created_at, id",
        runId,
      )
      .map((row) => this.milestoneFromRow(row));
  }

  public recordDecision(input: {
    readonly alternatives?: readonly string[];
    readonly evidenceIds?: readonly string[];
    readonly rationale: string;
    readonly runId: RunId;
    readonly title: string;
  }): Decision {
    const now = this.timestamp();
    const id = createId("decision", `${input.runId}:${randomUUID()}`);
    this.database.run(
      `INSERT INTO decisions (id, run_id, title, rationale, alternatives_json, evidence_ids_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.runId,
      input.title,
      input.rationale,
      stringify(input.alternatives ?? []),
      stringify(input.evidenceIds ?? []),
      now,
      now,
    );
    return this.mustDecision(id);
  }

  public listDecisions(runId: RunId): readonly Decision[] {
    return this.database
      .all(
        "SELECT * FROM decisions WHERE run_id = ? ORDER BY created_at, id",
        runId,
      )
      .map((row) => this.decisionFromRow(row));
  }

  /**
   * Records a material blocker observation. A Run can enter `blocked` only
   * after three meaningful observations of the same durable fingerprint,
   * all requiring external state and with no alternate action remaining.
   */
  public recordProblem(input: RecordProblemInput): Problem {
    const now = this.timestamp();
    return this.database.transaction(() => {
      let row = this.database.get(
        "SELECT * FROM problems WHERE run_id = ? AND fingerprint = ?",
        input.runId,
        input.fingerprint,
      );
      const id =
        row === undefined
          ? createId("problem", `${input.runId}:${input.fingerprint}`)
          : (asString(row, "id") as ProblemId);
      if (row === undefined) {
        this.database.run(
          `INSERT INTO problems (id, run_id, fingerprint, summary, external_dependency, alternate_action_available, meaningful_attempts, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, 'open', ?, ?)`,
          id,
          input.runId,
          input.fingerprint,
          input.summary,
          input.externalDependency ? 1 : 0,
          input.alternateActionAvailable ? 1 : 0,
          now,
          now,
        );
      }
      this.database.run(
        `INSERT INTO problem_observations (id, problem_id, meaningful, external_dependency, alternate_action_available, note, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        createId("event", `problem-observation:${id}:${randomUUID()}`),
        id,
        input.meaningful === false ? 0 : 1,
        input.externalDependency ? 1 : 0,
        input.alternateActionAvailable ? 1 : 0,
        input.note ?? null,
        now,
      );
      if (input.taskId !== undefined) {
        if (this.mustTask(input.taskId).runId !== input.runId) {
          throw new Error("Problem task must belong to the same Run.");
        }
        this.database.run(
          "INSERT OR IGNORE INTO task_problems (task_id, problem_id) VALUES (?, ?)",
          input.taskId,
          id,
        );
      }
      const observations = this.database.all(
        "SELECT * FROM problem_observations WHERE problem_id = ? ORDER BY occurred_at, id",
        id,
      );
      const meaningful = observations.filter(
        (observation) => asNumber(observation, "meaningful") === 1,
      );
      const eligible =
        meaningful.length >= 3 &&
        meaningful.every(
          (observation) => asNumber(observation, "external_dependency") === 1,
        ) &&
        meaningful.every(
          (observation) =>
            asNumber(observation, "alternate_action_available") === 0,
        );
      const status: Problem["status"] = eligible ? "blocked" : "open";
      this.database.run(
        `UPDATE problems
         SET summary = ?, external_dependency = ?, alternate_action_available = ?, meaningful_attempts = ?, status = ?, updated_at = ?
         WHERE id = ?`,
        input.summary,
        input.externalDependency ? 1 : 0,
        input.alternateActionAvailable ? 1 : 0,
        meaningful.length,
        status,
        now,
        id,
      );
      if (eligible)
        this.blockRunForProblemInternal(input.runId, input.fingerprint, now);
      row = this.database.get("SELECT * FROM problems WHERE id = ?", id);
      if (row === undefined)
        throw new Error("Recorded Problem could not be read back.");
      return this.problemFromRow(row);
    });
  }

  public listProblems(runId: RunId): readonly Problem[] {
    return this.database
      .all(
        "SELECT * FROM problems WHERE run_id = ? ORDER BY created_at, id",
        runId,
      )
      .map((row) => this.problemFromRow(row));
  }

  public addArtifact(input: {
    readonly checksum?: string;
    readonly label: string;
    readonly mediaType?: string;
    readonly runId: RunId;
    readonly sizeBytes?: number;
    readonly uri: string;
  }): Artifact {
    if (
      input.sizeBytes !== undefined &&
      (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0)
    ) {
      throw new Error(
        "Artifact sizeBytes must be a non-negative safe integer.",
      );
    }
    const now = this.timestamp();
    const id = createId("artifact", `${input.runId}:${randomUUID()}`);
    this.database.run(
      `INSERT INTO artifacts (id, run_id, label, uri, media_type, size_bytes, checksum, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.runId,
      input.label,
      input.uri,
      input.mediaType ?? null,
      input.sizeBytes ?? null,
      input.checksum ?? null,
      now,
      now,
    );
    return this.mustArtifact(id);
  }

  public listArtifacts(runId: RunId): readonly Artifact[] {
    return this.database
      .all(
        "SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at, id",
        runId,
      )
      .map((row) => this.artifactFromRow(row));
  }

  public recordGitChange(input: {
    readonly repositoryUri: string;
    readonly revision: string;
    readonly runId: RunId;
    readonly summary: string;
    readonly taskIds?: readonly TaskId[];
  }): GitChange {
    const now = this.timestamp();
    const id = createId("git-change", `${input.runId}:${randomUUID()}`);
    this.database.run(
      `INSERT INTO git_changes (id, run_id, repository_uri, revision, summary, task_ids_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.runId,
      input.repositoryUri,
      input.revision,
      input.summary,
      stringify(input.taskIds ?? []),
      now,
      now,
    );
    return this.mustGitChange(id);
  }

  public listGitChanges(runId: RunId): readonly GitChange[] {
    return this.database
      .all(
        "SELECT * FROM git_changes WHERE run_id = ? ORDER BY created_at, id",
        runId,
      )
      .map((row) => this.gitChangeFromRow(row));
  }

  public recordCost(input: {
    readonly agentId?: AgentId;
    readonly cachedTokens?: number;
    readonly costUsd?: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    /** Carry a fence when the record originates from an active executor. */
    readonly lease?: Pick<RunLease, "generation" | "executorId" | "runId">;
    readonly runId: RunId;
    readonly sessionEpochId?: SessionEpoch["id"];
  }): CostRecord {
    const numeric = [
      input.cachedTokens ?? 0,
      input.costUsd ?? 0,
      input.inputTokens ?? 0,
      input.outputTokens ?? 0,
    ];
    if (numeric.some((value) => !Number.isFinite(value) || value < 0)) {
      throw new Error("Cost records require finite non-negative values.");
    }
    const now = this.timestamp();
    const id = createId("cost-record", `${input.runId}:${randomUUID()}`);
    return this.database.transaction(() => {
      if (input.lease !== undefined) {
        if (input.lease.runId !== input.runId) {
          throw new LeaseFencedError(
            input.runId,
            "Cost record lease belongs to another Run.",
          );
        }
        this.assertLeaseInternal(input.lease, now);
      }
      this.database.run(
        `INSERT INTO cost_records (id, run_id, agent_id, session_epoch_id, input_tokens, output_tokens, cached_tokens, cost_usd, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.runId,
        input.agentId ?? null,
        input.sessionEpochId ?? null,
        input.inputTokens ?? 0,
        input.outputTokens ?? 0,
        input.cachedTokens ?? 0,
        input.costUsd ?? 0,
        now,
        now,
      );
      return this.mustCostRecord(id);
    });
  }

  public listCostRecords(runId: RunId): readonly CostRecord[] {
    return this.database
      .all(
        "SELECT * FROM cost_records WHERE run_id = ? ORDER BY created_at, id",
        runId,
      )
      .map((row) => this.costRecordFromRow(row));
  }

  public setRecoveryState(input: {
    readonly lastCheckpointId?: CheckpointId;
    readonly reason?: string;
    readonly runId: RunId;
    readonly status: RecoveryState["status"];
    readonly unknownToolCallIds?: readonly string[];
  }): RecoveryState {
    const now = this.timestamp();
    const id = createId("recovery-state", input.runId);
    this.database.run(
      `INSERT INTO recovery_states (id, run_id, status, last_checkpoint_id, unknown_tool_call_ids_json, reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         status = excluded.status,
         last_checkpoint_id = excluded.last_checkpoint_id,
         unknown_tool_call_ids_json = excluded.unknown_tool_call_ids_json,
         reason = excluded.reason,
         updated_at = excluded.updated_at`,
      id,
      input.runId,
      input.status,
      input.lastCheckpointId ?? null,
      stringify(input.unknownToolCallIds ?? []),
      input.reason ?? null,
      now,
      now,
    );
    return this.mustRecoveryState(input.runId);
  }

  public getRecoveryState(runId: RunId): RecoveryState | undefined {
    const row = this.database.get(
      "SELECT * FROM recovery_states WHERE run_id = ?",
      runId,
    );
    return row === undefined ? undefined : this.recoveryStateFromRow(row);
  }

  public createContextSnapshot(input: {
    readonly agentId?: AgentId;
    readonly checkpointId?: CheckpointId;
    readonly lease?: Pick<RunLease, "generation" | "executorId" | "runId">;
    readonly runId: RunId;
    readonly sessionEpochId?: SessionEpoch["id"];
    readonly summary: string;
    readonly tokenCount: number;
  }): ContextSnapshot {
    if (!Number.isSafeInteger(input.tokenCount) || input.tokenCount < 0) {
      throw new Error(
        "Context snapshot tokenCount must be a non-negative safe integer.",
      );
    }
    const now = this.timestamp();
    const id = createId("context-snapshot", `${input.runId}:${randomUUID()}`);
    return this.database.transaction(() => {
      if (input.lease !== undefined) {
        if (input.lease.runId !== input.runId) {
          throw new LeaseFencedError(
            input.runId,
            "Context snapshot lease belongs to another Run.",
          );
        }
        this.assertLeaseInternal(input.lease, now);
      }
      this.database.run(
        `INSERT INTO context_snapshots (id, run_id, agent_id, session_epoch_id, summary, token_count, checkpoint_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.runId,
        input.agentId ?? null,
        input.sessionEpochId ?? null,
        input.summary,
        input.tokenCount,
        input.checkpointId ?? null,
        now,
        now,
      );
      if (input.sessionEpochId !== undefined) {
        this.database.run(
          "UPDATE session_epochs SET handoff_context_snapshot_id = ?, updated_at = ? WHERE id = ?",
          id,
          now,
          input.sessionEpochId,
        );
      }
      return this.mustContextSnapshot(id);
    });
  }

  public listContextSnapshots(runId: RunId): readonly ContextSnapshot[] {
    return this.database
      .all(
        "SELECT * FROM context_snapshots WHERE run_id = ? ORDER BY created_at, id",
        runId,
      )
      .map((row) => this.contextSnapshotFromRow(row));
  }

  public addMemoryEntry(input: {
    readonly agentId?: AgentId;
    readonly confidence: number;
    readonly content: string;
    readonly runId: RunId;
    readonly scope: MemoryEntry["scope"];
    readonly sourceEvidenceIds?: readonly string[];
  }): MemoryEntry {
    if (
      !Number.isFinite(input.confidence) ||
      input.confidence < 0 ||
      input.confidence > 1
    ) {
      throw new Error("Memory confidence must be within [0, 1].");
    }
    const now = this.timestamp();
    const id = createId("memory-entry", `${input.runId}:${randomUUID()}`);
    this.database.run(
      `INSERT INTO memory_entries (id, run_id, scope, content, confidence, agent_id, source_evidence_ids_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.runId,
      input.scope,
      input.content,
      input.confidence,
      input.agentId ?? null,
      stringify(input.sourceEvidenceIds ?? []),
      now,
      now,
    );
    return this.mustMemoryEntry(id);
  }

  public listMemoryEntries(runId: RunId): readonly MemoryEntry[] {
    return this.database
      .all(
        "SELECT * FROM memory_entries WHERE run_id = ? ORDER BY created_at, id",
        runId,
      )
      .map((row) => this.memoryEntryFromRow(row));
  }

  public requestApproval(input: RequestApprovalInput): Approval {
    const now = this.timestamp();
    const id = createId("approval", `${input.runId}:${randomUUID()}`);
    return this.database.transaction(() => {
      if (input.lease !== undefined) {
        if (input.lease.runId !== input.runId) {
          throw new LeaseFencedError(
            input.runId,
            "Approval lease belongs to another Run.",
          );
        }
        this.assertLeaseInternal(input.lease, now);
      }
      this.database.run(
        `INSERT INTO approvals (id, run_id, agent_id, tool_call_id, status, summary, requested_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
        id,
        input.runId,
        input.agentId ?? null,
        input.toolCallId ?? null,
        input.summary,
        now,
        now,
        now,
      );
      this.appendEventInternal(
        input.runId,
        "approval.requested",
        { approvalId: id, summary: input.summary },
        now,
      );
      return this.mustApproval(id);
    });
  }

  public listApprovals(runId: RunId): readonly Approval[] {
    return this.database
      .all(
        "SELECT * FROM approvals WHERE run_id = ? ORDER BY requested_at, id",
        runId,
      )
      .map((row) => this.approvalFromRow(row));
  }

  public resolveApproval(input: {
    readonly approvalId: ApprovalId;
    readonly resolverId: string;
    readonly status: "approved" | "rejected" | "expired";
  }): Approval {
    const now = this.timestamp();
    return this.database.transaction(() => {
      const existing = this.mustApproval(input.approvalId);
      if (existing.status !== "pending") {
        throw new Error(`Approval '${existing.id}' has already been resolved.`);
      }
      this.database.run(
        `UPDATE approvals
         SET status = ?, resolved_at = ?, resolver_id = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
        input.status,
        now,
        input.resolverId,
        now,
        input.approvalId,
      );
      this.appendEventInternal(
        existing.runId,
        "approval.resolved",
        { approvalId: existing.id, status: input.status },
        now,
      );
      // An approval is a durable external wait. Once every pending decision
      // is resolved, make its continuation visible to any daemon; the
      // coordinator rechecks the exact authorization before side effects.
      const pending = this.database.get(
        "SELECT id FROM approvals WHERE run_id = ? AND status = 'pending' LIMIT 1",
        existing.runId,
      );
      const run = this.mustRun(existing.runId);
      if (pending === undefined && run.status === "waiting_external") {
        this.transitionRunInternal(existing.runId, "running", now);
        this.ensureContinuationInternal(existing.runId, now);
      }
      return this.mustApproval(input.approvalId);
    });
  }

  public addEvidence(input: {
    readonly artifactIds?: readonly ArtifactId[];
    readonly kind: "artifact" | "command" | "inspection" | "review" | "test";
    readonly requirementId: string;
    readonly runId: RunId;
    readonly strength: "strong" | "supporting" | "weak";
    readonly summary: string;
    readonly taskId?: TaskId;
  }): string {
    const now = this.timestamp();
    const id = `evidence_${randomUUID()}`;
    this.database.transaction(() => {
      this.database.run(
        "INSERT INTO evidence (id, run_id, requirement_id, task_id, kind, strength, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        input.runId,
        input.requirementId,
        input.taskId ?? null,
        input.kind,
        input.strength,
        input.summary,
        now,
      );
      if (input.taskId !== undefined) {
        if (this.mustTask(input.taskId).runId !== input.runId) {
          throw new Error("Evidence task must belong to the same Run.");
        }
        this.database.run(
          "INSERT OR IGNORE INTO task_evidence (task_id, evidence_id) VALUES (?, ?)",
          input.taskId,
          id,
        );
      }
      for (const artifactId of input.artifactIds ?? []) {
        const artifact = this.mustArtifact(artifactId);
        if (artifact.runId !== input.runId) {
          throw new Error("Evidence artifact must belong to the same Run.");
        }
        this.database.run(
          "INSERT OR IGNORE INTO evidence_artifacts (evidence_id, artifact_id) VALUES (?, ?)",
          id,
          artifactId,
        );
      }
      this.database.run(
        "UPDATE requirements SET updated_at = ? WHERE id = ? AND run_id = ?",
        now,
        input.requirementId,
        input.runId,
      );
    });
    return id;
  }

  public setRequirementStatus(
    runId: RunId,
    requirementId: string,
    status: RequirementRecord["status"],
  ): void {
    this.database.transaction(() => {
      if (status === "proven") {
        const evidence = this.database.get(
          "SELECT id FROM evidence WHERE requirement_id = ? AND strength = 'strong' LIMIT 1",
          requirementId,
        );
        if (evidence === undefined)
          throw new Error(
            `Requirement '${requirementId}' cannot be proven without strong evidence.`,
          );
      }
      this.database.run(
        "UPDATE requirements SET status = ?, updated_at = ? WHERE id = ? AND run_id = ?",
        status,
        this.timestamp(),
        requirementId,
        runId,
      );
    });
  }

  public recordValidation(input: {
    readonly independent?: boolean;
    readonly lease?: Pick<RunLease, "generation" | "executorId" | "runId">;
    readonly name: string;
    readonly passed: boolean;
    readonly runId: RunId;
    readonly summary: string;
    readonly taskId?: TaskId;
  }): string {
    const now = this.timestamp();
    const id = `validation_${randomUUID()}`;
    this.database.transaction(() => {
      if (input.lease !== undefined) {
        if (input.lease.runId !== input.runId)
          throw new LeaseFencedError(
            input.runId,
            "Validation lease belongs to another Run.",
          );
        this.assertLeaseInternal(input.lease, now);
      }
      this.database.run(
        `INSERT INTO validations (id, run_id, task_id, name, status, summary, independent, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.runId,
        input.taskId ?? null,
        input.name,
        input.passed ? "passed" : "failed",
        input.summary,
        input.independent === true ? 1 : 0,
        now,
        now,
      );
      if (
        input.taskId !== undefined &&
        this.mustTask(input.taskId).runId !== input.runId
      ) {
        throw new Error("Validation task must belong to the same Run.");
      }
      this.appendEventInternal(
        input.runId,
        "validation.finished",
        { id, passed: input.passed },
        now,
      );
    });
    return id;
  }

  public transitionRun(input: {
    readonly expectedRevision?: number;
    readonly lease?: Pick<RunLease, "generation" | "executorId" | "runId">;
    readonly reason?: string;
    readonly runId: RunId;
    readonly to: Exclude<RunStatus, "completed">;
  }): Run {
    return this.database.transaction(() => {
      const now = this.timestamp();
      if (input.lease !== undefined) {
        if (input.lease.runId !== input.runId)
          throw new LeaseFencedError(
            input.runId,
            "Transition lease belongs to another Run.",
          );
        this.assertLeaseInternal(input.lease, now);
      }
      const run = this.mustRun(input.runId);
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== run.revision
      ) {
        throw new RevisionConflictError(
          run.id,
          input.expectedRevision,
          run.revision,
        );
      }
      this.transitionRunInternal(run.id, input.to, now, input.reason);
      if (input.to === "running") this.ensureContinuationInternal(run.id, now);
      return this.mustRun(run.id);
    });
  }

  public setGoalStatus(input: {
    readonly expectedGoalVersion: string;
    readonly goalId: GoalId;
    readonly to: GoalStatus;
  }): Goal {
    const now = this.timestamp();
    return this.database.transaction(() => {
      const row = this.database.get(
        "SELECT * FROM goals WHERE id = ?",
        input.goalId,
      );
      if (row === undefined)
        throw new Error(`Goal '${input.goalId}' was not found.`);
      if (asString(row, "goal_version") !== input.expectedGoalVersion) {
        throw new RevisionConflictError(asString(row, "run_id") as RunId, 0, 1);
      }
      const current = this.goalFromRow(row);
      assertGoalTransition(current.status, input.to);
      this.database.run(
        "UPDATE goals SET status = ?, completed_at = ?, updated_at = ? WHERE id = ? AND goal_version = ?",
        input.to,
        input.to === "complete" ? now : null,
        now,
        current.id,
        input.expectedGoalVersion,
      );
      this.appendEventInternal(
        current.runId,
        "goal.status_changed",
        { goalId: current.id, to: input.to },
        now,
      );
      if (shouldContinueGoal(input.to))
        this.ensureContinuationInternal(current.runId, now);
      return this.mustGoal(current.id);
    });
  }

  public pause(runId: RunId, expectedRevision?: number): Run {
    return expectedRevision === undefined
      ? this.transitionRun({ runId, to: "paused" })
      : this.transitionRun({ expectedRevision, runId, to: "paused" });
  }

  public resume(runId: RunId, expectedRevision?: number): Run {
    const run = this.mustRun(runId);
    const to: Exclude<RunStatus, "completed"> =
      run.status === "paused" ? "running" : "queued";
    return expectedRevision === undefined
      ? this.transitionRun({ runId, to })
      : this.transitionRun({ expectedRevision, runId, to });
  }

  public cancel(runId: RunId, expectedRevision?: number): Run {
    return expectedRevision === undefined
      ? this.transitionRun({ runId, to: "cancelled" })
      : this.transitionRun({ expectedRevision, runId, to: "cancelled" });
  }

  /**
   * Executes a user command exactly once per caller-supplied command ID. The
   * receipt and state transition live in the same SQLite transaction, so an
   * HTTP retry cannot pause/cancel a later revision accidentally.
   */
  public executeCommand(input: {
    readonly command: DurableRunCommand;
    readonly commandId: string;
    readonly reason?: string;
    readonly runId: RunId;
  }): Run {
    return this.database.transaction(() => {
      const prior = this.database.get(
        "SELECT result_json FROM command_receipts WHERE command_id = ? AND run_id = ?",
        input.commandId,
        input.runId,
      );
      if (prior !== undefined)
        return parseJson<Run>(asString(prior, "result_json"));

      const run = this.mustRun(input.runId);
      let result: Run;
      if (input.command === "pause") {
        this.transitionRunInternal(
          run.id,
          "paused",
          this.timestamp(),
          input.reason,
        );
        result = this.mustRun(run.id);
      } else if (input.command === "cancel") {
        this.transitionRunInternal(
          run.id,
          "cancelled",
          this.timestamp(),
          input.reason,
        );
        result = this.mustRun(run.id);
      } else if (run.status === "running") {
        result = run;
      } else {
        const to: Exclude<RunStatus, "completed"> =
          run.status === "paused" || run.status === "waiting_external"
            ? "running"
            : "queued";
        this.transitionRunInternal(run.id, to, this.timestamp(), input.reason);
        if (to === "running")
          this.ensureContinuationInternal(run.id, this.timestamp());
        result = this.mustRun(run.id);
      }
      this.database.run(
        "INSERT INTO command_receipts (command_id, run_id, result_json, created_at) VALUES (?, ?, ?, ?)",
        input.commandId,
        run.id,
        stringify(result),
        this.timestamp(),
      );
      return result;
    });
  }

  public recordSteeringInput(input: {
    readonly runId: RunId;
    readonly targetAgentId?: AgentId;
    readonly targetGoalId?: GoalId;
    readonly text: string;
  }): RunEvent {
    return this.database.transaction(() =>
      this.appendEventInternal(
        input.runId,
        "steering.received",
        {
          text: input.text,
          ...(input.targetAgentId === undefined
            ? {}
            : { targetAgentId: input.targetAgentId }),
          ...(input.targetGoalId === undefined
            ? {}
            : { targetGoalId: input.targetGoalId }),
        },
        this.timestamp(),
      ),
    );
  }

  public proposeCompletion(input: {
    readonly accepted: boolean;
    /** Recorded only by the separate verifier boundary, never a model claim. */
    readonly independentlyVerified?: boolean;
    readonly lease?: Pick<RunLease, "generation" | "executorId" | "runId">;
    readonly reasons: readonly string[];
    readonly runId: RunId;
  }): Run {
    const now = this.timestamp();
    return this.database.transaction(() => {
      if (input.lease !== undefined) {
        if (input.lease.runId !== input.runId)
          throw new LeaseFencedError(
            input.runId,
            "Completion lease belongs to another Run.",
          );
        this.assertLeaseInternal(input.lease, now);
      }
      const run = this.mustRun(input.runId);
      const requirements = this.listRequirements(run.id);
      const unproven = requirements.filter(
        (requirement) =>
          requirement.required &&
          requirement.status !== "waived" &&
          (requirement.status !== "proven" ||
            !requirement.evidence.some(
              (evidence) => evidence.strength === "strong",
            )),
      );
      const validations = this.listValidations(run.id);
      const failedValidations = validations.filter(
        (validation) => !validation.passed,
      );
      const hasIndependentValidation = validations.some(
        (validation) => validation.passed && validation.independent,
      );
      const controlPlaneReasons = [
        ...(unproven.length === 0
          ? []
          : [
              `Required requirements remain unproven: ${unproven.map((requirement) => requirement.id).join(", ")}.`,
            ]),
        ...(failedValidations.length === 0
          ? []
          : [
              `Deterministic validation failed: ${failedValidations.map((validation) => validation.id).join(", ")}.`,
            ]),
        ...(hasIndependentValidation
          ? []
          : ["No passing independent validation is recorded."]),
        ...(input.independentlyVerified === true
          ? []
          : ["No independent verifier acceptance is recorded."]),
      ];
      const accepted = input.accepted && controlPlaneReasons.length === 0;
      const reasons = [...input.reasons, ...controlPlaneReasons];
      this.appendEventInternal(
        run.id,
        "validation.finished",
        { accepted, reasons },
        now,
      );
      if (!accepted) return this.mustRun(run.id);
      assertRunTransition(run.status, "completed");
      this.transitionRunInternal(run.id, "completed", now);
      return this.mustRun(run.id);
    });
  }

  public acquireLease(input: {
    readonly executorId: string;
    readonly host?: string;
    readonly processId?: number;
    readonly runId: RunId;
    readonly ttlMs: number;
  }): RunLease {
    const now = this.clock.now();
    const timestamp = now.toISOString();
    const expiresAt = new Date(now.getTime() + input.ttlMs).toISOString();
    return this.database.transaction(() => {
      const existing = this.database.get(
        "SELECT * FROM run_leases WHERE run_id = ?",
        input.runId,
      );
      if (existing !== undefined) {
        const currentHolder = asString(existing, "holder_id");
        const currentExpiry = asString(existing, "expires_at");
        if (currentHolder !== input.executorId && currentExpiry > timestamp) {
          throw new LeaseFencedError(
            input.runId,
            `Run is leased by '${currentHolder}' until ${currentExpiry}.`,
          );
        }
        // A holder that returns after its lease expired is a new ownership
        // epoch even when it happens to use the same executor identity. This
        // fences a delayed process from a prior daemon lifetime.
        const generation =
          asNumber(existing, "generation") +
          (currentHolder === input.executorId && currentExpiry > timestamp
            ? 0
            : 1);
        this.database.run(
          `UPDATE run_leases SET holder_id = ?, generation = ?, expires_at = ?, heartbeat_at = ?, host = ?, process_id = ?, updated_at = ?
           WHERE run_id = ?`,
          input.executorId,
          generation,
          expiresAt,
          timestamp,
          input.host ?? null,
          input.processId ?? null,
          timestamp,
          input.runId,
        );
      } else {
        this.database.run(
          `INSERT INTO run_leases (run_id, id, holder_id, generation, expires_at, heartbeat_at, host, process_id, created_at, updated_at)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
          input.runId,
          createId("lease", `${input.runId}:${input.executorId}:${timestamp}`),
          input.executorId,
          expiresAt,
          timestamp,
          input.host ?? null,
          input.processId ?? null,
          timestamp,
          timestamp,
        );
      }
      this.database.run(
        "UPDATE runs SET run_epoch = run_epoch + 1, updated_at = ? WHERE id = ?",
        timestamp,
        input.runId,
      );
      return this.mustLease(input.runId);
    });
  }

  public renewLease(
    lease: Pick<RunLease, "generation" | "executorId" | "runId">,
    ttlMs: number,
  ): RunLease {
    const now = this.clock.now();
    const timestamp = now.toISOString();
    return this.database.transaction(() => {
      this.assertLeaseInternal(lease, timestamp);
      this.database.run(
        "UPDATE run_leases SET expires_at = ?, heartbeat_at = ?, updated_at = ? WHERE run_id = ? AND holder_id = ? AND generation = ?",
        new Date(now.getTime() + ttlMs).toISOString(),
        timestamp,
        timestamp,
        lease.runId,
        lease.executorId,
        lease.generation,
      );
      return this.mustLease(lease.runId);
    });
  }

  public appendFencedEvent(input: {
    readonly lease: Pick<RunLease, "generation" | "executorId" | "runId">;
    readonly payload: JsonObject;
    readonly type: RunEventType;
  }): RunEvent {
    return this.database.transaction(() => {
      const now = this.timestamp();
      this.assertLeaseInternal(input.lease, now);
      return this.appendEventInternal(
        input.lease.runId,
        input.type,
        input.payload,
        now,
        input.lease.generation,
      );
    });
  }

  public createTask(input: CreateTaskInput): Task {
    const now = this.timestamp();
    const id = createId("task", `${input.runId}:${randomUUID()}`);
    return this.database.transaction(() => {
      this.database.run(
        `INSERT INTO tasks (id, run_id, goal_id, title, description, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        id,
        input.runId,
        input.goalId ?? null,
        input.title,
        input.description,
        now,
        now,
      );
      for (const dependency of input.dependencies ?? []) {
        this.database.run(
          "INSERT INTO task_dependencies (task_id, dependency_id) VALUES (?, ?)",
          id,
          dependency,
        );
      }
      for (const requirementId of input.requirementIds ?? []) {
        const requirement = this.database.get(
          "SELECT id FROM requirements WHERE id = ? AND run_id = ?",
          requirementId,
          input.runId,
        );
        if (requirement === undefined) {
          throw new Error("Task requirement must belong to the same Run.");
        }
        this.database.run(
          "INSERT INTO task_requirements (task_id, requirement_id) VALUES (?, ?)",
          id,
          requirementId,
        );
      }
      for (const scope of input.resourceScopes ?? []) {
        this.database.run(
          "INSERT INTO task_resource_scopes (task_id, kind, identifier, access_mode) VALUES (?, ?, ?, ?)",
          id,
          scope.kind,
          scope.identifier,
          scope.access,
        );
      }
      this.refreshTaskReadinessInternal(input.runId, now);
      return this.mustTask(id);
    });
  }

  public transitionTask(taskId: TaskId, to: TaskStatus): Task {
    const now = this.timestamp();
    return this.database.transaction(() => {
      const task = this.mustTask(taskId);
      assertTaskTransition(task.status, to);
      this.database.run(
        "UPDATE tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?",
        to,
        to === "completed" ? now : null,
        now,
        task.id,
      );
      this.appendEventInternal(
        task.runId,
        "task.status_changed",
        { taskId: task.id, to },
        now,
      );
      this.refreshTaskReadinessInternal(task.runId, now);
      return this.mustTask(task.id);
    });
  }

  public spawnAgent(input: SpawnAgentInput): Agent {
    const now = this.timestamp();
    const id = createId("agent", `${input.runId}:${randomUUID()}`);
    return this.database.transaction(() => {
      if (input.parentAgentId !== undefined) {
        const parent = this.mustAgent(input.parentAgentId);
        if (parent.runId !== input.runId)
          throw new Error(
            "Parent and child agent must belong to the same Run.",
          );
      }
      this.database.run(
        `INSERT INTO agents (id, run_id, task_id, role, status, permissions_json, sandbox_json, worktree_uri, spawned_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?)`,
        id,
        input.runId,
        input.taskId ?? null,
        input.role,
        stringify(input.permissions ?? defaultPermissions),
        stringify(input.sandbox ?? defaultSandbox),
        input.worktreeUri ?? null,
        now,
        now,
        now,
      );
      if (input.parentAgentId !== undefined) {
        this.database.run(
          "INSERT INTO agent_edges (parent_agent_id, child_agent_id, status, created_at) VALUES (?, ?, 'open', ?)",
          input.parentAgentId,
          id,
          now,
        );
      }
      this.appendEventInternal(
        input.runId,
        "agent.status_changed",
        { agentId: id, to: "created" },
        now,
      );
      return this.mustAgent(id);
    });
  }

  public transitionAgent(agentId: AgentId, to: AgentStatus): Agent {
    const now = this.timestamp();
    return this.database.transaction(() =>
      this.transitionAgentInternal(agentId, to, now),
    );
  }

  public startSessionEpoch(input: {
    readonly agentId: AgentId;
    readonly lease?: Pick<RunLease, "generation" | "executorId" | "runId">;
    readonly model: string;
    readonly provider: string;
  }): SessionEpoch {
    const now = this.timestamp();
    return this.database.transaction(() => {
      const agent = this.mustAgent(input.agentId);
      if (input.lease !== undefined) {
        if (agent.runId !== input.lease.runId) {
          throw new LeaseFencedError(
            input.lease.runId,
            "Session epoch agent belongs to another Run.",
          );
        }
        this.assertLeaseInternal(input.lease, now);
      }
      const existing = this.database.get(
        "SELECT MAX(ordinal) AS ordinal FROM session_epochs WHERE agent_id = ?",
        input.agentId,
      );
      const ordinal =
        existing === undefined || existing.ordinal === null
          ? 1
          : asNumber(existing, "ordinal") + 1;
      const id = createId("session-epoch", `${agent.id}:${ordinal}`);
      this.database.run(
        `INSERT INTO session_epochs (id, agent_id, ordinal, provider, model, started_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        agent.id,
        ordinal,
        input.provider,
        input.model,
        now,
        now,
        now,
      );
      return this.sessionEpochFromRow(
        this.database.get("SELECT * FROM session_epochs WHERE id = ?", id) ??
          {},
      );
    });
  }

  public endSessionEpoch(input: {
    readonly id: SessionEpoch["id"];
    readonly lease?: Pick<RunLease, "generation" | "executorId" | "runId">;
    readonly reason: Exclude<SessionEpoch["endReason"], undefined>;
  }): SessionEpoch {
    const now = this.timestamp();
    return this.database.transaction(() => {
      if (input.lease !== undefined) {
        const owner = this.database.get(
          `SELECT agents.run_id FROM session_epochs
           JOIN agents ON agents.id = session_epochs.agent_id
           WHERE session_epochs.id = ?`,
          input.id,
        );
        if (
          owner === undefined ||
          asString(owner, "run_id") !== input.lease.runId
        ) {
          throw new LeaseFencedError(
            input.lease.runId,
            "Session epoch belongs to another Run.",
          );
        }
        this.assertLeaseInternal(input.lease, now);
      }
      this.database.run(
        "UPDATE session_epochs SET ended_at = ?, end_reason = ?, updated_at = ? WHERE id = ? AND ended_at IS NULL",
        now,
        input.reason,
        now,
        input.id,
      );
      const row = this.database.get(
        "SELECT * FROM session_epochs WHERE id = ?",
        input.id,
      );
      if (row === undefined)
        throw new Error(`Session epoch '${input.id}' was not found.`);
      return this.sessionEpochFromRow(row);
    });
  }

  public acquireResourceLocks(input: {
    readonly executorId: string;
    readonly runId: RunId;
    readonly scopes: readonly ResourceScope[];
    readonly taskId?: TaskId;
    readonly ttlMs: number;
  }): readonly string[] {
    const now = this.clock.now();
    const timestamp = now.toISOString();
    const expiresAt = new Date(now.getTime() + input.ttlMs).toISOString();
    return this.database.transaction(() => {
      this.database.run(
        "DELETE FROM resource_locks WHERE expires_at <= ?",
        timestamp,
      );
      // Locks are globally visible; scope identifiers are namespaced by the
      // workspace at the runtime boundary. This prevents two Runs from
      // writing the same checkout concurrently while allowing separate repos.
      const existing = this.database.all("SELECT * FROM resource_locks");
      for (const scope of input.scopes) {
        for (const lock of existing) {
          if (
            asString(lock, "holder_id") === input.executorId &&
            asString(lock, "run_id") === input.runId
          )
            continue;
          const lockScope: ResourceScope = {
            access: asOneOf(lock, "access_mode", ["read", "write"] as const),
            identifier: asString(lock, "identifier"),
            kind: asOneOf(lock, "kind", [
              "custom",
              "database",
              "deployment",
              "file",
              "git",
              "process",
              "repository",
              "service",
            ] as const),
          };
          if (resourceScopesConflict(scope, lockScope))
            throw new ResourceLockConflictError(scope);
        }
      }
      return input.scopes.map((scope, index) => {
        const id = `lock_${createId("event", `${input.runId}:${input.executorId}:${timestamp}:${index}`).split("_").at(-1) ?? index}`;
        this.database.run(
          `INSERT INTO resource_locks (id, run_id, task_id, holder_id, kind, identifier, access_mode, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          input.runId,
          input.taskId ?? null,
          input.executorId,
          scope.kind,
          scope.identifier,
          scope.access,
          expiresAt,
          timestamp,
        );
        return id;
      });
    });
  }

  public releaseResourceLocks(executorId: string, runId: RunId): void {
    this.database.run(
      "DELETE FROM resource_locks WHERE holder_id = ? AND run_id = ?",
      executorId,
      runId,
    );
  }

  public recordUsage(runId: RunId, delta: BudgetDelta): Run {
    const now = this.timestamp();
    return this.database.transaction(() => {
      return this.recordUsageInternal(runId, delta, now);
    });
  }

  public recordUsageFenced(
    lease: Pick<RunLease, "generation" | "executorId" | "runId">,
    delta: BudgetDelta,
  ): Run {
    const now = this.timestamp();
    return this.database.transaction(() => {
      this.assertLeaseInternal(lease, now);
      return this.recordUsageInternal(lease.runId, delta, now);
    });
  }

  public recordToolIntent(input: ToolIntentInput): string {
    const now = this.timestamp();
    const id = createId("tool-call", `${input.lease.runId}:${randomUUID()}`);
    let budgetExhausted = false;
    this.database.transaction(() => {
      this.assertLeaseInternal(input.lease, now);
      const budgeted = this.recordUsageInternal(
        input.lease.runId,
        { toolCalls: 1 },
        now,
      );
      if (
        budgeted.status === "budget_limited" ||
        budgeted.status === "usage_limited"
      ) {
        budgetExhausted = true;
        return;
      }
      if (input.approvalId !== undefined) {
        const approval = this.mustApproval(input.approvalId);
        if (
          approval.runId !== input.lease.runId ||
          approval.status !== "approved"
        ) {
          throw new Error(
            `Approval '${input.approvalId}' is not an approved authorization for this Run.`,
          );
        }
        this.database.run(
          "UPDATE approvals SET status = 'consumed', updated_at = ? WHERE id = ? AND status = 'approved'",
          now,
          input.approvalId,
        );
        this.appendEventInternal(
          input.lease.runId,
          "approval.resolved",
          {
            approvalId: input.approvalId,
            status: "consumed",
            reason: "tool_call_authorized",
          },
          now,
          input.lease.generation,
        );
      }
      this.database.run(
        `INSERT INTO tool_calls (id, run_id, agent_id, task_id, name, side_effect_class, idempotency, recovery, status, input_json, lease_generation, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
        id,
        input.lease.runId,
        input.agentId ?? null,
        input.taskId ?? null,
        input.definition.name,
        input.definition.sideEffectClass,
        input.definition.idempotency,
        input.definition.recovery,
        stringify(input.input),
        input.lease.generation,
        now,
      );
      this.appendEventInternal(
        input.lease.runId,
        "tool.call_started",
        { name: input.definition.name, toolCallId: id },
        now,
        input.lease.generation,
      );
    });
    if (budgetExhausted) {
      throw new Error(
        `Run '${input.lease.runId}' cannot begin another tool call because its budget is exhausted.`,
      );
    }
    return id;
  }

  public completeToolCall(input: {
    readonly error?: JsonObject;
    readonly lease: Pick<RunLease, "generation" | "executorId" | "runId">;
    readonly output?: JsonValue;
    readonly toolCallId: string;
  }): void {
    const now = this.timestamp();
    this.database.transaction(() => {
      this.assertLeaseInternal(input.lease, now);
      this.database.run(
        `UPDATE tool_calls SET status = ?, output_json = ?, error_json = ?, completed_at = ?
         WHERE id = ? AND run_id = ? AND lease_generation = ?`,
        input.error === undefined ? "succeeded" : "failed",
        input.output === undefined ? null : stringify(input.output),
        input.error === undefined ? null : stringify(input.error),
        now,
        input.toolCallId,
        input.lease.runId,
        input.lease.generation,
      );
      this.appendEventInternal(
        input.lease.runId,
        "tool.call_finished",
        {
          toolCallId: input.toolCallId,
          success: input.error === undefined,
          ...(input.output === undefined ? {} : { output: input.output }),
          ...(input.error === undefined ? {} : { error: input.error }),
        },
        now,
        input.lease.generation,
      );
    });
  }

  public reconcileInterruptedToolCalls(
    runId: RunId,
  ): readonly UnknownToolCall[] {
    const now = this.timestamp();
    return this.database.transaction(() => {
      const rows = this.database.all(
        "SELECT * FROM tool_calls WHERE run_id = ? AND status = 'running'",
        runId,
      );
      const calls = rows.map((row) => ({
        id: asString(row, "id"),
        idempotency: asOneOf(row, "idempotency", [
          "conditional",
          "safe",
          "unsafe",
        ] as const),
        name: asString(row, "name"),
        recovery: asOneOf(row, "recovery", [
          "manual",
          "reconcile",
          "retry",
        ] as const),
        runId: asString(row, "run_id") as RunId,
        sideEffectClass: asOneOf(row, "side_effect_class", [
          "destructive",
          "external",
          "none",
          "workspace",
        ] as const),
      }));
      for (const call of calls) {
        this.database.run(
          "UPDATE tool_calls SET status = 'unknown_after_crash', completed_at = ? WHERE id = ?",
          now,
          call.id,
        );
      }
      if (calls.length > 0)
        this.appendEventInternal(
          runId,
          "recovery.required",
          { unknownToolCallIds: calls.map(({ id }) => id) },
          now,
        );
      return calls;
    });
  }

  /**
   * Reconciles work left behind by an older lease generation after a daemon
   * restart/takeover. We never re-run an unmatched tool call blindly: it is
   * made visible as `unknown_after_crash` for the recovery policy to decide.
   */
  public recoverClaimedWork(
    lease: Pick<RunLease, "generation" | "executorId" | "runId">,
  ): readonly UnknownToolCall[] {
    const now = this.timestamp();
    return this.database.transaction(() => {
      this.assertLeaseInternal(lease, now);
      this.database.run(
        `UPDATE scheduled_actions
         SET status = 'pending', claimed_by = NULL, claimed_epoch = NULL, updated_at = ?
         WHERE run_id = ? AND status = 'claimed' AND (claimed_epoch IS NULL OR claimed_epoch < ?)`,
        now,
        lease.runId,
        lease.generation,
      );
      const rows = this.database.all(
        `SELECT * FROM tool_calls
         WHERE run_id = ? AND status = 'running' AND lease_generation < ?`,
        lease.runId,
        lease.generation,
      );
      const calls = rows.map((row) => ({
        id: asString(row, "id"),
        idempotency: asOneOf(row, "idempotency", [
          "conditional",
          "safe",
          "unsafe",
        ] as const),
        name: asString(row, "name"),
        recovery: asOneOf(row, "recovery", [
          "manual",
          "reconcile",
          "retry",
        ] as const),
        runId: asString(row, "run_id") as RunId,
        sideEffectClass: asOneOf(row, "side_effect_class", [
          "destructive",
          "external",
          "none",
          "workspace",
        ] as const),
      }));
      for (const call of calls) {
        this.database.run(
          "UPDATE tool_calls SET status = 'unknown_after_crash', completed_at = ? WHERE id = ?",
          now,
          call.id,
        );
      }
      if (calls.length > 0) {
        this.appendEventInternal(
          lease.runId,
          "recovery.required",
          { unknownToolCallIds: calls.map(({ id }) => id) },
          now,
          lease.generation,
        );
      }
      return calls;
    });
  }

  public createCheckpoint(input: {
    readonly label: string;
    readonly manifest: JsonObject;
    readonly reason: string;
    readonly runId: RunId;
    readonly workspaceRef?: string;
  }): { readonly id: CheckpointId; readonly sequence: number } {
    const now = this.timestamp();
    return this.database.transaction(() => {
      const count = this.database.get(
        "SELECT COUNT(*) AS count FROM checkpoints WHERE run_id = ?",
        input.runId,
      );
      const sequence = (count === undefined ? 0 : asNumber(count, "count")) + 1;
      const id = createId(
        "checkpoint",
        `${input.runId}:${sequence}:${randomUUID()}`,
      );
      this.database.run(
        `INSERT INTO checkpoints (id, run_id, sequence, label, reason, workspace_ref, manifest_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.runId,
        sequence,
        input.label,
        input.reason,
        input.workspaceRef ?? null,
        stringify(input.manifest),
        now,
      );
      this.appendEventInternal(
        input.runId,
        "checkpoint.created",
        { checkpointId: id, sequence },
        now,
      );
      return { id, sequence };
    });
  }

  public scheduleWake(input: {
    readonly lease?: Pick<RunLease, "generation" | "executorId" | "runId">;
    readonly runId: RunId;
    readonly wakeAt: Date;
  }): string {
    const now = this.timestamp();
    const id = `wake_${randomUUID()}`;
    this.database.transaction(() => {
      if (input.lease !== undefined) {
        if (input.lease.runId !== input.runId)
          throw new LeaseFencedError(
            input.runId,
            "Wake lease belongs to another Run.",
          );
        this.assertLeaseInternal(input.lease, now);
      }
      this.database.run(
        `INSERT INTO wake_conditions (id, run_id, kind, wake_at, status, created_at, updated_at)
         VALUES (?, ?, 'timer', ?, 'pending', ?, ?)`,
        id,
        input.runId,
        input.wakeAt.toISOString(),
        now,
        now,
      );
      const run = this.mustRun(input.runId);
      if (run.status === "running")
        this.transitionRunInternal(run.id, "waiting_external", now);
    });
    return id;
  }

  public wakeDueRuns(): readonly RunId[] {
    const now = this.timestamp();
    return this.database.transaction(() => {
      const conditions = this.database.all(
        "SELECT * FROM wake_conditions WHERE status = 'pending' AND wake_at IS NOT NULL AND wake_at <= ?",
        now,
      );
      const runIds: RunId[] = [];
      for (const condition of conditions) {
        const runId = asString(condition, "run_id") as RunId;
        this.database.run(
          "UPDATE wake_conditions SET status = 'woken', updated_at = ? WHERE id = ?",
          now,
          asString(condition, "id"),
        );
        const run = this.mustRun(runId);
        if (run.status === "waiting_external")
          this.transitionRunInternal(runId, "running", now);
        this.ensureContinuationInternal(runId, now);
        runIds.push(runId);
      }
      return runIds;
    });
  }

  public claimContinuation(
    lease: Pick<RunLease, "generation" | "executorId" | "runId">,
  ): ScheduledAction | undefined {
    const now = this.timestamp();
    return this.database.transaction(() => {
      this.assertLeaseInternal(lease, now);
      const action = this.database.get(
        "SELECT * FROM scheduled_actions WHERE run_id = ? AND status = 'pending' AND due_at <= ?",
        lease.runId,
        now,
      );
      if (action === undefined) return undefined;
      const run = this.mustRun(lease.runId);
      const goal =
        run.currentGoalId === undefined
          ? undefined
          : this.getGoal(run.currentGoalId);
      if (
        run.status !== "running" ||
        goal === undefined ||
        !shouldContinueGoal(goal.status)
      )
        return undefined;
      this.database.run(
        "UPDATE scheduled_actions SET status = 'claimed', claimed_by = ?, claimed_epoch = ?, attempt = attempt + 1, updated_at = ? WHERE run_id = ? AND status = 'pending'",
        lease.executorId,
        lease.generation,
        now,
        lease.runId,
      );
      this.database.run(
        "UPDATE goals SET continuation_count = continuation_count + 1, updated_at = ? WHERE id = ?",
        now,
        goal.id,
      );
      return {
        actionType: "continue_goal",
        attempt: asNumber(action, "attempt") + 1,
        runId: lease.runId,
      };
    });
  }

  public settleContinuation(input: {
    readonly lease: Pick<RunLease, "generation" | "executorId" | "runId">;
    readonly requeue: boolean;
  }): void {
    const now = this.timestamp();
    this.database.transaction(() => {
      this.assertLeaseInternal(input.lease, now);
      this.database.run(
        "DELETE FROM scheduled_actions WHERE run_id = ? AND status = 'claimed' AND claimed_by = ? AND claimed_epoch = ?",
        input.lease.runId,
        input.lease.executorId,
        input.lease.generation,
      );
      if (input.requeue)
        this.ensureContinuationInternal(input.lease.runId, now);
    });
  }

  public close(): void {
    this.database.close();
  }

  private transitionRunInternal(
    runId: RunId,
    to: RunStatus,
    now: string,
    reason?: string,
  ): void {
    const run = this.mustRun(runId);
    assertRunTransition(run.status, to);
    this.database.run(
      `UPDATE runs SET status = ?, blocked_reason = ?, completed_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
      to,
      reason ?? null,
      to === "completed" || to === "cancelled" || to === "failed" ? now : null,
      now,
      run.id,
    );
    this.appendEventInternal(
      run.id,
      "run.status_changed",
      { from: run.status, to },
      now,
    );
  }

  private transitionAgentInternal(
    agentId: AgentId,
    to: AgentStatus,
    now: string,
  ): Agent {
    const agent = this.mustAgent(agentId);
    assertAgentTransition(agent.status, to);
    this.database.run(
      "UPDATE agents SET status = ?, closed_at = ?, updated_at = ? WHERE id = ?",
      to,
      to === "closed" ? now : null,
      now,
      agent.id,
    );
    this.appendEventInternal(
      agent.runId,
      "agent.status_changed",
      { agentId: agent.id, to },
      now,
    );
    return this.mustAgent(agent.id);
  }

  private appendEventInternal(
    runId: RunId,
    type: RunEventType,
    payload: JsonObject,
    now: string,
    leaseGeneration?: number,
  ): RunEvent {
    const run = this.mustRun(runId);
    const sequence = this.database.get(
      "SELECT next_sequence FROM runs WHERE id = ?",
      runId,
    );
    const next =
      sequence === undefined ? 1 : asNumber(sequence, "next_sequence") + 1;
    const id = createId("event", `${runId}:${next}:${randomUUID()}`);
    this.database.run(
      `INSERT INTO run_events (id, run_id, seq, type, payload_json, lease_generation, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      runId,
      next,
      type,
      stringify(payload),
      leaseGeneration ?? null,
      now,
    );
    this.database.run(
      "UPDATE runs SET next_sequence = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
      next,
      now,
      run.id,
    );
    return {
      createdAt: now,
      id,
      payload,
      runId,
      sequence: next,
      type,
      updatedAt: now,
    };
  }

  private ensureContinuationInternal(runId: RunId, now: string): void {
    const run = this.mustRun(runId);
    if (run.status !== "running" || run.currentGoalId === undefined) return;
    const goal = this.mustGoal(run.currentGoalId);
    if (!shouldContinueGoal(goal.status)) return;
    this.database.run(
      `INSERT INTO scheduled_actions (run_id, action_type, due_at, status, created_at, updated_at)
       VALUES (?, 'continue_goal', ?, 'pending', ?, ?)
       ON CONFLICT(run_id) DO NOTHING`,
      runId,
      now,
      now,
      now,
    );
  }

  private refreshTaskReadinessInternal(runId: RunId, now: string): void {
    const pending = this.database.all(
      "SELECT * FROM tasks WHERE run_id = ? AND status = 'pending'",
      runId,
    );
    for (const row of pending) {
      const taskId = asString(row, "id");
      const incomplete = this.database.get(
        `SELECT dependency_id FROM task_dependencies d
         JOIN tasks dependency ON dependency.id = d.dependency_id
         WHERE d.task_id = ? AND dependency.status != 'completed' LIMIT 1`,
        taskId,
      );
      if (incomplete === undefined) {
        this.database.run(
          "UPDATE tasks SET status = 'ready', updated_at = ? WHERE id = ?",
          now,
          taskId,
        );
        this.appendEventInternal(
          runId,
          "task.status_changed",
          { taskId, to: "ready" },
          now,
        );
      }
    }
  }

  private recordUsageInternal(
    runId: RunId,
    delta: BudgetDelta,
    now: string,
  ): Run {
    const run = this.mustRun(runId);
    const usage = addBudgetUsage(run.usage, delta);
    const assessment = evaluateBudget(run.budget, usage);
    this.database.run(
      "UPDATE runs SET usage_json = ?, updated_at = ? WHERE id = ?",
      stringify(usage),
      now,
      run.id,
    );
    if (!assessment.allowed && run.status === "running") {
      this.transitionRunInternal(run.id, "budget_limited", now);
    }
    return this.mustRun(run.id);
  }

  private assertLeaseInternal(
    lease: Pick<RunLease, "generation" | "executorId" | "runId">,
    now: string,
  ): void {
    const current = this.database.get(
      "SELECT * FROM run_leases WHERE run_id = ?",
      lease.runId,
    );
    if (current === undefined)
      throw new LeaseFencedError(lease.runId, "Run has no active lease.");
    if (
      asString(current, "holder_id") !== lease.executorId ||
      asNumber(current, "generation") !== lease.generation ||
      asString(current, "expires_at") <= now
    ) {
      throw new LeaseFencedError(
        lease.runId,
        "Executor lease is stale or expired.",
      );
    }
  }

  private mustRun(runId: RunId): Run {
    const run = this.getRun(runId);
    if (run === undefined) throw new Error(`Run '${runId}' was not found.`);
    return run;
  }

  private mustGoal(goalId: GoalId): Goal {
    const goal = this.getGoal(goalId);
    if (goal === undefined) throw new Error(`Goal '${goalId}' was not found.`);
    return goal;
  }

  private mustTask(taskId: TaskId): Task {
    const row = this.database.get("SELECT * FROM tasks WHERE id = ?", taskId);
    if (row === undefined) throw new Error(`Task '${taskId}' was not found.`);
    return this.taskFromRow(row);
  }

  private mustAgent(agentId: AgentId): Agent {
    const row = this.database.get("SELECT * FROM agents WHERE id = ?", agentId);
    if (row === undefined) throw new Error(`Agent '${agentId}' was not found.`);
    return this.agentFromRow(row);
  }

  private mustLease(runId: RunId): RunLease {
    const row = this.database.get(
      "SELECT * FROM run_leases WHERE run_id = ?",
      runId,
    );
    if (row === undefined)
      throw new Error(`Lease for Run '${runId}' was not found.`);
    const now = asString(row, "updated_at");
    return {
      createdAt: asString(row, "created_at"),
      expiresAt: asString(row, "expires_at"),
      executorId: asString(row, "holder_id"),
      generation: asNumber(row, "generation"),
      heartbeatAt: asString(row, "heartbeat_at"),
      host: optionalString(row, "host") ?? "unknown",
      id: asString(row, "id") as RunLease["id"],
      process: String(optionalNumber(row, "process_id") ?? "unknown"),
      runId: asString(row, "run_id") as RunId,
      updatedAt: now,
    };
  }

  private mustMilestone(id: MilestoneId): Milestone {
    const row = this.database.get("SELECT * FROM milestones WHERE id = ?", id);
    if (row === undefined) throw new Error(`Milestone '${id}' was not found.`);
    return this.milestoneFromRow(row);
  }

  private mustDecision(id: DecisionId): Decision {
    const row = this.database.get("SELECT * FROM decisions WHERE id = ?", id);
    if (row === undefined) throw new Error(`Decision '${id}' was not found.`);
    return this.decisionFromRow(row);
  }

  private mustArtifact(id: ArtifactId): Artifact {
    const row = this.database.get("SELECT * FROM artifacts WHERE id = ?", id);
    if (row === undefined) throw new Error(`Artifact '${id}' was not found.`);
    return this.artifactFromRow(row);
  }

  private mustGitChange(id: GitChangeId): GitChange {
    const row = this.database.get("SELECT * FROM git_changes WHERE id = ?", id);
    if (row === undefined) throw new Error(`GitChange '${id}' was not found.`);
    return this.gitChangeFromRow(row);
  }

  private mustCostRecord(id: CostRecordId): CostRecord {
    const row = this.database.get(
      "SELECT * FROM cost_records WHERE id = ?",
      id,
    );
    if (row === undefined) throw new Error(`CostRecord '${id}' was not found.`);
    return this.costRecordFromRow(row);
  }

  private mustRecoveryState(runId: RunId): RecoveryState {
    const row = this.database.get(
      "SELECT * FROM recovery_states WHERE run_id = ?",
      runId,
    );
    if (row === undefined)
      throw new Error(`RecoveryState for Run '${runId}' was not found.`);
    return this.recoveryStateFromRow(row);
  }

  private mustContextSnapshot(id: ContextSnapshotId): ContextSnapshot {
    const row = this.database.get(
      "SELECT * FROM context_snapshots WHERE id = ?",
      id,
    );
    if (row === undefined)
      throw new Error(`ContextSnapshot '${id}' was not found.`);
    return this.contextSnapshotFromRow(row);
  }

  private mustMemoryEntry(id: MemoryEntryId): MemoryEntry {
    const row = this.database.get(
      "SELECT * FROM memory_entries WHERE id = ?",
      id,
    );
    if (row === undefined)
      throw new Error(`MemoryEntry '${id}' was not found.`);
    return this.memoryEntryFromRow(row);
  }

  private mustApproval(id: ApprovalId): Approval {
    const row = this.database.get("SELECT * FROM approvals WHERE id = ?", id);
    if (row === undefined) throw new Error(`Approval '${id}' was not found.`);
    return this.approvalFromRow(row);
  }

  private blockRunForProblemInternal(
    runId: RunId,
    fingerprint: string,
    now: string,
  ): void {
    const run = this.mustRun(runId);
    if (run.currentGoalId !== undefined) {
      const goal = this.mustGoal(run.currentGoalId);
      if (goal.status === "active" || goal.status === "waiting_external") {
        this.database.run(
          `UPDATE goals
           SET status = 'blocked', blocker_fingerprint = ?, blocker_audit_epoch = blocker_audit_epoch + 1, updated_at = ?
           WHERE id = ?`,
          fingerprint,
          now,
          goal.id,
        );
        this.appendEventInternal(
          runId,
          "goal.status_changed",
          { goalId: goal.id, to: "blocked" },
          now,
        );
      }
    }
    if (["running", "waiting_external", "recovering"].includes(run.status)) {
      this.transitionRunInternal(
        runId,
        "blocked",
        now,
        `Repeated blocker: ${fingerprint}`,
      );
    }
  }

  private milestoneFromRow(row: SqlRow): Milestone {
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
      taskIds: this.database
        .all(
          "SELECT task_id FROM milestone_tasks WHERE milestone_id = ? ORDER BY task_id",
          id,
        )
        .map((item) => asString(item, "task_id") as TaskId),
      title: asString(row, "title"),
      updatedAt: asString(row, "updated_at"),
    };
  }

  private decisionFromRow(row: SqlRow): Decision {
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

  private problemFromRow(row: SqlRow): Problem {
    return {
      alternateActionAvailable:
        asNumber(row, "alternate_action_available") === 1,
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

  private artifactFromRow(row: SqlRow): Artifact {
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

  private gitChangeFromRow(row: SqlRow): GitChange {
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

  private costRecordFromRow(row: SqlRow): CostRecord {
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

  private recoveryStateFromRow(row: SqlRow): RecoveryState {
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

  private contextSnapshotFromRow(row: SqlRow): ContextSnapshot {
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

  private memoryEntryFromRow(row: SqlRow): MemoryEntry {
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

  private approvalFromRow(row: SqlRow): Approval {
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
            toolCallId: toolCallId as Exclude<
              Approval["toolCallId"],
              undefined
            >,
          }),
      ...(resolvedAt === undefined ? {} : { resolvedAt }),
      ...(resolverId === undefined ? {} : { resolverId }),
    };
  }

  private runFromRow(row: SqlRow): Run {
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

  private missionFromRow(row: SqlRow): Mission {
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

  private goalFromRow(row: SqlRow): Goal {
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

  private taskFromRow(row: SqlRow): Task {
    const status = asString(row, "status");
    if (!isTaskStatus(status))
      throw new Error(`Invalid persisted Task status '${status}'.`);
    const id = asString(row, "id") as TaskId;
    const goalId = optionalString(row, "goal_id");
    const ownerAgentId = optionalString(row, "owner_agent_id");
    const resultJson = optionalString(row, "result_json");
    const completedAt = optionalString(row, "completed_at");
    return {
      blockerIds: this.database
        .all(
          "SELECT problem_id FROM task_problems WHERE task_id = ? ORDER BY problem_id",
          id,
        )
        .map((problem) => asString(problem, "problem_id") as ProblemId),
      createdAt: asString(row, "created_at"),
      dependencyIds: this.database
        .all(
          "SELECT dependency_id FROM task_dependencies WHERE task_id = ? ORDER BY dependency_id",
          id,
        )
        .map((dependency) => asString(dependency, "dependency_id") as TaskId),
      description: asString(row, "description"),
      evidenceIds: this.database
        .all(
          "SELECT evidence_id FROM task_evidence WHERE task_id = ? ORDER BY evidence_id",
          id,
        )
        .map(
          (evidence) =>
            asString(evidence, "evidence_id") as Task["evidenceIds"][number],
        ),
      id,
      requirementIds: this.database
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
      resourceScopes: this.database
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
    };
  }

  private agentFromRow(row: SqlRow): Agent {
    const status = asString(row, "status");
    if (!isAgentStatus(status))
      throw new Error(`Invalid persisted Agent status '${status}'.`);
    const id = asString(row, "id") as AgentId;
    const taskId = optionalString(row, "task_id");
    const worktreeUri = optionalString(row, "worktree_uri");
    const closedAt = optionalString(row, "closed_at");
    const parentAgentId = this.parentAgentId(id);
    return {
      createdAt: asString(row, "created_at"),
      id,
      permissions: parseJson<PermissionPolicy>(
        asString(row, "permissions_json"),
      ),
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
      sessionEpochIds: this.database
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

  private parentAgentId(agentId: AgentId): AgentId | undefined {
    const edge = this.database.get(
      "SELECT parent_agent_id FROM agent_edges WHERE child_agent_id = ?",
      agentId,
    );
    return edge === undefined
      ? undefined
      : (asString(edge, "parent_agent_id") as AgentId);
  }

  private eventFromRow(row: SqlRow): RunEvent {
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

  private sessionEpochFromRow(row: SqlRow): SessionEpoch {
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
            endReason: endReason as Exclude<
              SessionEpoch["endReason"],
              undefined
            >,
          }),
    };
  }

  private timestamp(): string {
    return this.clock.now().toISOString();
  }
}

function asString(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string")
    throw new Error(`Expected persisted column '${key}' to be a string.`);
  return value;
}

function optionalString(row: SqlRow, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string")
    throw new Error(
      `Expected persisted column '${key}' to be a nullable string.`,
    );
  return value;
}

function asNumber(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number")
    throw new Error(`Expected persisted column '${key}' to be a number.`);
  return value;
}

function optionalNumber(row: SqlRow, key: string): number | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number")
    throw new Error(
      `Expected persisted column '${key}' to be a nullable number.`,
    );
  return value;
}

function asOneOf<Value extends string>(
  row: SqlRow,
  key: string,
  values: readonly Value[],
): Value {
  const value = asString(row, key);
  if (!values.includes(value as Value))
    throw new Error(`Unexpected persisted value '${value}' for '${key}'.`);
  return value as Value;
}

function parseJson<Value>(value: string): Value {
  return JSON.parse(value) as Value;
}

function stringify(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new Error("Unable to serialize durable value.");
  return encoded;
}

function summarizeTitle(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  return normalized.length <= 96 ? normalized : `${normalized.slice(0, 93)}...`;
}
