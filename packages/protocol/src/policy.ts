import type {
  AgentId,
  ArtifactId,
  GoalId,
  RunId,
  TaskId,
  ToolCallId,
} from "./ids.js";

/** JSON values that can cross an API, event-log, or persistence boundary. */
export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export const RESOURCE_KINDS = [
  "file",
  "repository",
  "git",
  "database",
  "service",
  "deployment",
  "process",
  "custom",
] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export const RESOURCE_ACCESS_MODES = ["read", "write"] as const;
export type ResourceAccessMode = (typeof RESOURCE_ACCESS_MODES)[number];

/**
 * A scheduler lock/request. The identifier may use a `*` wildcard, for
 * example `src/auth/*` or `branch/main`.
 */
export interface ResourceScope {
  readonly kind: ResourceKind;
  readonly identifier: string;
  readonly access: ResourceAccessMode;
}

export const TOOL_SIDE_EFFECT_CLASSES = [
  "none",
  "workspace",
  "external",
  "destructive",
] as const;
export type ToolSideEffectClass = (typeof TOOL_SIDE_EFFECT_CLASSES)[number];

export const TOOL_IDEMPOTENCY = ["safe", "conditional", "unsafe"] as const;
export type ToolIdempotency = (typeof TOOL_IDEMPOTENCY)[number];

export const TOOL_RECOVERY_STRATEGIES = [
  "retry",
  "reconcile",
  "manual",
] as const;
export type ToolRecoveryStrategy = (typeof TOOL_RECOVERY_STRATEGIES)[number];

/** Alias used by policy/configuration layers. */
export type ToolRecoveryPolicy = ToolRecoveryStrategy;

export const PERMISSION_MODES = [
  "safe",
  "standard",
  "autonomous",
  "unrestricted",
  "custom",
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const PERMISSION_ACTIONS = [
  "read",
  "write",
  "execute",
  "network",
  "external",
  "destructive",
  "approve",
] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

export const PERMISSION_EFFECTS = ["allow", "prompt", "deny"] as const;
export type PermissionEffect = (typeof PERMISSION_EFFECTS)[number];

/** A rule can be narrowed to a tool and/or resource identifier pattern. */
export interface PermissionRule {
  readonly action: PermissionAction | "*";
  readonly effect: PermissionEffect;
  readonly toolName?: string;
  readonly resourcePattern?: string;
  readonly reason?: string;
}

/**
 * Policies are composable. At evaluation time the most restrictive decision
 * from run, role, tool, and sandbox policy wins.
 */
export interface PermissionPolicy {
  readonly mode: PermissionMode;
  readonly rules?: readonly PermissionRule[];
}

export interface ToolPermissionPolicy {
  readonly required: readonly PermissionAction[];
  readonly requiresApproval?: boolean;
}

export interface SandboxFilesystemPolicy {
  readonly writableRoots: readonly string[];
  readonly readOnlyRoots: readonly string[];
}

export interface SandboxNetworkPolicy {
  readonly enabled: boolean;
  readonly allowedDestinations: readonly string[];
}

export interface SandboxProcessPolicy {
  readonly enabled: boolean;
  readonly allowedCommands?: readonly string[];
}

export interface SandboxPolicy {
  readonly filesystem: SandboxFilesystemPolicy;
  readonly network: SandboxNetworkPolicy;
  readonly process: SandboxProcessPolicy;
  readonly permissions: PermissionPolicy;
}

/**
 * The serialisable portion of a tool contract. Runtime implementations may
 * attach an executor separately; executable functions never travel over wire.
 */
export interface ToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly sideEffectClass: ToolSideEffectClass;
  readonly idempotency: ToolIdempotency;
  readonly recovery: ToolRecoveryStrategy;
  readonly supportsBackground: boolean;
  readonly completesRun?: boolean;
  readonly resourceScopes: readonly ResourceScope[];
  readonly permissions: ToolPermissionPolicy;
  readonly inputSchema?: JsonObject;
  readonly outputSchema?: JsonObject;
}

export const TOOL_CALL_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "unknown_after_crash",
] as const;
export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number];

export interface ToolCall {
  readonly id: ToolCallId;
  readonly runId: RunId;
  readonly goalId?: GoalId;
  readonly taskId?: TaskId;
  readonly agentId?: AgentId;
  readonly toolName: string;
  readonly status: ToolCallStatus;
  readonly input: JsonValue;
  readonly output?: JsonValue;
  readonly error?: ToolCallError;
  readonly definition: ToolDefinition;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface ToolCallError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ToolRecoveryDecision {
  readonly action: ToolRecoveryStrategy;
  readonly reason: string;
  readonly requiresReconciliation: boolean;
}

export type BudgetPhase = "general" | "recovery" | "validation";

export interface BudgetReservation {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cachedTokens?: number;
  readonly costUsd?: number;
  readonly wallTimeMs?: number;
  readonly toolCalls?: number;
  readonly childAgents?: number;
}

/** Hard ceilings shared by all agents belonging to a Run. */
export interface RunBudget {
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly maxTotalTokens?: number;
  readonly maxCachedTokens?: number;
  readonly maxCostUsd?: number;
  readonly maxWallTimeMs?: number;
  readonly maxToolCalls?: number;
  readonly maxChildAgents?: number;
  readonly reserve?: {
    readonly recovery?: BudgetReservation;
    readonly validation?: BudgetReservation;
  };
}

/** Accumulated shared usage, including work performed by child agents. */
export interface BudgetUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly costUsd: number;
  readonly wallTimeMs: number;
  readonly toolCalls: number;
  readonly childAgents: number;
}

export type BudgetDelta = Partial<BudgetUsage>;

export type BudgetLimitKind =
  | "input_tokens"
  | "output_tokens"
  | "total_tokens"
  | "cached_tokens"
  | "cost_usd"
  | "wall_time_ms"
  | "tool_calls"
  | "child_agents"
  | "reserved_capacity";

export interface BudgetAssessment {
  readonly allowed: boolean;
  readonly phase: BudgetPhase;
  readonly exhausted: readonly BudgetLimitKind[];
  readonly remaining: Readonly<BudgetReservation>;
}

export interface ArtifactReference {
  readonly id: ArtifactId;
  readonly label: string;
  readonly uri: string;
  readonly mediaType?: string;
}
