import {
  type BudgetAssessment,
  type BudgetDelta,
  type BudgetLimitKind,
  type BudgetPhase,
  type BudgetReservation,
  type BudgetUsage,
  type PermissionAction,
  type PermissionEffect,
  type PermissionPolicy,
  type PermissionRule,
  type ResourceScope,
  type RunBudget,
  type SandboxPolicy,
  type ToolDefinition,
  type ToolRecoveryDecision,
} from "@ottili/protocol";

import { InvariantViolationError } from "./errors.js";

export const EMPTY_BUDGET_USAGE: BudgetUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  costUsd: 0,
  wallTimeMs: 0,
  toolCalls: 0,
  childAgents: 0,
});

export interface PermissionEvaluationInput {
  readonly action: PermissionAction;
  readonly toolName?: string;
  readonly resourceScope?: ResourceScope;
  readonly runPolicy: PermissionPolicy;
  readonly rolePolicy?: PermissionPolicy;
  readonly toolPolicy?: PermissionPolicy;
  readonly sandbox?: SandboxPolicy;
  readonly requiresApproval?: boolean;
}

export interface PermissionEvaluation {
  readonly action: PermissionAction;
  readonly decision: PermissionEffect;
  readonly reasons: readonly string[];
}

/**
 * Derives a recovery action that is safe after a crash even if a tool was
 * configured too optimistically. It never blindly retries unsafe/external
 * work.
 */
export function decideToolRecovery(tool: ToolDefinition): ToolRecoveryDecision {
  if (tool.recovery === "manual") {
    return {
      action: "manual",
      reason: "The tool explicitly requires manual recovery",
      requiresReconciliation: false,
    };
  }

  if (tool.recovery === "reconcile") {
    return {
      action: "reconcile",
      reason: "The tool requires state reconciliation before another execution",
      requiresReconciliation: true,
    };
  }

  if (
    tool.sideEffectClass === "external" ||
    tool.sideEffectClass === "destructive"
  ) {
    return {
      action: tool.sideEffectClass === "external" ? "reconcile" : "manual",
      reason:
        tool.sideEffectClass === "external"
          ? "External side effects must be reconciled rather than retried blindly"
          : "Destructive side effects must not be retried after an interrupted call",
      requiresReconciliation: tool.sideEffectClass === "external",
    };
  }

  if (tool.idempotency === "safe") {
    return {
      action: "retry",
      reason:
        "The tool has no external side effect and is declared idempotently safe",
      requiresReconciliation: false,
    };
  }

  return {
    action: tool.idempotency === "conditional" ? "reconcile" : "manual",
    reason:
      tool.idempotency === "conditional"
        ? "Conditional idempotency requires reconciliation before retry"
        : "Unsafe idempotency requires manual recovery",
    requiresReconciliation: tool.idempotency === "conditional",
  };
}

/** Rejects malformed contracts at registration time. */
export function assertValidToolDefinition(tool: ToolDefinition): void {
  if (tool.name.trim().length === 0) {
    throw new InvariantViolationError("Tool names must not be empty");
  }

  for (const scope of tool.resourceScopes) {
    assertValidResourceScope(scope);
  }

  if (
    tool.recovery === "retry" &&
    (tool.idempotency !== "safe" ||
      (tool.sideEffectClass !== "none" && tool.sideEffectClass !== "workspace"))
  ) {
    throw new InvariantViolationError(
      "Retry recovery is only valid for safe, non-external tool operations",
      {
        toolName: tool.name,
        idempotency: tool.idempotency,
        sideEffectClass: tool.sideEffectClass,
      },
    );
  }
}

/** Returns true only if a scheduler must serialize two scope requests. */
export function resourceScopesConflict(
  left: ResourceScope,
  right: ResourceScope,
): boolean {
  if (
    left.kind !== right.kind ||
    (left.access === "read" && right.access === "read")
  ) {
    return false;
  }

  return resourceIdentifiersOverlap(
    left.kind,
    left.identifier,
    right.identifier,
  );
}

export function anyResourceScopeConflict(
  left: readonly ResourceScope[],
  right: readonly ResourceScope[],
): boolean {
  return left.some((leftScope) =>
    right.some((rightScope) => resourceScopesConflict(leftScope, rightScope)),
  );
}

export function resourceScopeKey(scope: ResourceScope): string {
  return `${scope.kind}:${scope.identifier}:${scope.access}`;
}

/**
 * Computes an effective permission by intersecting run, role, tool, and
 * sandbox policies. A more permissive child agent can therefore never bypass
 * a restrictive parent/run policy.
 */
export function evaluatePermission(
  input: PermissionEvaluationInput,
): PermissionEvaluation {
  const evaluations: Array<{
    readonly source: string;
    readonly effect: PermissionEffect;
  }> = [{ source: "run", effect: evaluatePolicy(input.runPolicy, input) }];

  if (input.rolePolicy !== undefined) {
    evaluations.push({
      source: "role",
      effect: evaluatePolicy(input.rolePolicy, input),
    });
  }
  if (input.toolPolicy !== undefined) {
    evaluations.push({
      source: "tool",
      effect: evaluatePolicy(input.toolPolicy, input),
    });
  }
  if (input.sandbox !== undefined) {
    evaluations.push({
      source: "sandbox-policy",
      effect: evaluatePolicy(input.sandbox.permissions, input),
    });
    const sandboxEffect = evaluateSandboxConstraint(input);
    if (sandboxEffect !== undefined) {
      evaluations.push({ source: "sandbox-capability", effect: sandboxEffect });
    }
  }
  if (input.requiresApproval === true) {
    evaluations.push({ source: "approval", effect: "prompt" });
  }

  const decision = evaluations.reduce<PermissionEffect>(
    (current, evaluation) =>
      permissionRank(evaluation.effect) < permissionRank(current)
        ? evaluation.effect
        : current,
    "allow",
  );

  return {
    action: input.action,
    decision,
    reasons: evaluations
      .filter((evaluation) => evaluation.effect === decision)
      .map((evaluation) => `${evaluation.source}:${evaluation.effect}`),
  };
}

export function permissionActionsForTool(
  tool: ToolDefinition,
): readonly PermissionAction[] {
  const declared = [...tool.permissions.required];
  if (declared.length > 0) {
    return declared;
  }

  switch (tool.sideEffectClass) {
    case "none":
      return ["read"];
    case "workspace":
      return ["write"];
    case "external":
      return ["external"];
    case "destructive":
      return ["destructive"];
  }
}

export function evaluateToolPermissions(
  tool: ToolDefinition,
  input: Omit<PermissionEvaluationInput, "action" | "requiresApproval">,
): readonly PermissionEvaluation[] {
  return permissionActionsForTool(tool).map((action) => {
    const request = { ...input, action };
    return tool.permissions.requiresApproval === true
      ? evaluatePermission({ ...request, requiresApproval: true })
      : evaluatePermission(request);
  });
}

export function createBudgetUsage(delta: BudgetDelta = {}): BudgetUsage {
  return addBudgetUsage(EMPTY_BUDGET_USAGE, delta);
}

/** Adds usage immutably after rejecting invalid negative/non-finite data. */
export function addBudgetUsage(
  usage: BudgetUsage,
  delta: BudgetDelta,
): BudgetUsage {
  assertUsage(usage, "usage");
  assertPartialUsage(delta, "delta");

  return {
    inputTokens: usage.inputTokens + (delta.inputTokens ?? 0),
    outputTokens: usage.outputTokens + (delta.outputTokens ?? 0),
    cachedTokens: usage.cachedTokens + (delta.cachedTokens ?? 0),
    costUsd: usage.costUsd + (delta.costUsd ?? 0),
    wallTimeMs: usage.wallTimeMs + (delta.wallTimeMs ?? 0),
    toolCalls: usage.toolCalls + (delta.toolCalls ?? 0),
    childAgents: usage.childAgents + (delta.childAgents ?? 0),
  };
}

/**
 * Calculates whether shared usage can continue in a phase. General work keeps
 * configured recovery/validation capacity available; recovery and validation
 * protect each other but may use their own reserve.
 */
export function evaluateBudget(
  budget: RunBudget,
  usage: BudgetUsage,
  phase: BudgetPhase = "general",
): BudgetAssessment {
  assertBudget(budget);
  assertUsage(usage, "usage");

  const exhausted: BudgetLimitKind[] = [];
  const remaining: MutableBudgetReservation = {};
  const reserve = reserveForOtherPhases(budget, phase);

  assessMetric(
    budget.maxInputTokens,
    usage.inputTokens,
    reserve.inputTokens ?? 0,
    "input_tokens",
    "inputTokens",
    exhausted,
    remaining,
  );
  assessMetric(
    budget.maxOutputTokens,
    usage.outputTokens,
    reserve.outputTokens ?? 0,
    "output_tokens",
    "outputTokens",
    exhausted,
    remaining,
  );
  assessMetric(
    budget.maxCachedTokens,
    usage.cachedTokens,
    0,
    "cached_tokens",
    "cachedTokens",
    exhausted,
    remaining,
  );
  assessMetric(
    budget.maxCostUsd,
    usage.costUsd,
    reserve.costUsd ?? 0,
    "cost_usd",
    "costUsd",
    exhausted,
    remaining,
  );
  assessMetric(
    budget.maxWallTimeMs,
    usage.wallTimeMs,
    reserve.wallTimeMs ?? 0,
    "wall_time_ms",
    "wallTimeMs",
    exhausted,
    remaining,
  );
  assessMetric(
    budget.maxToolCalls,
    usage.toolCalls,
    reserve.toolCalls ?? 0,
    "tool_calls",
    "toolCalls",
    exhausted,
    remaining,
  );
  assessMetric(
    budget.maxTotalTokens,
    usage.inputTokens + usage.outputTokens,
    (reserve.inputTokens ?? 0) +
      (reserve.outputTokens ?? 0) +
      (reserve.totalTokens ?? 0),
    "total_tokens",
    "totalTokens",
    exhausted,
    remaining,
  );
  assessMetric(
    budget.maxChildAgents,
    usage.childAgents,
    0,
    "child_agents",
    "childAgents",
    exhausted,
    remaining,
  );

  return {
    allowed: exhausted.length === 0,
    phase,
    exhausted,
    remaining,
  };
}

function assertValidResourceScope(scope: ResourceScope): void {
  if (scope.identifier.trim().length === 0) {
    throw new InvariantViolationError(
      "Resource scope identifiers must not be empty",
      {
        kind: scope.kind,
      },
    );
  }
}

function resourceIdentifiersOverlap(
  kind: ResourceScope["kind"],
  left: string,
  right: string,
): boolean {
  if (
    left === right ||
    wildcardMatches(left, right) ||
    wildcardMatches(right, left)
  ) {
    return true;
  }

  if (kind !== "file") {
    return false;
  }

  const normalizedLeft = stripTrailingSlash(left);
  const normalizedRight = stripTrailingSlash(right);
  return (
    normalizedLeft.startsWith(`${normalizedRight}/`) ||
    normalizedRight.startsWith(`${normalizedLeft}/`)
  );
}

function evaluatePolicy(
  policy: PermissionPolicy,
  input: PermissionEvaluationInput,
): PermissionEffect {
  const matchingRules = (policy.rules ?? []).filter((rule) =>
    ruleMatches(rule, input),
  );
  if (policy.mode === "custom") {
    if (matchingRules.length === 0) {
      return "deny";
    }
    return matchingRules.reduce<PermissionEffect>(
      (current, rule) =>
        permissionRank(rule.effect) < permissionRank(current)
          ? rule.effect
          : current,
      "allow",
    );
  }

  return matchingRules.reduce<PermissionEffect>(
    (current, rule) =>
      permissionRank(rule.effect) < permissionRank(current)
        ? rule.effect
        : current,
    defaultPermissionEffect(policy.mode, input.action),
  );
}

function ruleMatches(
  rule: PermissionRule,
  input: PermissionEvaluationInput,
): boolean {
  if (rule.action !== "*" && rule.action !== input.action) {
    return false;
  }
  if (rule.toolName !== undefined && rule.toolName !== input.toolName) {
    return false;
  }
  if (rule.resourcePattern !== undefined) {
    return (
      input.resourceScope !== undefined &&
      wildcardMatches(rule.resourcePattern, input.resourceScope.identifier)
    );
  }
  return true;
}

function defaultPermissionEffect(
  mode: Exclude<PermissionPolicy["mode"], "custom">,
  action: PermissionAction,
): PermissionEffect {
  switch (mode) {
    case "safe":
      return action === "read"
        ? "allow"
        : action === "write" || action === "execute"
          ? "prompt"
          : "deny";
    case "standard":
      return action === "read"
        ? "allow"
        : action === "destructive"
          ? "deny"
          : "prompt";
    case "autonomous":
      return action === "destructive" || action === "approve"
        ? "deny"
        : action === "external"
          ? "prompt"
          : "allow";
    case "unrestricted":
      return "allow";
  }
}

function evaluateSandboxConstraint(
  input: PermissionEvaluationInput,
): PermissionEffect | undefined {
  const sandbox = input.sandbox;
  if (sandbox === undefined) {
    return undefined;
  }
  if (input.action === "network" && !sandbox.network.enabled) {
    return "deny";
  }
  if (input.action === "execute" && !sandbox.process.enabled) {
    return "deny";
  }
  if (input.action !== "write" || input.resourceScope?.kind !== "file") {
    return undefined;
  }

  const identifier = input.resourceScope.identifier;
  if (
    sandbox.filesystem.readOnlyRoots.some((root) =>
      resourceIdentifiersOverlap("file", root, identifier),
    )
  ) {
    return "deny";
  }
  if (
    sandbox.filesystem.writableRoots.length === 0 ||
    !sandbox.filesystem.writableRoots.some((root) =>
      resourceIdentifiersOverlap("file", root, identifier),
    )
  ) {
    return "deny";
  }
  return undefined;
}

function permissionRank(effect: PermissionEffect): number {
  switch (effect) {
    case "allow":
      return 2;
    case "prompt":
      return 1;
    case "deny":
      return 0;
  }
}

function wildcardMatches(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("\\*", ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function assertUsage(usage: BudgetUsage, label: string): void {
  assertPartialUsage(usage, label);
}

function assertPartialUsage(usage: BudgetDelta, label: string): void {
  for (const [key, value] of budgetUsageEntries(usage)) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new InvariantViolationError(
        `${label}.${key} must be a finite non-negative number`,
        {
          key,
          value: value ?? null,
        },
      );
    }
  }
}

function assertBudget(budget: RunBudget): void {
  const ceilings: Record<string, number | undefined> = {
    maxInputTokens: budget.maxInputTokens,
    maxOutputTokens: budget.maxOutputTokens,
    maxTotalTokens: budget.maxTotalTokens,
    maxCachedTokens: budget.maxCachedTokens,
    maxCostUsd: budget.maxCostUsd,
    maxWallTimeMs: budget.maxWallTimeMs,
    maxToolCalls: budget.maxToolCalls,
    maxChildAgents: budget.maxChildAgents,
  };
  for (const [key, value] of Object.entries(ceilings)) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new InvariantViolationError(
        `${key} must be a finite non-negative number`,
        {
          key,
          value: value ?? null,
        },
      );
    }
  }
  if (budget.reserve?.recovery !== undefined) {
    assertPartialUsage(budget.reserve.recovery, "reserve.recovery");
  }
  if (budget.reserve?.validation !== undefined) {
    assertPartialUsage(budget.reserve.validation, "reserve.validation");
  }
}

function reserveForOtherPhases(
  budget: RunBudget,
  phase: BudgetPhase,
): BudgetReservation {
  const recovery = budget.reserve?.recovery;
  const validation = budget.reserve?.validation;
  if (phase === "general") {
    return sumReservations(recovery, validation);
  }
  if (phase === "recovery") {
    return validation ?? {};
  }
  return recovery ?? {};
}

function sumReservations(
  left: BudgetReservation | undefined,
  right: BudgetReservation | undefined,
): BudgetReservation {
  return {
    inputTokens: (left?.inputTokens ?? 0) + (right?.inputTokens ?? 0),
    outputTokens: (left?.outputTokens ?? 0) + (right?.outputTokens ?? 0),
    totalTokens: (left?.totalTokens ?? 0) + (right?.totalTokens ?? 0),
    cachedTokens: (left?.cachedTokens ?? 0) + (right?.cachedTokens ?? 0),
    costUsd: (left?.costUsd ?? 0) + (right?.costUsd ?? 0),
    wallTimeMs: (left?.wallTimeMs ?? 0) + (right?.wallTimeMs ?? 0),
    toolCalls: (left?.toolCalls ?? 0) + (right?.toolCalls ?? 0),
    childAgents: (left?.childAgents ?? 0) + (right?.childAgents ?? 0),
  };
}

function assessMetric(
  maximum: number | undefined,
  used: number,
  protectedCapacity: number,
  directLimit: BudgetLimitKind,
  remainingKey: keyof BudgetReservation,
  exhausted: BudgetLimitKind[],
  remaining: MutableBudgetReservation,
): void {
  if (maximum === undefined) {
    return;
  }

  const directRemaining = maximum - used;
  const available = directRemaining - protectedCapacity;
  if (directRemaining <= 0) {
    exhausted.push(directLimit);
  } else if (available <= 0) {
    exhausted.push("reserved_capacity");
  }

  if (remainingKey === "inputTokens") {
    remaining.inputTokens = Math.max(0, available);
  } else if (remainingKey === "outputTokens") {
    remaining.outputTokens = Math.max(0, available);
  } else if (remainingKey === "totalTokens") {
    remaining.totalTokens = Math.max(0, available);
  } else if (remainingKey === "cachedTokens") {
    remaining.cachedTokens = Math.max(0, available);
  } else if (remainingKey === "costUsd") {
    remaining.costUsd = Math.max(0, available);
  } else if (remainingKey === "wallTimeMs") {
    remaining.wallTimeMs = Math.max(0, available);
  } else if (remainingKey === "toolCalls") {
    remaining.toolCalls = Math.max(0, available);
  } else if (remainingKey === "childAgents") {
    remaining.childAgents = Math.max(0, available);
  }
}

type MutableBudgetReservation = {
  -readonly [Key in keyof BudgetReservation]: BudgetReservation[Key];
};

function budgetUsageEntries(
  usage: BudgetDelta,
): readonly [keyof BudgetUsage, number | undefined][] {
  return [
    ["inputTokens", usage.inputTokens],
    ["outputTokens", usage.outputTokens],
    ["cachedTokens", usage.cachedTokens],
    ["costUsd", usage.costUsd],
    ["wallTimeMs", usage.wallTimeMs],
    ["toolCalls", usage.toolCalls],
    ["childAgents", usage.childAgents],
  ];
}
