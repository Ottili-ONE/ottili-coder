export type FailureSource =
  | "provider"
  | "tool"
  | "daemon"
  | "git"
  | "runtime"
  | "external"
  | "budget"
  | "unknown";

export type FailureKind =
  | "provider_timeout"
  | "rate_limited"
  | "context_exhausted"
  | "model_unavailable"
  | "tool_deterministic"
  | "tool_transient"
  | "daemon_crash"
  | "git_conflict"
  | "repeated_failure"
  | "external_pending"
  | "budget_exhausted"
  | "unknown";

export type RecoveryAction =
  | "retry"
  | "alternate_provider"
  | "wait"
  | "compact_context"
  | "new_session_epoch"
  | "switch_model"
  | "debug_tool"
  | "takeover_lease"
  | "resume_checkpoint"
  | "resolve_git_conflict"
  | "replan"
  | "fresh_debugger"
  | "waiting_external"
  | "budget_limited"
  | "manual_review";

export interface FailureInput {
  readonly error?: unknown;
  /** Optional message for callers that do not retain an Error instance. */
  readonly message?: string;
  readonly source?: FailureSource;
  readonly code?: string;
  readonly statusCode?: number;
  /** Number of equivalent failures, including this one. */
  readonly identicalFailureCount?: number;
  readonly retryAfterMs?: number;
}

export interface FailureClassification {
  readonly kind: FailureKind;
  readonly source: FailureSource;
  readonly retryable: boolean;
  readonly actions: readonly RecoveryAction[];
  readonly reason: string;
  readonly retryAfterMs?: number;
}

export interface FailureClassifierOptions {
  readonly repeatedFailureThreshold?: number;
}

interface ErrorLike {
  readonly message?: unknown;
  readonly code?: unknown;
  readonly name?: unknown;
}

function lower(value: string | undefined): string {
  return value?.toLowerCase() ?? "";
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name} ${error.message}`.toLowerCase();
  }
  if (typeof error === "object" && error !== null) {
    const maybeError = error as ErrorLike;
    const message =
      typeof maybeError.message === "string" ? maybeError.message : "";
    const code = typeof maybeError.code === "string" ? maybeError.code : "";
    const name = typeof maybeError.name === "string" ? maybeError.name : "";
    return `${name} ${code} ${message}`.toLowerCase();
  }
  return typeof error === "string" ? error.toLowerCase() : "";
}

function effectiveCode(input: FailureInput): string {
  if (input.code !== undefined) {
    return lower(input.code);
  }
  if (typeof input.error === "object" && input.error !== null) {
    const candidate = (input.error as ErrorLike).code;
    if (typeof candidate === "string") {
      return lower(candidate);
    }
  }
  return "";
}

function containsAny(text: string, needles: readonly string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

function classification(
  kind: FailureKind,
  source: FailureSource,
  retryable: boolean,
  actions: readonly RecoveryAction[],
  reason: string,
  retryAfterMs?: number,
): FailureClassification {
  return {
    kind,
    source,
    retryable,
    actions,
    reason,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

/**
 * Translates raw provider/tool/daemon errors into explicit, persisted recovery
 * intent. The caller records this result; it does not hide a failure by retrying
 * within the classifier itself.
 */
export class FailureClassifier {
  private readonly repeatedFailureThreshold: number;

  public constructor(options: FailureClassifierOptions = {}) {
    const threshold = options.repeatedFailureThreshold ?? 3;
    if (!Number.isSafeInteger(threshold) || threshold < 2) {
      throw new TypeError(
        "repeatedFailureThreshold must be a safe integer of at least 2.",
      );
    }
    this.repeatedFailureThreshold = threshold;
  }

  public classify(input: FailureInput): FailureClassification {
    const source = input.source ?? "unknown";
    const text =
      `${effectiveCode(input)} ${lower(input.message)} ${errorText(input.error)}`.trim();
    const statusCode = input.statusCode;

    if (
      source === "budget" ||
      containsAny(text, [
        "budget exhausted",
        "budget limit",
        "token budget",
        "cost limit",
      ])
    ) {
      return classification(
        "budget_exhausted",
        source,
        false,
        ["budget_limited"],
        "A configured run budget has been exhausted.",
      );
    }

    if (
      source === "external" ||
      containsAny(text, [
        "external pending",
        "awaiting external",
        "waiting for approval",
        "pending approval",
      ])
    ) {
      return classification(
        "external_pending",
        source,
        false,
        ["waiting_external"],
        "Progress depends on an external system or approval.",
      );
    }

    if (
      input.identicalFailureCount !== undefined &&
      input.identicalFailureCount >= this.repeatedFailureThreshold
    ) {
      return classification(
        "repeated_failure",
        source,
        false,
        ["replan", "fresh_debugger"],
        `The same failure has recurred ${input.identicalFailureCount} times.`,
      );
    }

    if (
      statusCode === 429 ||
      containsAny(text, [
        "rate limit",
        "ratelimit",
        "too many requests",
        "resource exhausted",
      ])
    ) {
      return classification(
        "rate_limited",
        source === "unknown" ? "provider" : source,
        true,
        ["wait", "alternate_provider"],
        "The provider rate-limited the request.",
        input.retryAfterMs,
      );
    }

    if (
      containsAny(text, [
        "context length",
        "context window",
        "maximum context",
        "too many tokens",
        "token limit exceeded",
      ])
    ) {
      return classification(
        "context_exhausted",
        source === "unknown" ? "provider" : source,
        false,
        ["compact_context", "new_session_epoch"],
        "The provider rejected the request because its context is full.",
      );
    }

    if (
      statusCode === 404 ||
      statusCode === 503 ||
      containsAny(text, [
        "model unavailable",
        "model not found",
        "model overloaded",
        "model disabled",
      ])
    ) {
      return classification(
        "model_unavailable",
        source === "unknown" ? "provider" : source,
        true,
        ["switch_model"],
        "The selected model is unavailable.",
      );
    }

    if (
      source === "daemon" ||
      containsAny(text, [
        "daemon crashed",
        "executor crashed",
        "lease owner died",
        "process exited",
      ])
    ) {
      return classification(
        "daemon_crash",
        "daemon",
        false,
        ["takeover_lease", "resume_checkpoint"],
        "The durable executor stopped and a lease takeover is required.",
      );
    }

    if (
      source === "git" ||
      containsAny(text, [
        "merge conflict",
        "git conflict",
        "unmerged paths",
        "needs merge",
      ])
    ) {
      return classification(
        "git_conflict",
        "git",
        false,
        ["resolve_git_conflict"],
        "Git reported a conflict that requires an explicit recovery workflow.",
      );
    }

    if (
      statusCode === 408 ||
      statusCode === 504 ||
      effectiveCode(input) === "etimedout" ||
      containsAny(text, ["timeout", "timed out", "deadline exceeded"])
    ) {
      return classification(
        "provider_timeout",
        source === "unknown" ? "provider" : source,
        true,
        ["retry", "alternate_provider"],
        "A provider request timed out before a durable result was received.",
      );
    }

    if (source === "tool") {
      if (
        containsAny(text, [
          "invalid argument",
          "validation failed",
          "unsupported",
          "not found",
          "permission denied",
          "syntax error",
        ])
      ) {
        return classification(
          "tool_deterministic",
          "tool",
          false,
          ["debug_tool"],
          "The tool failure appears deterministic and should be debugged before retrying.",
        );
      }
      if (
        containsAny(text, [
          "econnreset",
          "econnrefused",
          "temporary failure",
          "temporarily unavailable",
          "i/o error",
        ])
      ) {
        return classification(
          "tool_transient",
          "tool",
          true,
          ["retry"],
          "The tool failure appears transient and can be retried within its safety policy.",
        );
      }
      return classification(
        "tool_deterministic",
        "tool",
        false,
        ["debug_tool"],
        "An unclassified tool failure requires diagnosis before another attempt.",
      );
    }

    return classification(
      "unknown",
      source,
      false,
      ["manual_review"],
      "The failure did not match a safe automated recovery class.",
    );
  }
}

export function classifyFailure(
  input: FailureInput,
  options: FailureClassifierOptions = {},
): FailureClassification {
  return new FailureClassifier(options).classify(input);
}
