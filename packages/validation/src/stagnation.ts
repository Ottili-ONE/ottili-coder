export interface ProgressAttempt {
  readonly blockerFingerprint?: string;
  readonly evidenceAdded: boolean;
  readonly meaningfulChange: boolean;
  readonly timestamp: string;
}

export type StagnationAction =
  "blocked" | "continue" | "fresh_agent" | "replan";

export interface StagnationAssessment {
  readonly action: StagnationAction;
  readonly repeatedBlockerCount: number;
  readonly reason: string;
}

/** Uses persisted attempt facts; an agent statement by itself never blocks a Run. */
export function assessStagnation(
  attempts: readonly ProgressAttempt[],
): StagnationAssessment {
  const last = attempts.at(-1);
  if (
    last === undefined ||
    last.meaningfulChange ||
    last.evidenceAdded ||
    last.blockerFingerprint === undefined
  ) {
    return {
      action: "continue",
      reason: "Recent progress or no material blocker is recorded.",
      repeatedBlockerCount: 0,
    };
  }
  let repeatedBlockerCount = 0;
  for (const attempt of [...attempts].reverse()) {
    if (
      attempt.blockerFingerprint !== last.blockerFingerprint ||
      attempt.evidenceAdded ||
      attempt.meaningfulChange
    ) {
      break;
    }
    repeatedBlockerCount += 1;
  }
  if (repeatedBlockerCount >= 3) {
    return {
      action: "blocked",
      reason:
        "The same material blocker recurred in three meaningful attempts with no recorded progress.",
      repeatedBlockerCount,
    };
  }
  return {
    action: repeatedBlockerCount === 2 ? "fresh_agent" : "replan",
    reason:
      "Repeated failure requires a changed strategy before another attempt.",
    repeatedBlockerCount,
  };
}
