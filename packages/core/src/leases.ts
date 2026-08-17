import type { RunLease, RunLeaseFence } from "@ottili/protocol";

import {
  InvariantViolationError,
  StaleLeaseGenerationError,
} from "./errors.js";

export interface LeaseTakeover {
  readonly executorId: string;
  readonly host: string;
  readonly process: string;
  readonly heartbeatAt: string;
  readonly expiresAt: string;
  readonly updatedAt: string;
}

/** Extracts the only fields an executor needs to fence a state-changing write. */
export function toRunLeaseFence(lease: RunLease): RunLeaseFence {
  return {
    executorId: lease.executorId,
    generation: lease.generation,
    runId: lease.runId,
  };
}

export function isLeaseExpired(lease: RunLease, now: string | Date): boolean {
  return (
    parseTimestamp(lease.expiresAt, "lease.expiresAt") <=
    toEpochMilliseconds(now, "now")
  );
}

/**
 * Creates the next durable lease generation during ownership transfer. The
 * caller persists this atomically before it lets the successor run work.
 */
export function takeOverRunLease(
  current: RunLease,
  successor: LeaseTakeover,
): RunLease {
  assertLeaseShape(current);
  assertTakeoverShape(successor);

  return {
    ...current,
    executorId: successor.executorId,
    expiresAt: successor.expiresAt,
    generation: current.generation + 1,
    heartbeatAt: successor.heartbeatAt,
    host: successor.host,
    process: successor.process,
    updatedAt: successor.updatedAt,
  };
}

/**
 * Accepts a write only from the current non-expired holder and exact fencing
 * generation. This is the guard that prevents a revived old daemon from
 * overwriting a newer executor's work.
 */
export function canWriteWithLease(
  active: RunLease,
  fence: RunLeaseFence,
  now: string | Date,
): boolean {
  return (
    !isLeaseExpired(active, now) &&
    active.runId === fence.runId &&
    active.executorId === fence.executorId &&
    active.generation === fence.generation
  );
}

export function assertLeaseWrite(
  active: RunLease,
  fence: RunLeaseFence,
  now: string | Date,
): void {
  assertLeaseShape(active);
  if (active.generation !== fence.generation) {
    throw new StaleLeaseGenerationError(
      active.generation,
      fence.generation,
      active.runId,
    );
  }
  if (active.runId !== fence.runId || active.executorId !== fence.executorId) {
    throw new StaleLeaseGenerationError(
      active.generation,
      fence.generation,
      active.runId,
    );
  }
  if (isLeaseExpired(active, now)) {
    throw new InvariantViolationError(
      "Cannot write using an expired Run lease",
      {
        executorId: active.executorId,
        generation: active.generation,
        runId: active.runId,
      },
    );
  }
}

function assertLeaseShape(lease: RunLease): void {
  if (!Number.isInteger(lease.generation) || lease.generation < 1) {
    throw new InvariantViolationError(
      "Run lease generation must be a positive integer",
      {
        generation: lease.generation,
      },
    );
  }
  parseTimestamp(lease.expiresAt, "lease.expiresAt");
  parseTimestamp(lease.heartbeatAt, "lease.heartbeatAt");
}

function assertTakeoverShape(successor: LeaseTakeover): void {
  if (successor.executorId.trim().length === 0) {
    throw new InvariantViolationError("Lease executorId must not be empty");
  }
  parseTimestamp(successor.expiresAt, "successor.expiresAt");
  parseTimestamp(successor.heartbeatAt, "successor.heartbeatAt");
}

function toEpochMilliseconds(value: string | Date, label: string): number {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new InvariantViolationError(`${label} must be a valid timestamp`);
    }
    return value.getTime();
  }
  return parseTimestamp(value, label);
}

function parseTimestamp(value: string, label: string): number {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new InvariantViolationError(`${label} must be a valid timestamp`, {
      value,
    });
  }
  return timestamp;
}
