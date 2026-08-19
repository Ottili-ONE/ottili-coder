import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { removeTempDirectory } from "../support/fs-cleanup.js";

import { RunStore, SqliteDatabase } from "@ottili/control-plane";
import { GitCheckpointRestorer } from "@ottili/runtime";
import { OttiliDaemonServer } from "@ottili/server";
import { OttiliClient } from "@ottili/sdk";
import { GitService } from "@ottili/workspace";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const directories: string[] = [];
const servers: OttiliDaemonServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
  await Promise.all(directories.splice(0).map(removeTempDirectory));
});

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFile("git", [...args], { cwd, encoding: "utf8" });
  return result.stdout;
}

async function fixtureRepository(): Promise<string> {
  const workspacePath = await mkdtemp(
    join(tmpdir(), "ottili-checkpoint-restore-"),
  );
  directories.push(workspacePath);
  await git(workspacePath, ["init", "--initial-branch=main"]);
  await git(workspacePath, ["config", "user.email", "tests@ottili.local"]);
  await git(workspacePath, ["config", "user.name", "Ottili Tests"]);
  await writeFile(join(workspacePath, "note.txt"), "checkpoint contents\n");
  await git(workspacePath, ["add", "note.txt"]);
  await git(workspacePath, ["commit", "-m", "initial"]);
  return workspacePath;
}

describe("checkpoint restore over the daemon HTTP API", () => {
  it("refuses to restore while the Run is not paused, then reverts the workspace and records a durable event once it is", async () => {
    const workspacePath = await fixtureRepository();
    const workspaceUri = pathToFileURL(workspacePath).href;
    const store = new RunStore(new SqliteDatabase(":memory:"));
    const created = store.createRun({
      permissions: { mode: "autonomous" },
      prompt: "Prove checkpoint restore.",
      workspaceUri,
    });
    const runId = created.run.id;

    // A real checkpoint, captured the same way RunCoordinator.createMilestoneCheckpoint
    // does: a real Git snapshot ref plus the durable metadata row.
    const git = new GitService(workspacePath);
    const lease = store.acquireLease({
      executorId: "checkpoint-restore-test",
      runId,
      ttlMs: 60_000,
    });
    const snapshot = await git.captureCheckpoint({
      message: "Before further edits.",
      runId,
      sequence: 1,
    });
    store.createCheckpoint({
      label: "task_completed",
      lease,
      manifest: { tasks: [] },
      reason: "Before further edits.",
      runId,
      workspaceRef: snapshot.ref,
    });
    const [checkpoint] = store.listCheckpoints(runId);
    if (checkpoint === undefined)
      throw new Error("Checkpoint was not created.");

    // Further edits happen after the checkpoint — what restore should undo.
    await writeFile(
      join(workspacePath, "note.txt"),
      "edited after checkpoint\n",
    );

    const server = new OttiliDaemonServer(store, {
      checkpointRestorer: new GitCheckpointRestorer(),
    });
    servers.push(server);
    const address = await server.start();
    const client = new OttiliClient({ baseUrl: address.url });

    // Refused: the Run is still `queued`, not `paused`.
    await expect(
      client.restoreCheckpoint(runId, checkpoint.id),
    ).rejects.toMatchObject({ status: 400 });
    expect(await readFile(join(workspacePath, "note.txt"), "utf8")).toBe(
      "edited after checkpoint\n",
    );

    await client.command(runId, { command: "pause" });
    const result = await client.restoreCheckpoint(runId, checkpoint.id);
    expect(result.restoredRef).toBe(snapshot.ref);
    expect(result.preRestoreRef).toBeDefined();
    expect(await readFile(join(workspacePath, "note.txt"), "utf8")).toBe(
      "checkpoint contents\n",
    );

    // The pre-restore backup is a real, resolvable Git object — the restore
    // itself is undoable, not a one-way trip.
    const resolvedPreRestore = (
      await git.runGitCommand(["rev-parse", "--verify", result.preRestoreRef])
    ).trim();
    expect(resolvedPreRestore).toMatch(/^[0-9a-f]{40}$/u);

    expect(
      store
        .listEvents(runId)
        .some(
          (event) =>
            event.type === "checkpoint.restored" &&
            event.payload.checkpointId === checkpoint.id,
        ),
    ).toBe(true);
  });

  it("refuses to restore an unknown checkpoint id", async () => {
    const workspacePath = await fixtureRepository();
    const store = new RunStore(new SqliteDatabase(":memory:"));
    const created = store.createRun({
      permissions: { mode: "autonomous" },
      prompt: "Restore a checkpoint that does not exist.",
      workspaceUri: pathToFileURL(workspacePath).href,
    });
    const server = new OttiliDaemonServer(store, {
      checkpointRestorer: new GitCheckpointRestorer(),
    });
    servers.push(server);
    const address = await server.start();
    const client = new OttiliClient({ baseUrl: address.url });

    await expect(
      client.restoreCheckpoint(created.run.id, "checkpoint_does_not_exist"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("reports 501 when the daemon has no checkpoint restorer configured", async () => {
    const workspacePath = await fixtureRepository();
    const store = new RunStore(new SqliteDatabase(":memory:"));
    const created = store.createRun({
      permissions: { mode: "autonomous" },
      prompt: "No restorer configured.",
      workspaceUri: pathToFileURL(workspacePath).href,
    });
    const runId = created.run.id;
    const git = new GitService(workspacePath);
    const lease = store.acquireLease({
      executorId: "no-restorer-test",
      runId,
      ttlMs: 60_000,
    });
    const snapshot = await git.captureCheckpoint({
      message: "Checkpoint.",
      runId,
      sequence: 1,
    });
    store.createCheckpoint({
      label: "task_completed",
      lease,
      manifest: {},
      reason: "Checkpoint.",
      runId,
      workspaceRef: snapshot.ref,
    });
    const [checkpoint] = store.listCheckpoints(runId);
    if (checkpoint === undefined)
      throw new Error("Checkpoint was not created.");

    const server = new OttiliDaemonServer(store);
    servers.push(server);
    const address = await server.start();
    const client = new OttiliClient({ baseUrl: address.url });
    await client.command(runId, { command: "pause" });

    await expect(
      client.restoreCheckpoint(runId, checkpoint.id),
    ).rejects.toMatchObject({ status: 501 });
  });
});
