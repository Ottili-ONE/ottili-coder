import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { removeTempDirectory } from "../support/fs-cleanup.js";

import type { Mission, MissionId, Run, RunId } from "@ottili/protocol";
import {
  inspectDaemon,
  readDaemonDescriptor,
  stopDaemon,
  writeDaemonDescriptor,
} from "../../apps/cli/src/daemon-client.js";
import { runCli, type CliWriter } from "../../apps/cli/src/commands.js";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => await removeTempDirectory(directory)),
  );
});

class BufferWriter implements CliWriter {
  readonly chunks: string[] = [];
  readonly isTTY: boolean;

  public constructor(isTTY = false) {
    this.isTTY = isTTY;
  }

  public write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  public text(): string {
    return this.chunks.join("");
  }
}

const run: Run = {
  budget: {},
  createdAt: "2026-08-17T00:00:00.000Z",
  id: "run-1111-2222-3333-4444" as RunId,
  missionId: "mission-1111-2222-3333-4444" as MissionId,
  revision: 1,
  status: "running",
  title: "Ship the client",
  updatedAt: "2026-08-17T00:00:00.000Z",
  usage: {
    cachedTokens: 0,
    childAgents: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    wallTimeMs: 0,
  },
};

const mission: Mission = {
  createdAt: run.createdAt,
  id: run.missionId,
  prompt: "Ship the client",
  title: run.title,
  updatedAt: run.updatedAt,
  workspaceUri: "file:///workspace",
};

function success(value: unknown): Response {
  return new Response(JSON.stringify({ ok: true, value }), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

describe("thin CLI client", () => {
  it("creates a Run through the daemon API without local execution state", async () => {
    const requests: Array<{
      readonly body?: string;
      readonly method?: string;
      readonly url: string;
    }> = [];
    const output = new BufferWriter();
    const exit = await runCli(
      ["run", "Ship", "the", "client", "--workspace", "/workspace", "--json"],
      {
        cwd: () => "/working-directory",
        environment: { OTTILI_CODER_DAEMON_URL: "http://daemon.test" },
        fetch: async (input, init) => {
          const body = typeof init?.body === "string" ? init.body : undefined;
          const method = init?.method;
          requests.push({
            url: String(input),
            ...(body === undefined ? {} : { body }),
            ...(method === undefined ? {} : { method }),
          });
          return success({ mission, run });
        },
        stdout: output,
      },
    );

    expect(exit).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "http://daemon.test/v1/runs",
    });
    expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({
      mission: {
        prompt: "Ship the client",
        // `/workspace` resolves against the host's current drive on Windows,
        // so the expected URI has to be derived the same way the CLI does.
        workspaceUri: pathToFileURL(resolve("/workspace")).href,
      },
    });
    expect(JSON.parse(output.text())).toMatchObject({ run: { id: run.id } });
  });

  // A Windows absolute path was silently treated as a URL: `new URL("C:\\x")`
  // succeeds with `protocol` `"c:"`, since a single letter followed by `:` is
  // syntactically a valid URL scheme. That URI then failed every downstream
  // `startsWith("file:")` check, so the daemon fell back to its own working
  // directory instead of the requested workspace — a wrong-but-successful Run.
  it("treats a Windows drive-letter path as a filesystem path, not a URL", async () => {
    const requests: string[] = [];
    const output = new BufferWriter();
    const exit = await runCli(
      [
        "run",
        "Ship",
        "the",
        "client",
        "--workspace",
        String.raw`C:\Users\example\project`,
        "--json",
      ],
      {
        cwd: () => "/working-directory",
        environment: { OTTILI_CODER_DAEMON_URL: "http://daemon.test" },
        fetch: async (_input, init) => {
          requests.push(typeof init?.body === "string" ? init.body : "{}");
          return success({ mission, run });
        },
        stdout: output,
      },
    );

    expect(exit).toBe(0);
    const sentWorkspaceUri = (
      JSON.parse(requests[0] ?? "{}") as {
        readonly mission: { readonly workspaceUri: string };
      }
    ).mission.workspaceUri;
    expect(sentWorkspaceUri.startsWith("file:")).toBe(true);
    expect(sentWorkspaceUri.startsWith("c:")).toBe(false);
  });

  it("reattaches from persisted events and exits cleanly in a non-interactive pipe", async () => {
    const output = new BufferWriter(false);
    const calls: string[] = [];
    const exit = await runCli(["attach", run.id, "--after", "0"], {
      environment: { OTTILI_CODER_DAEMON_URL: "http://daemon.test" },
      fetch: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith(`/v1/runs/${run.id}`))
          return success({ agents: [], run });
        if (url.endsWith(`/v1/runs/${run.id}/events?after=0`))
          return success({ events: [], nextSequence: 0 });
        throw new Error(`Unexpected request ${url}`);
      },
      stdout: output,
    });

    expect(exit).toBe(0);
    expect(calls).toEqual([
      `http://daemon.test/v1/runs/${run.id}`,
      `http://daemon.test/v1/runs/${run.id}/events?after=0`,
    ]);
    expect(output.text()).toContain(`Agents: 0`);
  });

  it("resolves a durable approval through the daemon instead of mutating local state", async () => {
    const output = new BufferWriter();
    const approvalId = "approval_0000000000000";
    const exit = await runCli(
      [
        "approvals",
        "resolve",
        run.id,
        approvalId,
        "approved",
        "--resolver",
        "operator@example.test",
        "--json",
      ],
      {
        environment: { OTTILI_CODER_DAEMON_URL: "http://daemon.test" },
        fetch: async (input, init) => {
          expect(String(input)).toBe(
            `http://daemon.test/v1/runs/${run.id}/approvals/${approvalId}`,
          );
          expect(init?.method).toBe("POST");
          expect(JSON.parse(String(init?.body))).toEqual({
            resolverId: "operator@example.test",
            status: "approved",
          });
          return success({
            approval: {
              createdAt: run.createdAt,
              id: approvalId,
              requestedAt: run.createdAt,
              resolverId: "operator@example.test",
              runId: run.id,
              status: "approved",
              summary: "Publish release",
              updatedAt: run.updatedAt,
            },
          });
        },
        stdout: output,
      },
    );

    expect(exit).toBe(0);
    expect(JSON.parse(output.text())).toMatchObject({
      approval: { id: approvalId, status: "approved" },
    });
  });

  it("reports usage errors with a nonzero process result", async () => {
    const stderr = new BufferWriter();
    await expect(runCli(["run", "--unknown"], { stderr })).resolves.toBe(2);
    expect(stderr.text()).toContain("Unknown option --unknown");
  });
});

describe("models command", () => {
  it("reports every provider kind's credential status without a daemon", async () => {
    const output = new BufferWriter();
    const exit = await runCli(["models", "--json"], {
      environment: { ANTHROPIC_API_KEY: "a", OTTILI_PROVIDER: "anthropic" },
      stdout: output,
    });
    expect(exit).toBe(0);
    const report = JSON.parse(output.text()) as {
      selectedKind: string;
      providers: readonly {
        kind: string;
        configured: boolean;
        selected: boolean;
      }[];
    };
    expect(report.selectedKind).toBe("anthropic");
    expect(report.providers).toContainEqual(
      expect.objectContaining({
        configured: true,
        kind: "anthropic",
        selected: true,
      }),
    );
    expect(report.providers).toContainEqual(
      expect.objectContaining({
        configured: false,
        kind: "openai",
        selected: false,
      }),
    );
  });

  it("reports no selection in plain text when OTTILI_PROVIDER is unset", async () => {
    const output = new BufferWriter();
    const exit = await runCli(["models"], { environment: {}, stdout: output });
    expect(exit).toBe(0);
    expect(output.text()).toContain(
      "No provider selected. Set OTTILI_PROVIDER",
    );
  });
});

describe("mcp command", () => {
  it("reports configured MCP and LSP servers from the same declarative env vars the daemon reads", async () => {
    const output = new BufferWriter();
    const exit = await runCli(["mcp", "--json"], {
      environment: {
        OTTILI_LSP_SERVERS: JSON.stringify([
          { command: "typescript-language-server", id: "ts" },
        ]),
        OTTILI_MCP_SERVERS: JSON.stringify([
          { id: "search", transport: { command: "search-mcp", kind: "stdio" } },
        ]),
      },
      stdout: output,
    });
    expect(exit).toBe(0);
    const report = JSON.parse(output.text()) as {
      mcpServers: readonly { id: string }[];
      lspServers: readonly { id: string }[];
    };
    expect(report.mcpServers).toEqual([
      expect.objectContaining({ id: "search" }),
    ]);
    expect(report.lspServers).toEqual([expect.objectContaining({ id: "ts" })]);
  });

  it("reports nothing configured rather than a daemon round trip when no servers are set", async () => {
    const output = new BufferWriter();
    const exit = await runCli(["mcp"], { environment: {}, stdout: output });
    expect(exit).toBe(0);
    expect(output.text()).toContain("No MCP or LSP servers configured");
  });

  it("surfaces malformed OTTILI_MCP_SERVERS as a usage error, not a crash", async () => {
    const stderr = new BufferWriter();
    const exit = await runCli(["mcp"], {
      environment: { OTTILI_MCP_SERVERS: "not json" },
      stderr,
    });
    expect(exit).toBe(2);
    expect(stderr.text()).toContain("OTTILI_MCP_SERVERS is not valid JSON");
  });
});

describe("daemon descriptor discovery", () => {
  it("atomically persists only daemon discovery metadata and probes readiness", async () => {
    const configDirectory = await mkdtemp(join(tmpdir(), "ottili-cli-daemon-"));
    temporaryDirectories.push(configDirectory);
    await writeDaemonDescriptor(
      {
        pid: process.pid,
        schemaVersion: 1,
        startedAt: "2026-08-17T00:00:00.000Z",
        url: "http://daemon.test",
        version: "0.1.0",
      },
      configDirectory,
    );

    await expect(readDaemonDescriptor(configDirectory)).resolves.toMatchObject({
      url: "http://daemon.test",
    });
    const status = await inspectDaemon({
      configDirectory,
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/v1/health"))
          return success({ status: "ok", version: "v1" });
        if (url.endsWith("/v1/ready")) return success({ ready: true });
        throw new Error(`Unexpected request ${url}`);
      },
    });
    expect(status).toMatchObject({
      pidAlive: true,
      reachable: true,
      ready: true,
      url: "http://daemon.test",
    });
  });

  it("will not signal a legacy descriptor without a daemon instance identity", async () => {
    const configDirectory = await mkdtemp(join(tmpdir(), "ottili-cli-daemon-"));
    temporaryDirectories.push(configDirectory);
    await writeDaemonDescriptor(
      {
        pid: process.pid,
        schemaVersion: 1,
        startedAt: "2026-08-17T00:00:00.000Z",
        url: "http://daemon.test",
      },
      configDirectory,
    );

    await expect(stopDaemon({ configDirectory })).rejects.toThrow(
      "no immutable daemon identity",
    );
  });
});
