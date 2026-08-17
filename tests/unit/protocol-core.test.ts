import {
  AGENT_TRANSITIONS,
  EMPTY_BUDGET_USAGE,
  GOAL_TRANSITIONS,
  RUN_TRANSITIONS,
  TASK_TRANSITIONS,
  addBudgetUsage,
  anyResourceScopeConflict,
  assessBlocker,
  assertBlockerCanBlock,
  assertLeaseWrite,
  assertRunTransition,
  assertValidToolDefinition,
  canTransitionAgent,
  canTransitionGoal,
  canTransitionRun,
  canTransitionTask,
  canWriteWithLease,
  createBlockerFingerprint,
  createBudgetUsage,
  createDeterministicId,
  decideToolRecovery,
  evaluateBudget,
  evaluatePermission,
  evaluateToolPermissions,
  isEntityId,
  parseEntityId,
  resourceScopesConflict,
  shouldContinueGoal,
  takeOverRunLease,
  toRunLeaseFence,
  type PermissionPolicy,
  type RunLease,
  type SandboxPolicy,
  type ToolDefinition,
} from "@ottili/core";
import { describe, expect, it } from "vitest";

const unrestricted: PermissionPolicy = { mode: "unrestricted" };

const sandbox: SandboxPolicy = {
  filesystem: {
    readOnlyRoots: ["src/generated"],
    writableRoots: ["src"],
  },
  network: { allowedDestinations: [], enabled: false },
  permissions: unrestricted,
  process: { enabled: true },
};

function tool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    idempotency: "safe",
    name: "unit-tool",
    permissions: { required: ["write"] },
    recovery: "retry",
    resourceScopes: [{ access: "write", identifier: "src/*", kind: "file" }],
    sideEffectClass: "workspace",
    supportsBackground: false,
    ...overrides,
  };
}

describe("deterministic protocol identifiers", () => {
  it("is stable per kind/seed, carries a readable prefix, and validates external input", () => {
    const first = createDeterministicId("run", "mission-42:initial");
    const second = createDeterministicId("run", "mission-42:initial");
    const goal = createDeterministicId("goal", "mission-42:initial");

    expect(first).toBe(second);
    expect(first).toMatch(/^run_[0-9a-z]{13}$/);
    expect(goal).not.toBe(first);
    expect(isEntityId("run", first)).toBe(true);
    expect(parseEntityId("run", first)).toBe(first);
    expect(parseEntityId("run", "run_handwritten")).toBeUndefined();
    expect(() => createDeterministicId("run", "")).toThrow("seed");
  });
});

describe("durable state machines", () => {
  it("permits only declared Run transitions and protects terminal status", () => {
    expect(canTransitionRun("queued", "running")).toBe(true);
    expect(canTransitionRun("running", "recovering")).toBe(true);
    expect(canTransitionRun("waiting_external", "running")).toBe(true);
    expect(canTransitionRun("completed", "running")).toBe(false);
    expect(() => assertRunTransition("completed", "running")).toThrow(
      "Cannot transition run",
    );
    expect(RUN_TRANSITIONS.failed).toEqual([]);
  });

  it("keeps Goal continuation active-only and validates Goal transitions", () => {
    expect(shouldContinueGoal("active")).toBe(true);
    expect(shouldContinueGoal("waiting_external")).toBe(false);
    expect(shouldContinueGoal("complete")).toBe(false);
    expect(canTransitionGoal("active", "waiting_external")).toBe(true);
    expect(canTransitionGoal("complete", "active")).toBe(false);
    expect(GOAL_TRANSITIONS.cancelled).toEqual([]);
  });

  it("models dependency/task retry and agent recovery independently", () => {
    expect(canTransitionTask("pending", "ready")).toBe(true);
    expect(canTransitionTask("failed", "ready")).toBe(true);
    expect(canTransitionTask("completed", "running")).toBe(false);
    expect(TASK_TRANSITIONS.cancelled).toEqual([]);

    expect(canTransitionAgent("running", "recovering")).toBe(true);
    expect(canTransitionAgent("failed", "recovering")).toBe(true);
    expect(canTransitionAgent("closed", "running")).toBe(false);
    expect(AGENT_TRANSITIONS.closed).toEqual([]);
  });
});

describe("blocked semantics", () => {
  it("requires three meaningful, same-fingerprint external attempts with no alternate action", () => {
    const fingerprint = createBlockerFingerprint(
      "CI provider credential is unavailable",
    );
    const repeated = [1, 2, 3].map((index) => ({
      alternateActionAvailable: false,
      externalDependency: true,
      fingerprint,
      meaningful: true,
      occurredAt: `2026-08-17T00:00:0${index}Z`,
    }));

    expect(
      assessBlocker(repeated.slice(0, 2), fingerprint).eligibleForBlocked,
    ).toBe(false);
    expect(
      assessBlocker(
        [...repeated, { ...repeated[0]!, alternateActionAvailable: true }],
        fingerprint,
      ),
    ).toMatchObject({
      eligibleForBlocked: false,
      noAlternateActionRemains: false,
    });
    expect(assertBlockerCanBlock(repeated, fingerprint)).toMatchObject({
      eligibleForBlocked: true,
      matchingMeaningfulAttempts: 3,
    });
  });
});

describe("Run leases and fencing", () => {
  it("increments ownership generation and rejects stale executor writes", () => {
    const runId = createDeterministicId("run", "lease-run");
    const active: RunLease = {
      createdAt: "2026-08-17T00:00:00.000Z",
      executorId: "daemon-a",
      expiresAt: "2026-08-17T00:01:00.000Z",
      generation: 17,
      heartbeatAt: "2026-08-17T00:00:00.000Z",
      host: "localhost",
      id: createDeterministicId("lease", "lease-run:17"),
      process: "123",
      runId,
      updatedAt: "2026-08-17T00:00:00.000Z",
    };
    const staleFence = toRunLeaseFence(active);
    const successor = takeOverRunLease(active, {
      executorId: "daemon-b",
      expiresAt: "2026-08-17T00:02:00.000Z",
      heartbeatAt: "2026-08-17T00:01:00.000Z",
      host: "worker-2",
      process: "456",
      updatedAt: "2026-08-17T00:01:00.000Z",
    });

    expect(successor.generation).toBe(18);
    expect(
      canWriteWithLease(successor, staleFence, "2026-08-17T00:01:01.000Z"),
    ).toBe(false);
    expect(() =>
      assertLeaseWrite(successor, staleFence, "2026-08-17T00:01:01.000Z"),
    ).toThrow("Stale lease generation");
    expect(() =>
      assertLeaseWrite(
        successor,
        toRunLeaseFence(successor),
        "2026-08-17T00:01:01.000Z",
      ),
    ).not.toThrow();
  });
});

describe("resource and tool recovery policy", () => {
  it("allows concurrent reads but serializes overlapping writes", () => {
    const read = {
      access: "read" as const,
      identifier: "src/auth/*",
      kind: "file" as const,
    };
    const write = {
      access: "write" as const,
      identifier: "src/auth/login.ts",
      kind: "file" as const,
    };
    const unrelated = {
      access: "write" as const,
      identifier: "src/ui/app.ts",
      kind: "file" as const,
    };

    expect(resourceScopesConflict(read, read)).toBe(false);
    expect(resourceScopesConflict(read, write)).toBe(true);
    expect(resourceScopesConflict(write, unrelated)).toBe(false);
    expect(anyResourceScopeConflict([read], [write])).toBe(true);
  });

  it("never turns an interrupted external or unsafe tool call into a blind retry", () => {
    expect(decideToolRecovery(tool())).toMatchObject({
      action: "retry",
      requiresReconciliation: false,
    });
    expect(
      decideToolRecovery(
        tool({
          idempotency: "conditional",
          recovery: "retry",
          sideEffectClass: "workspace",
        }),
      ),
    ).toMatchObject({ action: "reconcile", requiresReconciliation: true });
    expect(
      decideToolRecovery(
        tool({ recovery: "retry", sideEffectClass: "external" }),
      ),
    ).toMatchObject({ action: "reconcile", requiresReconciliation: true });
    expect(
      decideToolRecovery(
        tool({
          idempotency: "unsafe",
          recovery: "retry",
          sideEffectClass: "workspace",
        }),
      ),
    ).toMatchObject({ action: "manual", requiresReconciliation: false });
    expect(() =>
      assertValidToolDefinition(
        tool({ recovery: "retry", sideEffectClass: "external" }),
      ),
    ).toThrow("Retry recovery");
  });
});

describe("permission composition", () => {
  it("takes the most restrictive policy and honors sandbox filesystem boundaries", () => {
    expect(
      evaluatePermission({
        action: "write",
        rolePolicy: { mode: "safe" },
        runPolicy: unrestricted,
      }).decision,
    ).toBe("prompt");

    expect(
      evaluatePermission({
        action: "write",
        resourceScope: {
          access: "write",
          identifier: "src/generated/schema.ts",
          kind: "file",
        },
        runPolicy: unrestricted,
        sandbox,
      }).decision,
    ).toBe("deny");

    expect(
      evaluatePermission({
        action: "write",
        resourceScope: {
          access: "write",
          identifier: "src/service.ts",
          kind: "file",
        },
        runPolicy: unrestricted,
        sandbox,
      }).decision,
    ).toBe("allow");
  });

  it("derives every required tool permission and keeps approval as a prompt", () => {
    const evaluations = evaluateToolPermissions(
      tool({
        permissions: { required: ["write", "network"], requiresApproval: true },
      }),
      { runPolicy: unrestricted },
    );

    expect(evaluations).toEqual([
      expect.objectContaining({ action: "write", decision: "prompt" }),
      expect.objectContaining({ action: "network", decision: "prompt" }),
    ]);
  });
});

describe("shared Run budget", () => {
  it("adds child/tool usage immutably and protects recovery/validation reserves", () => {
    const usage = addBudgetUsage(EMPTY_BUDGET_USAGE, {
      childAgents: 2,
      inputTokens: 65,
      outputTokens: 5,
      toolCalls: 3,
    });
    const budget = {
      maxChildAgents: 3,
      maxInputTokens: 100,
      maxToolCalls: 4,
      reserve: {
        recovery: { inputTokens: 20 },
        validation: { inputTokens: 10 },
      },
    };

    expect(usage).toMatchObject({
      childAgents: 2,
      inputTokens: 65,
      toolCalls: 3,
    });
    expect(EMPTY_BUDGET_USAGE.inputTokens).toBe(0);
    expect(evaluateBudget(budget, usage, "general")).toMatchObject({
      allowed: true,
      remaining: { inputTokens: 5, toolCalls: 1 },
    });
    expect(
      evaluateBudget(budget, createBudgetUsage({ inputTokens: 75 }), "general"),
    ).toMatchObject({
      allowed: false,
      exhausted: ["reserved_capacity"],
    });
    expect(
      evaluateBudget(
        budget,
        createBudgetUsage({ inputTokens: 75 }),
        "recovery",
      ),
    ).toMatchObject({
      allowed: true,
      remaining: { inputTokens: 15 },
    });
  });

  it("rejects invalid usage instead of silently corrupting the shared budget", () => {
    expect(() => createBudgetUsage({ inputTokens: -1 })).toThrow(
      "non-negative",
    );
  });
});
