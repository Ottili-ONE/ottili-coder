import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDirectory } from "../support/fs-cleanup.js";

import {
  HybridExecutionBackend,
  LocalExecutionBackend,
  RemoteExecutionBackend,
  importLegacyConfig,
  previewLegacyConfig,
  type BackendHandle,
  type ExecuteRequest,
  type ExecuteResult,
  type RemoteExecutionTransport,
} from "@ottili/integrations";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => await removeTempDirectory(directory)),
  );
});

describe("legacy configuration import", () => {
  it("previews and imports without changing the legacy file", async () => {
    const homeDirectory = await mkdtemp(
      join(tmpdir(), "ottili-integration-home-"),
    );
    temporaryDirectories.push(homeDirectory);
    const source = join(homeDirectory, ".ottili-coder", "config.json");
    await mkdir(join(homeDirectory, ".ottili-coder"), { recursive: true });
    await writeFile(
      source,
      JSON.stringify({ providers: { local: { model: "test" } } }),
    );

    const preview = await previewLegacyConfig({ homeDirectory });
    expect(preview.importable).toBe(true);
    expect(preview.foundAt).toBe(source);

    const imported = await importLegacyConfig({ homeDirectory });
    expect(imported.importable).toBe(true);
    expect(
      JSON.parse(await readFile(imported.canonicalTarget, "utf8")),
    ).toEqual(preview.settings);
    expect(await readFile(source, "utf8")).toContain("providers");
  });
});

describe("local execution backend", () => {
  it("executes explicitly supplied command arguments", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ottili-local-backend-"));
    temporaryDirectories.push(directory);
    const backend = new LocalExecutionBackend();
    const handle = await backend.start(directory);
    const result = await backend.execute(handle, {
      args: ["-e", "process.stdout.write('ready')"],
      command: process.execPath,
      cwd: directory,
    });
    expect(result).toMatchObject({ code: 0, stderr: "", stdout: "ready" });
  });

  it("runs the full handle lifecycle: start, health, execute, cancel, cleanup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ottili-local-lifecycle-"));
    temporaryDirectories.push(directory);
    const backend = new LocalExecutionBackend();
    const handle = await backend.start(directory);
    expect(handle.kind).toBe("local");
    expect(await backend.health(handle)).toBe("ready");
    const result = await backend.execute(handle, {
      args: ["-e", "process.exitCode = 3"],
      command: process.execPath,
      cwd: directory,
    });
    expect(result.code).toBe(3);
    await expect(backend.cancel()).resolves.toBeUndefined();
    await expect(backend.cleanup()).resolves.toBeUndefined();
  });

  it("aborts a running command through the request's signal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ottili-local-abort-"));
    temporaryDirectories.push(directory);
    const backend = new LocalExecutionBackend();
    const handle = await backend.start(directory);
    const controller = new AbortController();
    const pending = backend.execute(handle, {
      args: ["-e", "setTimeout(() => {}, 30000)"],
      command: process.execPath,
      cwd: directory,
      signal: controller.signal,
    });
    controller.abort();
    const result = await pending;
    expect(result.code).not.toBe(0);
  });
});

/** Deterministic double so remote/hybrid contracts are provable without a network. */
class FakeRemoteTransport implements RemoteExecutionTransport {
  public healthResponses: ("ready" | "unavailable")[] = ["ready"];
  public readonly calls: string[] = [];

  public async start(workspace: string): Promise<BackendHandle> {
    this.calls.push(`start:${workspace}`);
    return { id: "remote-handle", kind: "remote", state: "ready" };
  }

  public async health(handle: BackendHandle): Promise<"ready" | "unavailable"> {
    this.calls.push(`health:${handle.id}`);
    return this.healthResponses.shift() ?? "ready";
  }

  public async execute(
    handle: BackendHandle,
    request: ExecuteRequest,
  ): Promise<ExecuteResult> {
    this.calls.push(`execute:${handle.id}:${request.command}`);
    return { code: 0, stderr: "", stdout: "remote-output" };
  }

  public async cancel(handle: BackendHandle): Promise<void> {
    this.calls.push(`cancel:${handle.id}`);
  }

  public async cleanup(handle: BackendHandle): Promise<void> {
    this.calls.push(`cleanup:${handle.id}`);
  }
}

describe("remote execution backend", () => {
  it("delegates every lifecycle call to its transport", async () => {
    const transport = new FakeRemoteTransport();
    const backend = new RemoteExecutionBackend(transport);
    expect(backend.kind).toBe("remote");
    const handle = await backend.start("/workspace");
    expect(await backend.health(handle)).toBe("ready");
    const result = await backend.execute(handle, {
      command: "pytest",
      cwd: "/workspace",
    });
    expect(result.stdout).toBe("remote-output");
    await backend.cancel(handle);
    await backend.cleanup(handle);
    expect(transport.calls).toEqual([
      "start:/workspace",
      "health:remote-handle",
      "execute:remote-handle:pytest",
      "cancel:remote-handle",
      "cleanup:remote-handle",
    ]);
  });
});

describe("hybrid execution backend", () => {
  class FakeBackend {
    public readonly kind: "local" | "remote";
    public healthState: "ready" | "unavailable" = "ready";
    public readonly executed: string[] = [];

    public constructor(kind: "local" | "remote") {
      this.kind = kind;
    }

    public async start(): Promise<BackendHandle> {
      return { id: `${this.kind}-handle`, kind: this.kind, state: "ready" };
    }

    public async health(): Promise<"ready" | "unavailable"> {
      return this.healthState;
    }

    public async execute(
      _handle: BackendHandle,
      request: ExecuteRequest,
    ): Promise<ExecuteResult> {
      this.executed.push(request.command);
      return { code: 0, stderr: "", stdout: this.kind };
    }

    public async cancel(): Promise<void> {}
    public async cleanup(): Promise<void> {}
  }

  it("prefers the local backend while it reports ready", async () => {
    const local = new FakeBackend("local");
    const remote = new FakeBackend("remote");
    const hybrid = new HybridExecutionBackend(local, remote);
    const handle = await hybrid.start("/workspace");

    const result = await hybrid.execute(handle, {
      command: "run",
      cwd: "/workspace",
    });
    expect(result.stdout).toBe("local");
    expect(local.executed).toEqual(["run"]);
    expect(remote.executed).toEqual([]);
  });

  it("falls back to the remote backend once the local backend is unavailable", async () => {
    const local = new FakeBackend("local");
    local.healthState = "unavailable";
    const remote = new FakeBackend("remote");
    const hybrid = new HybridExecutionBackend(local, remote);
    const handle = await hybrid.start("/workspace");

    // health() falls back the same way execute() does: local is unavailable,
    // so the reported health comes from a still-ready remote.
    expect(await hybrid.health(handle)).toBe("ready");
    const result = await hybrid.execute(handle, {
      command: "run",
      cwd: "/workspace",
    });
    expect(result.stdout).toBe("remote");
    expect(local.executed).toEqual([]);
    expect(remote.executed).toEqual(["run"]);
  });
});
