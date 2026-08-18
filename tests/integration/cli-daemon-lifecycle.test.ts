import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OttiliClient } from "@ottili/sdk";

import {
  isProcessAlive,
  readDaemonDescriptor,
  startDaemon,
  stopDaemon,
} from "../../apps/cli/src/daemon-client.js";
import { runCli, type CliWriter } from "../../apps/cli/src/commands.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const configDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    configDirectories.splice(0).map(async (configDirectory) => {
      await stopDaemon({ configDirectory }).catch(() => undefined);
      await rm(configDirectory, { force: true, recursive: true });
    }),
  );
});

class BufferWriter implements CliWriter {
  readonly chunks: string[] = [];

  public write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  public json<Value>(): Value {
    return JSON.parse(this.chunks.join("")) as Value;
  }
}

describe("bundled CLI daemon lifecycle", () => {
  it("starts a bundled daemon, serves durable Runs, and removes its descriptor on stop", async () => {
    const configDirectory = await mkdtemp(
      join(tmpdir(), "ottili-cli-lifecycle-"),
    );
    configDirectories.push(configDirectory);
    const url = `http://127.0.0.1:${await freeLoopbackPort()}`;

    const started = new BufferWriter();
    expect(
      await runCli(
        [
          "daemon",
          "start",
          "--config-dir",
          configDirectory,
          "--url",
          url,
          "--wait-ms",
          "10000",
          "--json",
        ],
        { environment: {}, stdout: started },
      ),
    ).toBe(0);
    const descriptor = started.json<{
      readonly pid?: number;
      readonly url: string;
    }>();
    expect(descriptor).toMatchObject({ url });
    expect(descriptor.pid).toEqual(expect.any(Number));

    const status = new BufferWriter();
    expect(
      await runCli(
        ["daemon", "status", "--config-dir", configDirectory, "--json"],
        { environment: {}, stdout: status },
      ),
    ).toBe(0);
    expect(
      status.json<{
        readonly pidAlive: boolean;
        readonly ready: boolean;
        readonly reachable: boolean;
        readonly url: string;
      }>(),
    ).toMatchObject({ pidAlive: true, ready: true, reachable: true, url });

    const created = new BufferWriter();
    expect(
      await runCli(
        [
          "run",
          "Create",
          "a",
          "durable",
          "run",
          "--workspace",
          process.cwd(),
          "--config-dir",
          configDirectory,
          "--json",
        ],
        { environment: {}, stdout: created },
      ),
    ).toBe(0);
    const run = created.json<{ readonly run: { readonly id: string } }>().run;
    expect(run.id).toMatch(/^run_/);

    const listed = new BufferWriter();
    expect(
      await runCli(
        ["runs", "list", "--config-dir", configDirectory, "--json"],
        { environment: {}, stdout: listed },
      ),
    ).toBe(0);
    expect(
      listed
        .json<{ readonly runs: readonly { readonly id: string }[] }>()
        .runs.map((candidate) => candidate.id),
    ).toContain(run.id);

    const stopped = new BufferWriter();
    expect(
      await runCli(
        ["daemon", "stop", "--config-dir", configDirectory, "--json"],
        { environment: {}, stdout: stopped },
      ),
    ).toBe(0);
    expect(stopped.json<{ readonly stopped: boolean }>()).toMatchObject({
      stopped: true,
    });
    await expect(
      readDaemonDescriptor(configDirectory),
    ).resolves.toBeUndefined();
    expect(
      descriptor.pid === undefined ? false : isProcessAlive(descriptor.pid),
    ).toBe(false);
  });

  // Windows has no graceful termination signal: `process.kill(pid, "SIGTERM")`
  // is mapped onto TerminateProcess, so the daemon's handler never runs. The
  // protocol request must be able to stop the process entirely on its own.
  it("stops a bundled daemon through the protocol without any signal", async () => {
    const configDirectory = await mkdtemp(
      join(tmpdir(), "ottili-cli-shutdown-"),
    );
    configDirectories.push(configDirectory);
    const url = `http://127.0.0.1:${await freeLoopbackPort()}`;

    const { descriptor } = await startDaemon({
      configDirectory,
      environment: {},
      url,
      waitMs: 10_000,
    });
    expect(descriptor.instanceId).toEqual(expect.any(String));
    expect(descriptor.pid).toEqual(expect.any(Number));
    const pid = descriptor.pid;
    const instanceId = descriptor.instanceId;
    if (pid === undefined || instanceId === undefined) {
      throw new Error("Bundled daemon descriptor is incomplete.");
    }

    await expect(
      new OttiliClient({ baseUrl: url }).shutdown(instanceId, "test"),
    ).resolves.toMatchObject({ accepted: true });
    await vi.waitFor(() => expect(isProcessAlive(pid)).toBe(false), {
      interval: 25,
      timeout: 10_000,
    });
  });
});

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  if (address === null || typeof address === "string") {
    throw new Error("Could not reserve a loopback TCP port.");
  }
  return address.port;
}
