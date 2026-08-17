export {
  CheckpointNotFoundError,
  CheckpointPersistenceError,
  CheckpointRestoreInProgressError,
  CheckpointService,
  InMemoryCheckpointStore,
  type CheckpointFailure,
  type CheckpointRecord,
  type CheckpointState,
  type CheckpointStore,
  type CreateCheckpointInput,
  type RestoreLifecycle,
  type RestorePreparationFailed,
  type RestoreRollbackFailed,
  type RestoreRolledBack,
  type RestoreSucceeded,
  type RollbackReport,
  type TransactionalRestoreResult,
} from "./checkpoint.js";
export {
  classifyFailure,
  FailureClassifier,
  type FailureClassification,
  type FailureClassifierOptions,
  type FailureInput,
  type FailureKind,
  type FailureSource,
  type RecoveryAction,
} from "./failure.js";
export {
  mayRetryTool,
  planToolRecovery,
  type ToolRecoveryPlan,
  type ToolRecoveryPlanOptions,
} from "./tool-recovery.js";
export type {
  ToolDefinition,
  ToolIdempotency,
  ToolRecoveryDecision,
  ToolRecoveryPolicy,
  ToolRecoveryStrategy,
  ToolSideEffectClass,
} from "@ottili/protocol";
export { assertValidToolDefinition, decideToolRecovery } from "@ottili/core";
