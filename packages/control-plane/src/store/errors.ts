import type { ResourceScope, RunId } from "@ottili/core";

/** A durable write was rejected because the caller's lease is stale or expired. */
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
