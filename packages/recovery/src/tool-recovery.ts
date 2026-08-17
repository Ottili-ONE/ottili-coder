import { decideToolRecovery } from "@ottili/core";
import type { ToolDefinition, ToolRecoveryDecision } from "@ottili/protocol";

import type { FailureClassification } from "./failure.js";

export interface ToolRecoveryPlan {
  /** Core's side-effect/idempotency-safe disposition. */
  readonly decision: ToolRecoveryDecision;
  /** Whether execution may be attempted again in this recovery cycle. */
  readonly mayRetryNow: boolean;
  /** Observable reason when an otherwise retryable tool is held back. */
  readonly holdReason?: string;
}

export interface ToolRecoveryPlanOptions {
  /** Number of attempts already made for this exact tool input. */
  readonly attempts?: number;
  /** Bounded retries prevent transient loops from becoming an implicit plan. */
  readonly maxAttempts?: number;
}

/**
 * Adds failure-specific bounds to the core tool contract rule. In particular,
 * an external or destructive operation can never become retryable simply
 * because the raw error looked transient.
 */
export function planToolRecovery(
  tool: ToolDefinition,
  failure: FailureClassification,
  options: ToolRecoveryPlanOptions = {},
): ToolRecoveryPlan {
  // Registration rejects invalid contracts with assertValidToolDefinition, but
  // recovery must still make a safe choice for an old or malformed persisted
  // definition rather than throwing and abandoning a crashed run.
  const decision = decideToolRecovery(tool);
  const attempts = options.attempts ?? 0;
  const maxAttempts = options.maxAttempts ?? 2;
  if (!Number.isSafeInteger(attempts) || attempts < 0) {
    throw new TypeError("attempts must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError("maxAttempts must be a positive safe integer.");
  }

  if (decision.action !== "retry") {
    return {
      decision,
      mayRetryNow: false,
      holdReason: decision.reason,
    };
  }
  if (!failure.retryable) {
    return {
      decision,
      mayRetryNow: false,
      holdReason: `Failure class '${failure.kind}' is not retryable.`,
    };
  }
  if (!failure.actions.includes("retry")) {
    return {
      decision,
      mayRetryNow: false,
      holdReason: `Failure class '${failure.kind}' requires ${failure.actions.join(", ")} before retrying.`,
    };
  }
  if (attempts >= maxAttempts) {
    return {
      decision,
      mayRetryNow: false,
      holdReason: `Retry limit of ${maxAttempts} has been reached.`,
    };
  }
  return { decision, mayRetryNow: true };
}

/** A small explicit guard useful at tool dispatch boundaries. */
export function mayRetryTool(
  tool: ToolDefinition,
  failure: FailureClassification,
  options: ToolRecoveryPlanOptions = {},
): boolean {
  return planToolRecovery(tool, failure, options).mayRetryNow;
}
