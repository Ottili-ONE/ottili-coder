import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { removeTempDirectory } from "../support/fs-cleanup.js";

import type {
  JsonRpcNotification,
  LspConnection,
  LspServerConfig,
  LspTransportFactory,
  McpConnection,
  McpServerConfig,
  McpTransportFactory,
} from "@ottili/integrations";
import {
  McpServerCatalog,
  McpServerSupervisor,
  parseMcpServerConfig,
} from "@ottili/integrations";
import { RunScheduler, RunStore, SqliteDatabase } from "@ottili/control-plane";
import type { JsonValue } from "@ottili/protocol";
import {
  LspServerManager,
  RunCoordinator,
  ScriptedProvider,
  ToolRegistry,
  createMcpTools,
  createWorkspaceTools,
} from "@ottili/runtime";
import { afterEach, describe, expect, it } from "vitest";

class FakeMcpConnection implements McpConnection {
  public calls = 0;
  private readonly closeListeners = new Set<(reason?: Error) => void>();

  public async request(method: string, params?: JsonValue): Promise<JsonValue> {
    switch (method) {
      case "initialize":
        return { capabilities: {} };
      case "tools/list":
        return {
          tools: [{ description: "Deploys the build.", name: "deploy" }],
        };
      case "tools/call":
        this.calls += 1;
        return {
          content: [
            { text: `deployed ${JSON.stringify(params)}`, type: "text" },
          ],
          isError: false,
        };
      default:
        throw new Error(`Unexpected MCP method ${method}`);
    }
  }

  public async notify(): Promise<void> {}

  public async close(): Promise<void> {
    for (const listener of this.closeListeners) listener(undefined);
  }

  public onNotification(): () => void {
    return () => {};
  }

  public onClose(listener: (reason?: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
}

class FakeMcpFactory implements McpTransportFactory {
  public constructor(private readonly connection: McpConnection) {}

  public async connect(_config: McpServerConfig): Promise<McpConnection> {
    return this.connection;
  }
}

class FakeLspConnection implements LspConnection {
  private readonly notificationListeners = new Set<
    (notification: JsonRpcNotification) => void
  >();

  public async request(method: string): Promise<JsonValue> {
    if (method === "initialize") return { capabilities: {} };
    if (method === "shutdown") return null;
    throw new Error(`Unexpected LSP method ${method}`);
  }

  public async notify(method: string, params?: JsonValue): Promise<void> {
    if (method !== "textDocument/didOpen") return;
    const { textDocument } = params as {
      readonly textDocument: { readonly uri: string };
    };
    queueMicrotask(() => {
      for (const listener of this.notificationListeners) {
        listener({
          jsonrpc: "2.0",
          method: "textDocument/publishDiagnostics",
          params: {
            diagnostics: [
              {
                message: "Missing return type.",
                range: {
                  end: { character: 10, line: 0 },
                  start: { character: 0, line: 0 },
                },
                severity: 1,
              },
            ],
            uri: textDocument.uri,
          },
        });
      }
    });
  }

  public async close(): Promise<void> {}

  public onNotification(
    listener: (notification: JsonRpcNotification) => void,
  ): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  public onClose(): () => void {
    return () => {};
  }
}

class FakeLspFactory implements LspTransportFactory {
  public constructor(private readonly connection: LspConnection) {}

  public async connect(_config: LspServerConfig): Promise<LspConnection> {
    return this.connection;
  }
}

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTempDirectory));
});

async function fixtureWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ottili-mcp-lsp-run-"));
  directories.push(directory);
  await writeFile(join(directory, "app.ts"), "function run() {}\n", "utf8");
  return directory;
}

/**
 * `pathToFileURL`/`fileURLToPath`, not string concatenation: on Windows a
 * raw drive path glued after `file://` has too few slashes and is misread as
 * an authority component (`file://D:\x` → host `D:`), the same class of bug
 * as ADR-015/ADR-016. `RunContextCompiler` parses `mission.workspaceUri`
 * with the real `fileURLToPath`, so the fixture must build a real URI.
 */
function workspaceUriFor(path: string): string {
  return pathToFileURL(path).href;
}

const deployToolCall = {
  input: { target: "staging" },
  name: "mcp.deploy-server.deploy",
};

/**
 * A durable approval pauses the whole turn: `authorizeTool` throws before a
 * tool intent is ever recorded, so nothing about the denied attempt survives
 * to be replayed automatically. Resuming after approval starts a fresh
 * session epoch that asks the provider again, so the script must reissue the
 * same call for the retry — this mirrors the equivalent workspace-tool
 * approval test in `runtime-coordinator.test.ts`.
 */
function mcpScheduler(
  store: RunStore,
  supervisor: McpServerSupervisor,
  executorId: string,
  attempts: number,
): RunScheduler {
  return new RunScheduler(
    store,
    new RunCoordinator(store, {
      model: "deterministic",
      provider: new ScriptedProvider(
        Array.from({ length: attempts }, (_, index) => ({
          toolCalls: [{ id: `deploy-${index + 1}`, ...deployToolCall }],
          type: "tool_calls" as const,
        })),
      ),
      tools: async ({ workspaceUri: uri }) => {
        const merged = new ToolRegistry();
        for (const registry of [
          createWorkspaceTools({ workspace: fileURLToPath(uri) }),
          await createMcpTools(supervisor),
        ]) {
          for (const definition of registry.list()) merged.register(definition);
        }
        return merged;
      },
    }),
    { executorId, leaseTtlMs: 60_000 },
  );
}

async function connectedDeployServer(
  mcpConnection: FakeMcpConnection,
): Promise<McpServerSupervisor> {
  const supervisor = new McpServerSupervisor(
    new McpServerCatalog([
      parseMcpServerConfig({
        id: "deploy-server",
        desiredState: "connected",
        transport: { command: "node", kind: "stdio" },
      }),
    ]),
    new FakeMcpFactory(mcpConnection),
  );
  await supervisor.reconcile();
  return supervisor;
}

describe("MCP and LSP composed into a real durable turn", () => {
  it("denies an MCP tool call under the default sandbox, which has network access disabled", async () => {
    const workspace = await fixtureWorkspace();
    const mcpConnection = new FakeMcpConnection();
    const supervisor = await connectedDeployServer(mcpConnection);

    const store = new RunStore(new SqliteDatabase(":memory:"));
    const created = store.createRun({
      permissions: { mode: "standard" },
      prompt: "Deploy through the configured MCP server.",
      workspaceUri: workspaceUriFor(workspace),
    });
    const scheduler = mcpScheduler(store, supervisor, "mcp-deny-test", 1);

    // The MCP tool declares a "network" permission requirement; the default
    // sandbox has network access disabled, and a sandbox capability denial
    // outranks the approval-prompt policy decision — the tool is refused
    // outright, never reaching the MCP server or a durable approval.
    await scheduler.tick();
    expect(mcpConnection.calls).toBe(0);
    expect(store.listApprovals(created.run.id)).toEqual([]);
    const denied = store
      .listEvents(created.run.id)
      .find(
        (event) =>
          event.type === "agent.progress" &&
          (event.payload as { readonly toolName?: unknown }).toolName ===
            "mcp.deploy-server.deploy",
      );
    expect(denied?.payload).toMatchObject({ decision: "deny" });
    await scheduler.stop();
  });

  it("gates an MCP tool call behind a durable approval once the sandbox allows network access", async () => {
    const workspace = await fixtureWorkspace();
    const mcpConnection = new FakeMcpConnection();
    const supervisor = await connectedDeployServer(mcpConnection);

    const store = new RunStore(new SqliteDatabase(":memory:"));
    const created = store.createRun({
      permissions: { mode: "standard" },
      prompt: "Deploy through the configured MCP server.",
      sandbox: {
        filesystem: { readOnlyRoots: [], writableRoots: [workspace] },
        network: { allowedDestinations: ["*"], enabled: true },
        permissions: { mode: "standard" },
        process: { enabled: true },
      },
      workspaceUri: workspaceUriFor(workspace),
    });
    const scheduler = mcpScheduler(store, supervisor, "mcp-approve-test", 2);

    // First tick: policy requires a durable approval before the MCP server is
    // ever contacted — the same rule an ordinary external-effect tool gets.
    await scheduler.tick();
    expect(mcpConnection.calls).toBe(0);
    const [approval] = store.listApprovals(created.run.id);
    expect(approval).toMatchObject({ status: "pending" });
    expect(store.getRun(created.run.id)?.status).toBe("waiting_external");
    if (approval === undefined) throw new Error("Expected a durable approval.");

    store.resolveApproval({
      approvalId: approval.id,
      resolverId: "integration-test",
      status: "approved",
    });
    await scheduler.tick();

    expect(mcpConnection.calls).toBe(1);
    const finished = store
      .listEvents(created.run.id)
      .find((event) => event.type === "tool.call_finished");
    expect(finished?.payload).toMatchObject({ success: true });
    // The lock scope came from MCP safety metadata, not a workspace file —
    // proving the tool's own declared resource scope reached the lock layer.
    expect(
      store
        .listEvents(created.run.id)
        .some(
          (event) =>
            event.type === "tool.call_started" &&
            event.payload.name === "mcp.deploy-server.deploy",
        ),
    ).toBe(true);
    await scheduler.stop();
  });

  it("runs a read-only LSP tool immediately and feeds the same diagnostics into the next turn's context", async () => {
    const workspace = await fixtureWorkspace();
    const lspManager = new LspServerManager(
      [{ command: "typescript-language-server", id: "ts" }],
      { transportFactory: new FakeLspFactory(new FakeLspConnection()) },
    );

    try {
      const store = new RunStore(new SqliteDatabase(":memory:"));
      const created = store.createRun({
        permissions: { mode: "standard" },
        prompt: "Check diagnostics for app.ts.",
        workspaceUri: workspaceUriFor(workspace),
      });
      const provider = new ScriptedProvider([
        {
          toolCalls: [
            {
              id: "diag-1",
              input: { path: "app.ts" },
              name: "lsp_diagnostics",
            },
          ],
          type: "tool_calls",
        },
        { text: "Reviewed the diagnostics.", type: "text" },
      ]);
      const scheduler = new RunScheduler(
        store,
        new RunCoordinator(store, {
          context: { diagnostics: lspManager },
          model: "deterministic",
          provider,
          tools: ({ workspaceUri: uri }) =>
            lspManager.createTools(fileURLToPath(uri)),
        }),
        { executorId: "lsp-compose-test", leaseTtlMs: 60_000 },
      );

      // A read-only LSP tool is never approval-gated: it executes in the same
      // turn it is requested, with no durable approval in between.
      await scheduler.tick();
      expect(store.listApprovals(created.run.id)).toEqual([]);
      expect(store.getRun(created.run.id)?.status).toBe("running");
      const toolFinished = store
        .listEvents(created.run.id)
        .find((event) => event.type === "tool.call_finished");
      expect(JSON.stringify(toolFinished?.payload)).toContain(
        "Missing return type.",
      );

      // The same durable diagnostics reach the next turn's compiled context
      // through the DiagnosticsProvider port, independent of the tool call.
      await scheduler.tick();
      const secondRequest = provider.requests.at(-1);
      const context = secondRequest?.messages
        .map((message) => message.content)
        .join("\n");
      expect(context).toContain("Missing return type.");

      await scheduler.stop();
    } finally {
      await lspManager.close();
    }
  });
});
