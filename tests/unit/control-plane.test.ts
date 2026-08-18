import type { ToolDefinition } from "@ottili/protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LeaseFencedError,
  ResourceLockConflictError,
  RunScheduler,
  RunStore,
  LATEST_SCHEMA_VERSION,
  SqliteDatabase,
  type Clock,
} from "@ottili/control-plane";
import { describe, expect, it } from "vitest";

/** Every version from 1 to the latest, so a new migration needs no test edit. */
function schemaVersionLadder(): readonly number[] {
  return Array.from(
    { length: LATEST_SCHEMA_VERSION },
    (_value, index) => index + 1,
  );
}

class FakeClock implements Clock {
  public constructor(private instant = new Date("2026-08-17T00:00:00.000Z")) {}

  public now(): Date {
    return new Date(this.instant);
  }

  public advance(milliseconds: number): void {
    this.instant = new Date(this.instant.getTime() + milliseconds);
  }
}

function createStore(clock = new FakeClock()): {
  readonly clock: FakeClock;
  readonly store: RunStore;
} {
  return { clock, store: new RunStore(new SqliteDatabase(":memory:"), clock) };
}

const safeTool: Pick<
  ToolDefinition,
  "idempotency" | "name" | "recovery" | "sideEffectClass"
> = {
  idempotency: "safe",
  name: "write_workspace",
  recovery: "retry",
  sideEffectClass: "workspace",
};

describe("RunStore durable control plane", () => {
  it("appends ordered events, preserves requirements, and gates proof on strong evidence", () => {
    const { store } = createStore();
    const created = store.createRun({
      prompt: "Build the durable subsystem.",
      requirements: [{ id: "durability", title: "Writes survive restart" }],
      workspaceUri: "file:///repo",
    });

    expect(created.run.status).toBe("running");
    expect(
      store.listEvents(created.run.id).map((event) => event.sequence),
    ).toEqual([1, 2, 3]);
    expect(() =>
      store.setRequirementStatus(created.run.id, "durability", "proven"),
    ).toThrow("strong evidence");

    store.addEvidence({
      kind: "test",
      requirementId: "durability",
      runId: created.run.id,
      strength: "strong",
      summary: "Restart acceptance test passed.",
    });
    store.setRequirementStatus(created.run.id, "durability", "proven");
    expect(store.listRequirements(created.run.id)).toMatchObject([
      { id: "durability", status: "proven" },
    ]);
  });

  it("fences stale writers and marks interrupted side effects unknown after takeover", () => {
    const { clock, store } = createStore();
    const { run } = store.createRun({
      prompt: "Recover safely.",
      workspaceUri: "file:///repo",
    });
    const first = store.acquireLease({
      executorId: "daemon-a",
      runId: run.id,
      ttlMs: 10,
    });
    store.recordToolIntent({
      definition: safeTool,
      input: { path: "src/index.ts" },
      lease: first,
    });
    clock.advance(11);
    const successor = store.acquireLease({
      executorId: "daemon-b",
      runId: run.id,
      ttlMs: 10,
    });

    expect(successor.generation).toBe(first.generation + 1);
    expect(() =>
      store.appendFencedEvent({
        lease: first,
        payload: { stale: true },
        type: "steering.received",
      }),
    ).toThrow(LeaseFencedError);
    expect(store.recoverClaimedWork(successor)).toMatchObject([
      { name: "write_workspace", runId: run.id },
    ]);
    expect(store.listEvents(run.id).at(-1)).toMatchObject({
      type: "recovery.required",
    });
  });

  it("uses a scheduler claim as the continuation boundary, not a client process lifetime", async () => {
    const { store } = createStore();
    const { run } = store.createRun({
      prompt: "Continue after detach.",
      workspaceUri: "file:///repo",
    });
    const calls: string[] = [];
    const scheduler = new RunScheduler(
      store,
      {
        execute: async ({ action }) => {
          calls.push(`${action.runId}:${action.attempt}`);
          return { requeue: false };
        },
      },
      { executorId: "scheduler-test", leaseTtlMs: 60_000 },
    );

    const tick = await scheduler.tick();
    expect(tick.claimed).toBe(1);
    expect(calls).toEqual([`${run.id}:1`]);
    expect((await scheduler.tick()).claimed).toBe(0);
    await scheduler.stop();
  });

  it("admits a resumed budget-limited Run back through the durable scheduler queue", async () => {
    const { store } = createStore();
    const { run } = store.createRun({
      budget: { maxToolCalls: 0 },
      prompt: "Resume only after budget policy changes.",
      workspaceUri: "file:///repo",
    });
    expect(store.recordUsage(run.id, { toolCalls: 1 }).status).toBe(
      "budget_limited",
    );
    expect(store.resume(run.id).status).toBe("queued");
    let executions = 0;
    const scheduler = new RunScheduler(
      store,
      {
        execute: async () => {
          executions += 1;
          return { requeue: false };
        },
      },
      { executorId: "budget-resume", leaseTtlMs: 60_000 },
    );
    expect((await scheduler.tick()).claimed).toBe(1);
    expect(executions).toBe(1);
    await scheduler.stop();
  });

  it("enforces the completion gate again inside the durable Store transaction", () => {
    const { store } = createStore();
    const { run } = store.createRun({
      prompt: "Do not complete a bare claim.",
      requirements: [{ id: "must-prove", title: "A required fact" }],
      workspaceUri: "file:///repo",
    });
    expect(
      store.proposeCompletion({
        accepted: true,
        independentlyVerified: true,
        reasons: [],
        runId: run.id,
      }).status,
    ).toBe("running");
    expect(store.listEvents(run.id).at(-1)?.payload.accepted).toBe(false);
  });

  it("persists every remaining domain projection and blocker audit", () => {
    const { store } = createStore();
    const { run } = store.createRun({
      prompt: "Persist a full run.",
      workspaceUri: "file:///repo",
    });
    // Executor-owned projections are lease-fenced, so this test holds a lease
    // exactly the way the coordinator does.
    const lease = store.acquireLease({
      executorId: "projection-test",
      runId: run.id,
      ttlMs: 60_000,
    });
    const task = store.createTask({
      description: "A durable task",
      runId: run.id,
      title: "Task",
    });
    const milestone = store.createMilestone({
      lease,
      runId: run.id,
      taskIds: [task.id],
      title: "Milestone",
    });
    const decision = store.recordDecision({
      lease,
      rationale: "Evidence first",
      runId: run.id,
      title: "Decision",
    });
    const artifact = store.addArtifact({
      label: "report",
      lease,
      runId: run.id,
      uri: "file:///repo/report.txt",
    });
    const change = store.recordGitChange({
      lease,
      repositoryUri: "file:///repo",
      revision: "abc",
      runId: run.id,
      summary: "changed",
    });
    const snapshot = store.createContextSnapshot({
      runId: run.id,
      summary: "handoff",
      tokenCount: 2,
    });
    const memory = store.addMemoryEntry({
      confidence: 0.9,
      content: "remember",
      runId: run.id,
      scope: "run",
    });
    const approval = store.requestApproval({
      runId: run.id,
      summary: "approve the safe action",
    });
    store.resolveApproval({
      approvalId: approval.id,
      resolverId: "tester",
      status: "approved",
    });
    const cost = store.recordCost({
      costUsd: 0.01,
      inputTokens: 2,
      outputTokens: 3,
      runId: run.id,
    });
    const recovery = store.setRecoveryState({
      lease,
      runId: run.id,
      status: "required",
      unknownToolCallIds: ["tool_unknown"],
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      store.recordProblem({
        alternateActionAvailable: false,
        externalDependency: true,
        fingerprint: "external-service-down",
        runId: run.id,
        summary: "External service is down",
        taskId: task.id,
      });
    }

    expect(store.listMilestones(run.id)).toEqual([
      expect.objectContaining({ id: milestone.id, taskIds: [task.id] }),
    ]);
    expect(store.listDecisions(run.id)).toEqual([
      expect.objectContaining({ id: decision.id }),
    ]);
    expect(store.listArtifacts(run.id)).toEqual([
      expect.objectContaining({ id: artifact.id }),
    ]);
    expect(store.listGitChanges(run.id)).toEqual([
      expect.objectContaining({ id: change.id }),
    ]);
    expect(store.listContextSnapshots(run.id)).toEqual([
      expect.objectContaining({ id: snapshot.id }),
    ]);
    expect(store.listMemoryEntries(run.id)).toEqual([
      expect.objectContaining({ id: memory.id }),
    ]);
    expect(store.listApprovals(run.id)).toEqual([
      expect.objectContaining({ id: approval.id, status: "approved" }),
    ]);
    expect(store.listCostRecords(run.id)).toEqual([
      expect.objectContaining({ id: cost.id }),
    ]);
    expect(store.getRecoveryState(run.id)).toMatchObject({
      id: recovery.id,
      status: "required",
    });
    expect(store.listProblems(run.id)).toEqual([
      expect.objectContaining({ meaningfulAttempts: 3, status: "blocked" }),
    ]);
    expect(store.getRun(run.id)?.status).toBe("blocked");
  });

  it("upgrades an existing v1 SQLite journal through every later migration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ottili-v1-upgrade-"));
    const path = join(directory, "state.db");
    try {
      new SqliteDatabase(path, { migrationTargetVersion: 1 }).close();
      const upgraded = new SqliteDatabase(path);
      const versions = upgraded.all(
        "SELECT version FROM schema_migrations ORDER BY version",
      );
      // Every version from 1 to the latest must be applied, in order, so a
      // new migration cannot silently skip an older journal.
      expect(versions.map((row) => row.version)).toEqual(schemaVersionLadder());
      upgraded.close();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("adds the graph execution columns to a populated v2 journal without data loss", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ottili-v2-upgrade-"));
    const path = join(directory, "state.db");
    try {
      const v2Database = new SqliteDatabase(path, {
        migrationTargetVersion: 2,
      });
      const v2Store = new RunStore(v2Database);
      const created = v2Store.createRun({
        prompt: "Survive a schema upgrade.",
        workspaceUri: "file:///upgrade",
      });
      // Written the way a release without migration 3 would have written it:
      // the newer columns simply do not exist yet.
      v2Database.run(
        `INSERT INTO tasks (id, run_id, title, description, status, created_at, updated_at)
         VALUES ('task_legacyfixture', ?, 'Legacy task', 'Written before migration 3 existed.', 'ready', ?, ?)`,
        created.run.id,
        "2026-08-17T00:00:00.000Z",
        "2026-08-17T00:00:00.000Z",
      );
      const eventCount = v2Store.listEvents(created.run.id).length;
      v2Store.close();

      const database = new SqliteDatabase(path);
      expect(
        database
          .all("SELECT version FROM schema_migrations ORDER BY version")
          .map((row) => row.version),
      ).toEqual(schemaVersionLadder());
      const upgraded = new RunStore(database);
      expect(upgraded.getRun(created.run.id)).toMatchObject({
        id: created.run.id,
        status: "running",
      });
      // The pre-existing row keeps its identity and gains the new defaults.
      expect(upgraded.listTasks(created.run.id)).toEqual([
        expect.objectContaining({
          attempt: 0,
          status: "ready",
          title: "Legacy task",
        }),
      ]);
      expect(upgraded.listAgentMessages(created.run.id)).toEqual([]);
      expect(upgraded.listEvents(created.run.id).length).toBe(eventCount);
      upgraded.close();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("renews a lease while a long executor turn is running", async () => {
    const store = new RunStore(new SqliteDatabase(":memory:"));
    store.createRun({
      prompt: "Keep the lease alive.",
      workspaceUri: "file:///repo",
    });
    let secondClaims = 0;
    const first = new RunScheduler(
      store,
      {
        execute: async () =>
          await new Promise((resolve) =>
            setTimeout(() => resolve({ requeue: false }), 90),
          ),
      },
      { executorId: "first", leaseTtlMs: 30 },
    );
    const second = new RunScheduler(
      store,
      {
        execute: async () => {
          secondClaims += 1;
          return { requeue: false };
        },
      },
      { executorId: "second", leaseTtlMs: 30 },
    );
    const executing = first.tick();
    await new Promise((resolve) => setTimeout(resolve, 55));
    expect((await second.tick()).claimed).toBe(0);
    await executing;
    expect(secondClaims).toBe(0);
    await Promise.all([first.stop(), second.stop()]);
  });

  it("drains an aborted active turn before scheduler shutdown returns", async () => {
    const store = new RunStore(new SqliteDatabase(":memory:"));
    store.createRun({ prompt: "Abort cleanly.", workspaceUri: "file:///repo" });
    let observedAbort = false;
    const scheduler = new RunScheduler(
      store,
      {
        execute: async ({ signal }) =>
          await new Promise<{ readonly requeue: boolean }>(
            (_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  observedAbort = true;
                  reject(new DOMException("stopped", "AbortError"));
                },
                { once: true },
              );
            },
          ),
      },
      { executorId: "shutdown-test", leaseTtlMs: 60_000 },
    );
    const ticking = scheduler.tick().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await scheduler.stop();
    expect(observedAbort).toBe(true);
    await ticking;
  });

  it("serializes conflicting workspace scopes even when one daemon owns both Runs", () => {
    const { store } = createStore();
    const first = store.createRun({
      prompt: "First",
      workspaceUri: "file:///same",
    });
    const second = store.createRun({
      prompt: "Second",
      workspaceUri: "file:///same",
    });
    store.acquireResourceLocks({
      executorId: "one-daemon",
      runId: first.run.id,
      scopes: [
        {
          access: "write",
          identifier: "file:///same:src/index.ts",
          kind: "file",
        },
      ],
      ttlMs: 60_000,
    });
    expect(() =>
      store.acquireResourceLocks({
        executorId: "one-daemon",
        runId: second.run.id,
        scopes: [
          {
            access: "write",
            identifier: "file:///same:src/index.ts",
            kind: "file",
          },
        ],
        ttlMs: 60_000,
      }),
    ).toThrow(ResourceLockConflictError);
  });
});
