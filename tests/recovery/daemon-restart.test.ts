import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDirectory } from "../support/fs-cleanup.js";

import { RunStore, SqliteDatabase, type Clock } from "@ottili/control-plane";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];

const pastClock: Clock = { now: () => new Date("2020-01-01T00:00:00.000Z") };

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map(async (directory) => await removeTempDirectory(directory)),
  );
});

describe("daemon restart recovery", () => {
  it("reconstructs Mission/Run/Goal/Agent/Event state and fences a pre-crash executor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ottili-daemon-restart-"));
    directories.push(directory);
    const databasePath = join(directory, "coder.db");
    const firstStore = new RunStore(
      new SqliteDatabase(databasePath),
      pastClock,
    );
    const created = firstStore.createRun({
      prompt: "Persist through restart.",
      workspaceUri: "file:///fixture",
    });
    const firstLease = firstStore.acquireLease({
      executorId: "old-daemon",
      runId: created.run.id,
      ttlMs: 1_000,
    });
    const child = firstStore.spawnAgent({
      parentAgentId: created.agent.id,
      role: "verifier",
      runId: created.run.id,
    });
    firstStore.recordToolIntent({
      definition: {
        idempotency: "conditional",
        name: "external_request",
        recovery: "reconcile",
        sideEffectClass: "external",
      },
      input: { request: "must not run twice" },
      lease: firstLease,
    });
    firstStore.close();

    const resumedStore = new RunStore(new SqliteDatabase(databasePath));
    expect(resumedStore.getRun(created.run.id)).toMatchObject({
      id: created.run.id,
      status: "running",
    });
    expect(resumedStore.listGoals(created.run.id)).toMatchObject([
      { id: created.goal.id, status: "active" },
    ]);
    expect(resumedStore.listAgents(created.run.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: created.agent.id, role: "coordinator" }),
        expect.objectContaining({
          id: child.id,
          parentAgentId: created.agent.id,
          role: "verifier",
        }),
      ]),
    );
    expect(
      resumedStore.listEvents(created.run.id).length,
    ).toBeGreaterThanOrEqual(4);

    const successor = resumedStore.acquireLease({
      executorId: "new-daemon",
      runId: created.run.id,
      ttlMs: 60_000,
    });
    expect(successor.generation).toBeGreaterThan(firstLease.generation);
    expect(resumedStore.recoverClaimedWork(successor)).toMatchObject([
      {
        idempotency: "conditional",
        name: "external_request",
        recovery: "reconcile",
      },
    ]);
    expect(() =>
      resumedStore.appendFencedEvent({
        lease: firstLease,
        payload: { stale: true },
        type: "agent.progress",
      }),
    ).toThrow("stale or expired");
    resumedStore.close();
  });
});
