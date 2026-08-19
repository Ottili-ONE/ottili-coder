import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDirectory } from "../support/fs-cleanup.js";

import { RunStore, SqliteDatabase } from "@ottili/control-plane";
import { OttiliDaemonServer } from "@ottili/server";
import { OttiliClient } from "@ottili/sdk";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
const servers: OttiliDaemonServer[] = [];
const stores: RunStore[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map(removeTempDirectory));
});

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ottili-sse-reconnect-"));
  directories.push(directory);
  return join(directory, "control-plane.db");
}

describe("SSE reconnect across a dropped and restarted daemon", () => {
  it("catches a reconnecting client up on events durably recorded while it was disconnected", async () => {
    const path = await temporaryDatabasePath();

    // Daemon A: create the Run and record one event before the client
    // disconnects, establishing the `after` sequence a reconnect resumes from.
    // Closed explicitly mid-test to simulate the crash, so it is not also
    // registered for `afterEach` cleanup (which would double-close it).
    const firstStore = new RunStore(new SqliteDatabase(path));
    const firstServer = new OttiliDaemonServer(firstStore);
    servers.push(firstServer);
    const firstAddress = await firstServer.start();
    const firstClient = new OttiliClient({ baseUrl: firstAddress.url });

    const created = await firstClient.createRun({
      mission: {
        prompt: "Survive a dropped SSE connection.",
        title: "SSE reconnect",
        workspaceUri: "file:///sse-reconnect",
      },
    });
    const runId = created.run.id;
    await firstClient.steer(runId, { text: "First, before the drop." });
    const beforeDrop = await firstClient.events(runId);
    const lastSeenBeforeDrop = beforeDrop.nextSequence;

    // The connection drops and the daemon itself goes away — the same
    // durable-restart shape as tests/e2e/daemon-kill-mission.test.ts, scoped
    // here to just the SSE reconnect contract rather than a full mission.
    await firstServer.close();
    firstStore.close();

    // While disconnected, durable work keeps happening — recorded directly,
    // the same as another executor (or this same one, restarted) would.
    const midStore = new RunStore(new SqliteDatabase(path));
    midStore.recordSteeringInput({
      runId,
      text: "Second, while disconnected.",
    });
    midStore.recordSteeringInput({
      runId,
      text: "Third, while disconnected.",
    });
    midStore.close();

    // Daemon B: a genuinely fresh Store and Server attached to the same
    // durable journal — nothing about reconnect depends on daemon A's
    // in-memory state.
    const secondStore = new RunStore(new SqliteDatabase(path));
    stores.push(secondStore);
    const secondServer = new OttiliDaemonServer(secondStore);
    servers.push(secondServer);
    const secondAddress = await secondServer.start();
    const secondClient = new OttiliClient({ baseUrl: secondAddress.url });

    const reconnected = secondClient.streamEvents(runId, lastSeenBeforeDrop);
    const caughtUp: string[] = [];
    for await (const event of reconnected) {
      if (event.type !== "steering.received") continue;
      caughtUp.push(String(event.payload.text));
      if (caughtUp.length === 2) break;
    }

    // Exactly the events that happened while disconnected — neither a gap
    // nor a duplicate of what the client already saw before the drop.
    expect(caughtUp).toEqual([
      "Second, while disconnected.",
      "Third, while disconnected.",
    ]);

    // The REST history endpoint agrees, independent of the stream.
    const history = await secondClient.events(runId, lastSeenBeforeDrop);
    expect(
      history.events
        .filter((event) => event.type === "steering.received")
        .map((event) => event.payload.text),
    ).toEqual(["Second, while disconnected.", "Third, while disconnected."]);
  });
});
