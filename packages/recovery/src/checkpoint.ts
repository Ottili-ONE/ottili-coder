import { randomUUID } from "node:crypto";

import {
  GitService,
  isSamePath,
  recoverySnapshotRefFor,
  type GitCheckpointSnapshot,
} from "@ottili/workspace";

export interface CheckpointState {
  readonly runState?: unknown;
  readonly goals?: unknown;
  readonly taskGraphCursor?: unknown;
  readonly agentGraph?: unknown;
  readonly decisions?: unknown;
  readonly problems?: unknown;
  readonly requirements?: unknown;
  readonly evidence?: unknown;
  readonly sessionMetadata?: unknown;
  readonly usage?: unknown;
}

/** Durable metadata paired with a private Git snapshot. */
export interface CheckpointRecord<TState = CheckpointState> {
  readonly id: string;
  readonly runId: string;
  readonly sequence: number;
  readonly workspacePath: string;
  readonly gitRef: string;
  readonly gitSnapshot: GitCheckpointSnapshot;
  readonly state: TState;
  readonly createdAt: string;
}

export interface CreateCheckpointInput<TState> {
  readonly runId: string;
  readonly sequence: number;
  readonly state: TState;
  readonly id?: string;
  readonly message?: string;
}

export interface CheckpointStore<TState = CheckpointState> {
  save(record: CheckpointRecord<TState>): Promise<void>;
  get(id: string): Promise<CheckpointRecord<TState> | undefined>;
  list(runId: string): Promise<readonly CheckpointRecord<TState>[]>;
}

export interface RestoreLifecycle<TState, TRuntime = unknown> {
  /** Capture state owned by a control plane before its state is overwritten. */
  readonly capturePreRestoreState?: () => Promise<unknown> | unknown;
  /** Restore durable run/message state that accompanies the Git snapshot. */
  readonly restoreRunState?: (
    state: TState,
    checkpoint: CheckpointRecord<TState>,
  ) => Promise<void> | void;
  /** Revert control-plane state if a later restore phase fails. */
  readonly restorePreRestoreState?: (
    preRestoreState: unknown,
  ) => Promise<void> | void;
  /** Build a new executor only after workspace and durable state are restored. */
  readonly createResumedRuntime?: (
    checkpoint: CheckpointRecord<TState>,
  ) => Promise<TRuntime> | TRuntime;
  /** Required checks such as state/workspace consistency or lease validation. */
  readonly validateRestoredState?: (
    runtime: TRuntime | undefined,
    checkpoint: CheckpointRecord<TState>,
  ) => Promise<void> | void;
  /** Dispose a partially constructed runtime before rollback completes. */
  readonly disposeResumedRuntime?: (runtime: TRuntime) => Promise<void> | void;
}

export interface CheckpointFailure {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
}

export interface RollbackReport {
  readonly workspaceRestored: boolean;
  readonly runStateRestored: boolean;
  readonly resumedRuntimeDisposed: boolean;
  readonly errors: readonly CheckpointFailure[];
}

export interface RestoreSucceeded<TState, TRuntime> {
  readonly outcome: "restored";
  readonly checkpoint: CheckpointRecord<TState>;
  /** Retained private ref; callers may discard it only after they no longer need undo. */
  readonly preRestoreSnapshot: GitCheckpointSnapshot;
  readonly runtime: TRuntime | undefined;
}

export interface RestorePreparationFailed<TState> {
  readonly outcome: "preparation_failed";
  readonly checkpoint: CheckpointRecord<TState>;
  readonly error: CheckpointFailure;
}

export interface RestoreRolledBack<TState> {
  readonly outcome: "rolled_back";
  readonly checkpoint: CheckpointRecord<TState>;
  readonly preRestoreSnapshot: GitCheckpointSnapshot;
  readonly restoreError: CheckpointFailure;
  readonly rollback: RollbackReport;
}

export interface RestoreRollbackFailed<TState> {
  readonly outcome: "rollback_failed";
  readonly checkpoint: CheckpointRecord<TState>;
  readonly preRestoreSnapshot: GitCheckpointSnapshot;
  readonly restoreError: CheckpointFailure;
  readonly rollback: RollbackReport;
}

export type TransactionalRestoreResult<TState, TRuntime> =
  | RestoreSucceeded<TState, TRuntime>
  | RestorePreparationFailed<TState>
  | RestoreRolledBack<TState>
  | RestoreRollbackFailed<TState>;

export class CheckpointNotFoundError extends Error {
  public constructor(id: string) {
    super(`Checkpoint '${id}' does not exist.`);
    this.name = "CheckpointNotFoundError";
  }
}

export class CheckpointRestoreInProgressError extends Error {
  public constructor() {
    super(
      "A checkpoint restore is already in progress for this service instance.",
    );
    this.name = "CheckpointRestoreInProgressError";
  }
}

export class CheckpointPersistenceError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CheckpointPersistenceError";
  }
}

function failureFrom(error: unknown): CheckpointFailure {
  if (error instanceof Error) {
    const maybeCode = (error as Error & { readonly code?: unknown }).code;
    const code = typeof maybeCode === "string" ? maybeCode : undefined;
    return {
      name: error.name,
      message: error.message,
      ...(code === undefined ? {} : { code }),
    };
  }
  return { name: "UnknownError", message: String(error) };
}

function cloneRecord<TState>(
  record: CheckpointRecord<TState>,
): CheckpointRecord<TState> {
  return structuredClone(record);
}

/** A deterministic test/local adapter; production supplies a durable store. */
export class InMemoryCheckpointStore<
  TState = CheckpointState,
> implements CheckpointStore<TState> {
  private readonly records = new Map<string, CheckpointRecord<TState>>();

  public async save(record: CheckpointRecord<TState>): Promise<void> {
    this.records.set(record.id, cloneRecord(record));
  }

  public async get(id: string): Promise<CheckpointRecord<TState> | undefined> {
    const record = this.records.get(id);
    return record === undefined ? undefined : cloneRecord(record);
  }

  public async list(
    runId: string,
  ): Promise<readonly CheckpointRecord<TState>[]> {
    return [...this.records.values()]
      .filter((record) => record.runId === runId)
      .sort((left, right) => left.sequence - right.sequence)
      .map((record) => cloneRecord(record));
  }
}

/**
 * Couples Git private refs with durable run state and restores them transactionally.
 * A failed restore returns an observable rollback result instead of leaving the
 * caller to guess whether the workspace was partially changed.
 */
export class CheckpointService<TState = CheckpointState> {
  private restoreInProgress = false;

  public constructor(
    private readonly git: GitService,
    private readonly store: CheckpointStore<TState>,
  ) {}

  public async create(
    input: CreateCheckpointInput<TState>,
  ): Promise<CheckpointRecord<TState>> {
    if (input.id !== undefined && input.id.trim().length === 0) {
      throw new CheckpointPersistenceError("Checkpoint id cannot be empty.");
    }
    const [workspacePath, gitSnapshot] = await Promise.all([
      this.git.getRepositoryRoot(),
      this.git.captureCheckpoint({
        runId: input.runId,
        sequence: input.sequence,
        ...(input.message === undefined ? {} : { message: input.message }),
      }),
    ]);
    const record: CheckpointRecord<TState> = {
      id: input.id ?? `checkpoint_${randomUUID()}`,
      runId: input.runId,
      sequence: input.sequence,
      workspacePath,
      gitRef: gitSnapshot.ref,
      gitSnapshot,
      state: input.state,
      createdAt: new Date().toISOString(),
    };
    try {
      await this.store.save(record);
      return record;
    } catch (error: unknown) {
      try {
        await this.git.deletePrivateRef(gitSnapshot.ref);
      } catch {
        // The original persistence failure is more actionable. The leaked ref
        // remains private and can be discovered by the checkpoint maintenance job.
      }
      throw new CheckpointPersistenceError(
        "Checkpoint metadata could not be persisted.",
        error,
      );
    }
  }

  public async get(id: string): Promise<CheckpointRecord<TState> | undefined> {
    return this.store.get(id);
  }

  public async list(
    runId: string,
  ): Promise<readonly CheckpointRecord<TState>[]> {
    return this.store.list(runId);
  }

  /** Explicit cleanup keeps recovery backups available until the caller approves deletion. */
  public async discardPreRestoreSnapshot(
    snapshot: GitCheckpointSnapshot,
  ): Promise<void> {
    await this.git.deletePrivateRef(snapshot.ref);
  }

  public async restore<TRuntime = unknown>(
    checkpointId: string,
    lifecycle: RestoreLifecycle<TState, TRuntime> = {},
  ): Promise<TransactionalRestoreResult<TState, TRuntime>> {
    if (this.restoreInProgress) {
      throw new CheckpointRestoreInProgressError();
    }
    this.restoreInProgress = true;
    try {
      const checkpoint = await this.store.get(checkpointId);
      if (checkpoint === undefined) {
        throw new CheckpointNotFoundError(checkpointId);
      }

      // Compare locations, not strings: a checkpoint written before a
      // restart can carry a different spelling of the same directory
      // (symlinked parents on macOS, drive-letter case on Windows).
      const currentWorkspacePath = await this.git.getRepositoryRoot();
      if (!(await isSamePath(currentWorkspacePath, checkpoint.workspacePath))) {
        return {
          outcome: "preparation_failed",
          checkpoint,
          error: {
            name: "CheckpointWorkspaceMismatchError",
            message:
              "Checkpoint belongs to a different workspace and cannot be restored here.",
          },
        };
      }
      if (checkpoint.gitRef !== checkpoint.gitSnapshot.ref) {
        return {
          outcome: "preparation_failed",
          checkpoint,
          error: {
            name: "CheckpointMetadataMismatchError",
            message: "Checkpoint Git metadata is internally inconsistent.",
          },
        };
      }

      let preRestoreState: unknown;
      let hasPreRestoreState = false;
      let preRestoreSnapshot: GitCheckpointSnapshot;
      try {
        if (lifecycle.capturePreRestoreState !== undefined) {
          preRestoreState = await lifecycle.capturePreRestoreState();
          hasPreRestoreState = true;
        }
        preRestoreSnapshot = await this.git.captureWorkspaceSnapshot({
          ref: recoverySnapshotRefFor(checkpoint.runId, randomUUID()),
          message: `Ottili pre-restore backup for ${checkpoint.id}`,
        });
      } catch (error: unknown) {
        return {
          outcome: "preparation_failed",
          checkpoint,
          error: failureFrom(error),
        };
      }

      let runtime: TRuntime | undefined;
      let runStateRestoreAttempted = false;
      try {
        await this.git.restoreWorkspaceSnapshot(checkpoint.gitSnapshot);
        if (lifecycle.restoreRunState !== undefined) {
          runStateRestoreAttempted = true;
          await lifecycle.restoreRunState(checkpoint.state, checkpoint);
        }
        if (lifecycle.createResumedRuntime !== undefined) {
          runtime = await lifecycle.createResumedRuntime(checkpoint);
        }
        if (lifecycle.validateRestoredState !== undefined) {
          await lifecycle.validateRestoredState(runtime, checkpoint);
        }
        return {
          outcome: "restored",
          checkpoint,
          preRestoreSnapshot,
          runtime,
        };
      } catch (restoreFailure: unknown) {
        const rollbackErrors: CheckpointFailure[] = [];
        let resumedRuntimeDisposed = runtime === undefined;
        let workspaceRestored = true;
        let runStateRestored = !runStateRestoreAttempted;

        if (runtime !== undefined) {
          if (lifecycle.disposeResumedRuntime === undefined) {
            rollbackErrors.push({
              name: "CheckpointRuntimeCleanupUnavailableError",
              message:
                "A resumed runtime was created but no disposal hook was supplied for rollback.",
            });
          } else {
            try {
              await lifecycle.disposeResumedRuntime(runtime);
              resumedRuntimeDisposed = true;
            } catch (error: unknown) {
              rollbackErrors.push(failureFrom(error));
            }
          }
        }
        try {
          await this.git.restoreWorkspaceSnapshot(preRestoreSnapshot);
        } catch (error: unknown) {
          workspaceRestored = false;
          rollbackErrors.push(failureFrom(error));
        }
        if (runStateRestoreAttempted) {
          if (
            !hasPreRestoreState ||
            lifecycle.restorePreRestoreState === undefined
          ) {
            rollbackErrors.push({
              name: "CheckpointRunStateRollbackUnavailableError",
              message:
                "Run state restoration was attempted but no recoverable pre-restore state hook was supplied.",
            });
          } else {
            try {
              await lifecycle.restorePreRestoreState(preRestoreState);
              runStateRestored = true;
            } catch (error: unknown) {
              rollbackErrors.push(failureFrom(error));
            }
          }
        }

        const rollback: RollbackReport = {
          workspaceRestored,
          runStateRestored,
          resumedRuntimeDisposed,
          errors: rollbackErrors,
        };
        const base = {
          checkpoint,
          preRestoreSnapshot,
          restoreError: failureFrom(restoreFailure),
          rollback,
        };
        if (workspaceRestored && runStateRestored && resumedRuntimeDisposed) {
          return { outcome: "rolled_back", ...base };
        }
        return { outcome: "rollback_failed", ...base };
      }
    } finally {
      this.restoreInProgress = false;
    }
  }
}
