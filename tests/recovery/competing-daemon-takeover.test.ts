import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDirectory } from "../support/fs-cleanup.js";

import {
  LeaseFencedError,
  RunScheduler,
  RunStore,
  SqliteDatabase,
} from "@ottili/control-plane";
import type { RunId, RunLease } from "@ottili/protocol";
import {
  RunCoordinator,
  ScriptedProvider,
  ToolRegistry,
  createControlledTool,
  type ProviderTurnRequest,
  type ProviderTurnResponse,
  type TurnProvider,
} from "@ottili/runtime";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map(async (directory) => removeTempDirectory(directory)),
  );
});

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ottili-takeover-"));
  directories.push(directory);
  return join(directory, "control-plane.db");
}

/** A provider that blocks until the test releases it, like a slow API call. */
class HeldProvider implements TurnProvider {
  public readonly id = "held";
  public started: Promise<void>;
  private announceStarted!: () => void;
  private release!: () => void;
  private readonly gate: Promise<void>;

  public constructor(private readonly response: ProviderTurnResponse) {
    this.started = new Promise<void>((resolve) => {
      this.announceStarted = resolve;
    });
    this.gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  public async complete(
    _request: ProviderTurnRequest,
  ): Promise<ProviderTurnResponse> {
    this.announceStarted();
    await this.gate;
    return this.response;
  }

  public finish(): void {
    this.release();
  }
}

describe("competing daemon takeover", () => {
  it("refuses every durable write from an executor whose lease was taken over", async () => {
    const store = new RunStore(new SqliteDatabase(await databasePath()));
    const created = store.createRun({
      prompt: "Two daemons must not both own this Run.",
      workspaceUri: "file:///fixture",
    });
    const runId = created.run.id;

    const stale = store.acquireLease({
      executorId: "daemon-a",
      runId,
      ttlMs: 30,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const current = store.acquireLease({
      executorId: "daemon-b",
      runId,
      ttlMs: 60_000,
    });
    expect(current.generation).toBeGreaterThan(stale.generation);

    // Every executor-owned durable write must reject the superseded lease.
    const staleWrites: readonly [string, () => unknown][] = [
      [
        "appendFencedEvent",
        () =>
          store.appendFencedEvent({
            lease: stale,
            payload: { stale: true },
            type: "agent.progress",
          }),
      ],
      [
        "recordToolIntent",
        () =>
          store.recordToolIntent({
            definition: {
              idempotency: "unsafe",
              name: "deploy",
              recovery: "manual",
              sideEffectClass: "external",
            },
            input: { target: "production" },
            lease: stale,
          }),
      ],
      [
        "createTask",
        () =>
          store.createTask({
            description: "Written by a superseded executor.",
            lease: stale,
            runId,
            title: "Stale task",
          }),
      ],
      [
        "spawnAgent",
        () => store.spawnAgent({ lease: stale, role: "implementer", runId }),
      ],
      [
        "sendAgentMessage",
        () =>
          store.sendAgentMessage({
            body: { text: "stale" },
            kind: "status",
            lease: stale,
            toAgentId: created.agent.id,
          }),
      ],
      [
        "recordUsageFenced",
        () => store.recordUsageFenced(stale, { inputTokens: 1_000_000 }),
      ],
      [
        "recordCost",
        () => store.recordCost({ costUsd: 99, lease: stale, runId }),
      ],
      [
        "addRequirement",
        () =>
          store.addRequirement({ lease: stale, runId, title: "Stale claim" }),
      ],
      [
        "recordValidation",
        () =>
          store.recordValidation({
            independent: true,
            lease: stale,
            name: "stale",
            passed: true,
            runId,
            summary: "Written after takeover.",
          }),
      ],
      [
        "createCheckpoint",
        () =>
          store.createCheckpoint({
            label: "stale",
            lease: stale,
            manifest: {},
            reason: "stale",
            runId,
          }),
      ],
      [
        "recordGitChange",
        () =>
          store.recordGitChange({
            lease: stale,
            repositoryUri: "file:///fixture",
            revision: "deadbeef",
            runId,
            summary: "Committed after takeover.",
          }),
      ],
      [
        "addArtifact",
        () =>
          store.addArtifact({
            label: "stale",
            lease: stale,
            runId,
            uri: "file:///fixture/stale.txt",
          }),
      ],
      [
        "acquireResourceLocks",
        () =>
          store.acquireResourceLocks({
            executorId: "daemon-a",
            lease: stale,
            runId,
            scopes: [
              { access: "write", identifier: "file:///fixture", kind: "file" },
            ],
            ttlMs: 60_000,
          }),
      ],
      [
        "transitionRun",
        () =>
          store.transitionRun({
            lease: stale,
            reason: "stale",
            runId,
            to: "paused",
          }),
      ],
      [
        "proposeCompletion",
        () =>
          store.proposeCompletion({
            accepted: true,
            independentlyVerified: true,
            lease: stale,
            reasons: [],
            runId,
          }),
      ],
      [
        "scheduleWake",
        () => store.scheduleWake({ lease: stale, runId, wakeAt: new Date() }),
      ],
      ["claimContinuation", () => store.claimContinuation(stale)],
      [
        "settleContinuation",
        () => store.settleContinuation({ lease: stale, requeue: true }),
      ],
    ];

    for (const [name, write] of staleWrites) {
      expect(() => write(), `${name} accepted a superseded lease`).toThrow(
        LeaseFencedError,
      );
    }

    // The successor still owns the Run and nothing stale leaked into it.
    expect(store.getRun(runId)?.status).toBe("running");
    expect(store.listTasks(runId)).toEqual([]);
    expect(store.listRequirements(runId)).toEqual([]);
    expect(store.listAgents(runId)).toHaveLength(1);
    expect(store.getRun(runId)?.usage.inputTokens ?? 0).toBe(0);
    store.close();
  });

  it("lets a successor finish work a killed daemon started, without duplicating its effects", async () => {
    const path = await databasePath();
    const firstStore = new RunStore(new SqliteDatabase(path));
    const created = firstStore.createRun({
      prompt: "Finish what the first daemon started.",
      workspaceUri: "file:///fixture",
    });
    const runId: RunId = created.run.id;

    // The tool is deliberately policy-clean so this scenario stays about
    // fencing: an approval-gated effect would stop the turn for a human, which
    // the approval regressions already cover. It is still `unsafe`, so
    // executing it twice would be a real duplicate effect.
    const effects: string[] = [];
    const tools = new ToolRegistry();
    tools.register({
      ...createControlledTool({
        execute: async () => {
          effects.push("applied");
          return "applied once";
        },
        name: "apply_change",
      }),
      idempotency: "unsafe",
      recovery: "reconcile",
    });

    // The coordinator is driven directly rather than through a scheduler: a
    // killed process stops renewing its lease, which is precisely what the
    // absence of a heartbeat models here. A merely slow daemon keeps its lease
    // alive and is covered by the in-flight heartbeat regression instead.
    const held = new HeldProvider({
      toolCalls: [{ id: "call-1", input: {}, name: "apply_change" }],
    });
    const staleLease = firstStore.acquireLease({
      executorId: "daemon-a",
      runId,
      ttlMs: 500,
    });
    const staleAction = firstStore.claimContinuation(staleLease);
    expect(staleAction).toBeDefined();
    if (staleAction === undefined) throw new Error("No continuation claimed.");

    const staleTurn = new RunCoordinator(firstStore, {
      model: "deterministic",
      provider: held,
      tools,
    }).execute({
      action: staleAction,
      lease: staleLease,
      signal: new AbortController().signal,
    });
    await held.started;

    // Daemon A is inside a provider call and its lease expires unrenewed.
    // `execute()` checks the lease before ever reaching `held.started` (via
    // `recoverGraphWork`), so the TTL must be generous enough for that first
    // check to reliably still find it valid on a loaded CI runner — a 40 ms
    // TTL raced that check itself and hung `await held.started` forever when
    // it lost, the same class of flake as KP-025. The wait below must still
    // exceed the TTL by a comfortable margin so the lease has genuinely
    // expired by the time the successor takes over.
    await new Promise((resolve) => setTimeout(resolve, 600));
    const secondStore = new RunStore(new SqliteDatabase(path));
    const successor: RunLease = secondStore.acquireLease({
      executorId: "daemon-b",
      runId,
      ttlMs: 60_000,
    });
    expect(successor.generation).toBeGreaterThan(staleLease.generation);
    // Nothing was left half-executed, because no tool intent was ever recorded.
    expect(secondStore.recoverClaimedWork(successor)).toEqual([]);

    // Daemon A finally wakes up and tries to commit its turn.
    held.finish();
    await expect(staleTurn).rejects.toThrow(LeaseFencedError);

    // The effect never ran: the tool intent could not be recorded under a
    // superseded lease, and intent always precedes effect.
    expect(effects).toEqual([]);
    expect(
      secondStore
        .listEvents(runId)
        .filter((event) => event.type === "tool.call_started"),
    ).toEqual([]);

    // The successor executes the same work exactly once.
    const secondScheduler = new RunScheduler(
      secondStore,
      new RunCoordinator(secondStore, {
        model: "deterministic",
        provider: new ScriptedProvider([
          {
            toolCalls: [{ id: "call-2", input: {}, name: "apply_change" }],
            type: "tool_calls",
          },
          { text: "Applied.", type: "text" },
        ]),
        tools,
      }),
      { executorId: "daemon-b", leaseTtlMs: 60_000 },
    );
    await secondScheduler.tick();
    // Exactly once, by the generation that actually owns the Run.
    expect(effects).toEqual(["applied"]);
    expect(secondStore.getRun(runId)?.status).toBe("running");

    await secondScheduler.stop();
    firstStore.close();
    secondStore.close();
  });

  it("keeps a stale executor from releasing the successor's workspace locks", async () => {
    const store = new RunStore(new SqliteDatabase(await databasePath()));
    const created = store.createRun({
      prompt: "Locks belong to a generation, not a name.",
      workspaceUri: "file:///fixture",
    });
    const runId = created.run.id;
    const scope = {
      access: "write" as const,
      identifier: "file:///fixture/src",
      kind: "file" as const,
    };

    const stale = store.acquireLease({
      executorId: "daemon-a",
      runId,
      ttlMs: 30,
    });
    store.acquireResourceLocks({
      executorId: "daemon-a",
      lease: stale,
      runId,
      scopes: [scope],
      ttlMs: 60_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));

    // The replacement daemon reuses the same executor id, as a restarted
    // daemon with configured identity would.
    const successor = store.acquireLease({
      executorId: "daemon-a",
      runId,
      ttlMs: 60_000,
    });
    expect(() =>
      store.acquireResourceLocks({
        executorId: "daemon-a",
        lease: successor,
        runId,
        scopes: [scope],
        ttlMs: 60_000,
      }),
    ).not.toThrow();

    // The old generation's release must not touch the new generation's lock.
    store.releaseResourceLocks("daemon-a", runId, stale.generation);
    expect(() =>
      store.acquireResourceLocks({
        executorId: "other-daemon",
        runId,
        scopes: [scope],
        ttlMs: 60_000,
      }),
    ).toThrow(/lock/iu);

    store.releaseResourceLocks("daemon-a", runId, successor.generation);
    expect(() =>
      store.acquireResourceLocks({
        executorId: "other-daemon",
        runId,
        scopes: [scope],
        ttlMs: 60_000,
      }),
    ).not.toThrow();
    store.close();
  });

  it("does not let a superseded executor requeue work for the new owner", async () => {
    const store = new RunStore(new SqliteDatabase(await databasePath()));
    const created = store.createRun({
      prompt: "Only the current owner schedules continuations.",
      workspaceUri: "file:///fixture",
    });
    const stale = store.acquireLease({
      executorId: "daemon-a",
      runId: created.run.id,
      ttlMs: 30,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    store.acquireLease({
      executorId: "daemon-b",
      runId: created.run.id,
      ttlMs: 60_000,
    });

    expect(() =>
      store.appendFencedEvent({
        lease: stale,
        payload: { kind: "network", message: "late failure" },
        type: "provider.failed",
      }),
    ).toThrow(LeaseFencedError);
    expect(() =>
      store.scheduleWake({
        lease: stale,
        runId: created.run.id,
        wakeAt: new Date(Date.now() + 1_000),
      }),
    ).toThrow(LeaseFencedError);
    expect(
      store
        .listEvents(created.run.id)
        .some((event) => event.type === "provider.failed"),
    ).toBe(false);
    store.close();
  });
});
