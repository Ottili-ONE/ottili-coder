import { deterministicHash, type BlockerObservation } from "@ottili/protocol";

import {
  BlockerThresholdNotMetError,
  InvariantViolationError,
} from "./errors.js";

export const DEFAULT_BLOCKER_ATTEMPT_THRESHOLD = 3;

export interface BlockerAssessment {
  readonly fingerprint: string;
  readonly matchingMeaningfulAttempts: number;
  readonly requiredAttempts: number;
  readonly externalDependencyConfirmed: boolean;
  readonly noAlternateActionRemains: boolean;
  readonly eligibleForBlocked: boolean;
}

/**
 * Derives a durable fingerprint from material blocker facts. It deliberately
 * does not use time, agent IDs, or process IDs so repeated observations match.
 */
export function createBlockerFingerprint(material: string): string {
  if (material.trim().length === 0) {
    throw new InvariantViolationError("Blocker material must not be empty");
  }

  return `blocker_${deterministicHash(material.trim().toLowerCase())}`;
}

/**
 * Agents cannot declare a run blocked based on one failed turn. A blocker must
 * recur meaningfully, require external state, and have no useful alternate.
 */
export function assessBlocker(
  observations: readonly BlockerObservation[],
  fingerprint: string,
  threshold = DEFAULT_BLOCKER_ATTEMPT_THRESHOLD,
): BlockerAssessment {
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new InvariantViolationError(
      "Blocker threshold must be a positive integer",
      {
        threshold,
      },
    );
  }

  const matching = observations.filter(
    (observation) =>
      observation.fingerprint === fingerprint && observation.meaningful,
  );
  const externalDependencyConfirmed =
    matching.length > 0 &&
    matching.every((observation) => observation.externalDependency);
  const noAlternateActionRemains =
    matching.length > 0 &&
    matching.every((observation) => !observation.alternateActionAvailable);
  const matchingMeaningfulAttempts = matching.length;

  return {
    fingerprint,
    matchingMeaningfulAttempts,
    requiredAttempts: threshold,
    externalDependencyConfirmed,
    noAlternateActionRemains,
    eligibleForBlocked:
      matchingMeaningfulAttempts >= threshold &&
      externalDependencyConfirmed &&
      noAlternateActionRemains,
  };
}

export function assertBlockerCanBlock(
  observations: readonly BlockerObservation[],
  fingerprint: string,
  threshold = DEFAULT_BLOCKER_ATTEMPT_THRESHOLD,
): BlockerAssessment {
  const assessment = assessBlocker(observations, fingerprint, threshold);
  if (!assessment.eligibleForBlocked) {
    throw new BlockerThresholdNotMetError(
      assessment.fingerprint,
      assessment.matchingMeaningfulAttempts,
      assessment.requiredAttempts,
    );
  }

  return assessment;
}

/** A resume starts a fresh blocker audit instead of inheriting a stale count. */
export function resetBlockerAudit(): readonly BlockerObservation[] {
  return [];
}
