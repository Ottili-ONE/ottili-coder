import type { JsonValue } from "@ottili/protocol";

export type DomainErrorCode =
  | "invalid_state_transition"
  | "invalid_identifier"
  | "invalid_invariant"
  | "budget_exceeded"
  | "permission_denied"
  | "resource_conflict"
  | "stale_lease_generation"
  | "blocker_threshold_not_met";

/** Base class for predictable, serialisable domain failures. */
export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Readonly<Record<string, JsonValue>>;

  constructor(
    code: DomainErrorCode,
    message: string,
    details: Readonly<Record<string, JsonValue>> = {},
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export class InvalidStateTransitionError extends DomainError {
  constructor(entity: string, from: string, to: string) {
    super(
      "invalid_state_transition",
      `Cannot transition ${entity} from '${from}' to '${to}'`,
      { entity, from, to },
    );
  }
}

export class InvalidIdentifierError extends DomainError {
  constructor(kind: string, value: unknown) {
    super("invalid_identifier", `Invalid ${kind} identifier`, {
      kind,
      value: typeof value === "string" ? value : String(value),
    });
  }
}

export class InvariantViolationError extends DomainError {
  constructor(
    message: string,
    details: Readonly<Record<string, JsonValue>> = {},
  ) {
    super("invalid_invariant", message, details);
  }
}

export class BudgetExceededError extends DomainError {
  constructor(limit: string, used: number, maximum: number) {
    super("budget_exceeded", `Budget limit '${limit}' has been exhausted`, {
      limit,
      used,
      maximum,
    });
  }
}

export class PermissionDeniedError extends DomainError {
  constructor(action: string, reason: string) {
    super("permission_denied", `Permission denied for '${action}': ${reason}`, {
      action,
      reason,
    });
  }
}

export class ResourceConflictError extends DomainError {
  constructor(left: string, right: string) {
    super(
      "resource_conflict",
      `Resource scopes conflict: '${left}' and '${right}'`,
      {
        left,
        right,
      },
    );
  }
}

export class StaleLeaseGenerationError extends DomainError {
  constructor(
    expectedGeneration: number,
    receivedGeneration: number,
    runId: string,
  ) {
    super(
      "stale_lease_generation",
      `Stale lease generation for run '${runId}': expected ${expectedGeneration}, received ${receivedGeneration}`,
      { expectedGeneration, receivedGeneration, runId },
    );
  }
}

export class BlockerThresholdNotMetError extends DomainError {
  constructor(fingerprint: string, attempts: number, threshold: number) {
    super(
      "blocker_threshold_not_met",
      `Blocker '${fingerprint}' has ${attempts}/${threshold} required meaningful attempts`,
      { fingerprint, attempts, threshold },
    );
  }
}
