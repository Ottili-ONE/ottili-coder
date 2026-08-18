import { RunScheduler, RunStore, SqliteDatabase } from "@ottili/control-plane";
import type { RunId } from "@ottili/protocol";
import {
  FailoverTurnProvider,
  ProviderFailure,
  RunCoordinator,
  ScriptedProvider,
  ToolRegistry,
} from "@ottili/runtime";
import { describe, expect, it } from "vitest";

function storeWithRun(): {
  readonly runId: RunId;
  readonly store: RunStore;
} {
  const store = new RunStore(new SqliteDatabase(":memory:"));
  const created = store.createRun({
    prompt: "Survive provider trouble.",
    workspaceUri: "file:///fixture",
  });
  return { runId: created.run.id, store };
}

describe("durable provider failure recovery", () => {
  it("schedules a jittered retry for a transient outage without ending the Run", async () => {
    const { runId, store } = storeWithRun();
    const scheduler = new RunScheduler(
      store,
      new RunCoordinator(store, {
        model: "deterministic",
        provider: new ScriptedProvider([
          {
            failure: new ProviderFailure("server", "upstream unavailable"),
            type: "failure",
          },
        ]),
        tools: new ToolRegistry(),
      }),
      { executorId: "retry-test", leaseTtlMs: 60_000 },
    );

    await scheduler.tick();
    const retry = store
      .listEvents(runId)
      .find((event) => event.type === "run.retry_scheduled");
    expect(retry?.payload).toMatchObject({
      consecutiveFailures: 1,
      kind: "server",
    });
    expect(Number(retry?.payload.delayMs)).toBeGreaterThan(0);
    // A Run waiting on a retry timer is genuinely waiting, not failed, and the
    // durable wake condition is what brings it back.
    expect(store.getRun(runId)?.status).toBe("waiting_external");

    store.scheduleWake({ runId, wakeAt: new Date(Date.now() - 1) });
    store.wakeDueRuns();
    expect(store.getRun(runId)?.status).toBe("running");
    await scheduler.stop();
  });

  it("parks the Run for an operator when retrying has stopped helping", async () => {
    const { runId, store } = storeWithRun();
    const scheduler = new RunScheduler(
      store,
      new RunCoordinator(store, {
        // Zero tolerated consecutive failures exercises exhaustion in one tick.
        maxProviderAttempts: 0,
        model: "deterministic",
        provider: new ScriptedProvider([
          {
            failure: new ProviderFailure("server", "still unavailable"),
            type: "failure",
          },
        ]),
        tools: new ToolRegistry(),
      }),
      { executorId: "exhausted-test", leaseTtlMs: 60_000 },
    );

    await scheduler.tick();
    expect(store.getRun(runId)?.status).toBe("waiting_external");
    expect(store.listProblems(runId)).toEqual([
      expect.objectContaining({
        externalDependency: true,
        summary: expect.stringContaining("kept failing"),
      }),
    ]);
    // The mission is parked, never failed, so an operator can resume it.
    expect(store.getRun(runId)?.status).not.toBe("failed");
    await scheduler.stop();
  });

  it("parks immediately on an authentication failure and records the cause", async () => {
    const { runId, store } = storeWithRun();
    const scheduler = new RunScheduler(
      store,
      new RunCoordinator(store, {
        model: "deterministic",
        provider: new ScriptedProvider([
          {
            failure: new ProviderFailure("authentication", "invalid api key"),
            type: "failure",
          },
        ]),
        tools: new ToolRegistry(),
      }),
      { executorId: "auth-test", leaseTtlMs: 60_000 },
    );

    await scheduler.tick();
    expect(store.getRun(runId)?.status).toBe("waiting_external");
    expect(
      store.listEvents(runId).some((event) => event.type === "provider.failed"),
    ).toBe(true);
    expect(store.listProblems(runId)).toEqual([
      expect.objectContaining({
        summary: expect.stringContaining("authentication"),
      }),
    ]);
    await scheduler.stop();
  });

  it("fails over to a healthy provider inside one durable turn", async () => {
    const { runId, store } = storeWithRun();
    const failovers: string[] = [];
    const backup = new ScriptedProvider([
      { text: "Continued on the backup provider.", type: "text" },
    ]);
    const scheduler = new RunScheduler(
      store,
      new RunCoordinator(store, {
        model: "deterministic",
        provider: new FailoverTurnProvider({
          candidates: [
            {
              provider: new ScriptedProvider([
                {
                  failure: new ProviderFailure("rate_limited", "429", 10),
                  type: "failure",
                },
              ]),
            },
            { provider: backup },
          ],
          onFailover: (attempt) => failovers.push(attempt.providerId),
        }),
        tools: new ToolRegistry(),
      }),
      { executorId: "failover-test", leaseTtlMs: 60_000 },
    );

    await scheduler.tick();
    expect(failovers).toEqual(["scripted"]);
    // The turn succeeded, so no durable retry or park was needed at all.
    expect(store.getRun(runId)?.status).toBe("running");
    expect(
      store.listEvents(runId).some((event) => event.type === "provider.failed"),
    ).toBe(false);
    expect(
      store
        .listEvents(runId)
        .filter((event) => event.type === "agent.message")
        .map((event) => event.payload.text),
    ).toEqual(["Continued on the backup provider."]);
    await scheduler.stop();
  });

  it("turns a context overflow into a continuation epoch, not a failure", async () => {
    const { runId, store } = storeWithRun();
    const scheduler = new RunScheduler(
      store,
      new RunCoordinator(store, {
        model: "deterministic",
        provider: new ScriptedProvider([
          {
            failure: new ProviderFailure("context_overflow", "too many tokens"),
            type: "failure",
          },
          { text: "Continued in a fresh epoch.", type: "text" },
        ]),
        tools: new ToolRegistry(),
      }),
      { executorId: "overflow-test", leaseTtlMs: 60_000 },
    );

    await scheduler.tick();
    expect(store.listContextSnapshots(runId)).toHaveLength(1);
    expect(store.getRun(runId)?.status).toBe("running");

    await scheduler.tick();
    expect(
      store
        .listEvents(runId)
        .filter((event) => event.type === "agent.message")
        .map((event) => event.payload.text),
    ).toEqual(["Continued in a fresh epoch."]);
    await scheduler.stop();
  });
});
