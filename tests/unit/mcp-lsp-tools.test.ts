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
import type { JsonValue } from "@ottili/protocol";
import { createMcpTools, LspServerManager } from "@ottili/runtime";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { removeTempDirectory } from "../support/fs-cleanup.js";
import { afterEach, describe, expect, it } from "vitest";

class FakeMcpConnection implements McpConnection {
  public readonly calls: Array<{
    readonly method: string;
    readonly params?: unknown;
  }> = [];
  private readonly closeListeners = new Set<(reason?: Error) => void>();

  public async request(method: string, params?: JsonValue): Promise<JsonValue> {
    this.calls.push({ method, ...(params === undefined ? {} : { params }) });
    switch (method) {
      case "initialize":
        return { capabilities: {} };
      case "tools/list":
        return {
          tools: [
            { description: "Runs the project formatter.", name: "format" },
          ],
        };
      case "tools/call": {
        const args = params as { readonly arguments?: JsonValue };
        return {
          content: [
            {
              text: `formatted ${JSON.stringify(args.arguments)}`,
              type: "text",
            },
          ],
          isError: false,
        };
      }
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
  public readonly opened: string[] = [];
  private readonly notificationListeners = new Set<
    (notification: JsonRpcNotification) => void
  >();

  public async request(method: string): Promise<JsonValue> {
    switch (method) {
      case "initialize":
        return { capabilities: {} };
      case "shutdown":
        return null;
      case "textDocument/documentSymbol":
        return [
          {
            kind: 12,
            name: "applyDiscount",
            range: {
              end: { character: 1, line: 3 },
              start: { character: 0, line: 0 },
            },
            selectionRange: {
              end: { character: 1, line: 3 },
              start: { character: 0, line: 0 },
            },
          },
        ];
      case "textDocument/definition":
        return [
          {
            range: {
              end: { character: 5, line: 0 },
              start: { character: 0, line: 0 },
            },
            uri: "file:///workspace/src/money.ts",
          },
        ];
      default:
        throw new Error(`Unexpected LSP method ${method}`);
    }
  }

  public async notify(method: string, params?: JsonValue): Promise<void> {
    if (method !== "textDocument/didOpen") return;
    const { textDocument } = params as {
      readonly textDocument: { readonly uri: string };
    };
    this.opened.push(textDocument.uri);
    // A real server publishes diagnostics asynchronously after didOpen.
    queueMicrotask(() => {
      for (const listener of this.notificationListeners) {
        listener({
          jsonrpc: "2.0",
          method: "textDocument/publishDiagnostics",
          params: {
            diagnostics: [
              {
                message: "Unused variable 'x'.",
                range: {
                  end: { character: 5, line: 1 },
                  start: { character: 0, line: 1 },
                },
                severity: 2,
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

async function realisticWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ottili-lsp-tools-"));
  directories.push(directory);
  await writeFile(
    join(directory, "money.ts"),
    "export function applyDiscount() {\n  const x = 1;\n  return x;\n}\n",
    "utf8",
  );
  return directory;
}

describe("durable MCP tools", () => {
  it("produces a real, callable tool for every connected server's declared tools", async () => {
    const connection = new FakeMcpConnection();
    const supervisor = new McpServerSupervisor(
      new McpServerCatalog([
        parseMcpServerConfig({
          id: "formatter",
          desiredState: "connected",
          transport: { command: "node", kind: "stdio" },
        }),
      ]),
      new FakeMcpFactory(connection),
    );
    await supervisor.reconcile();

    const tools = await createMcpTools(supervisor);
    const format = tools.get("mcp.formatter.format");
    expect(format).toBeDefined();
    // Safe conservative defaults from `toMcpToolDefinition` carry through.
    expect(format).toMatchObject({
      idempotency: "conditional",
      recovery: "reconcile",
      sideEffect: "external",
    });
    expect(format?.permissions?.requiresApproval).toBe(true);
    expect(format?.resourceScopes({})).toEqual(["service:mcp:formatter"]);

    const result = await format?.execute({ file: "money.ts" });
    expect(result?.output).toContain("formatted");
    expect(
      connection.calls.find((call) => call.method === "tools/call")?.params,
    ).toMatchObject({ arguments: { file: "money.ts" }, name: "format" });
  });

  it("contributes no tools for a server that is not connected", async () => {
    const supervisor = new McpServerSupervisor(
      new McpServerCatalog([
        parseMcpServerConfig({
          id: "unused",
          transport: { command: "node", kind: "stdio" },
        }),
      ]),
      new FakeMcpFactory(new FakeMcpConnection()),
    );
    // Deliberately never reconciled: desiredState defaults to disconnected.
    expect((await createMcpTools(supervisor)).list()).toEqual([]);
  });
});

describe("durable LSP tools and diagnostics", () => {
  it("opens a document, reports diagnostics, symbols, and a definition through the durable tool contract", async () => {
    const workspace = await realisticWorkspace();
    const connection = new FakeLspConnection();
    const manager = new LspServerManager(
      [{ command: "typescript-language-server", id: "ts" }],
      { transportFactory: new FakeLspFactory(connection) },
    );
    try {
      const tools = manager.createTools(workspace);
      expect(tools.list().map((tool) => tool.name)).toEqual([
        "lsp_definition",
        "lsp_diagnostics",
        "lsp_document_symbols",
      ]);

      const diagnosticsResult = await tools
        .get("lsp_diagnostics")
        ?.execute({ path: "money.ts" });
      expect(diagnosticsResult?.output).toContain("Unused variable");
      // The product builds this URI with `pathToFileURL`, not string
      // concatenation: on Windows that is `file:///C:/...` with percent
      // encoding, not the raw drive path glued onto a `file://` prefix.
      expect(connection.opened).toEqual([
        pathToFileURL(join(workspace, "money.ts")).href,
      ]);

      const symbolsResult = await tools
        .get("lsp_document_symbols")
        ?.execute({ path: "money.ts" });
      expect(symbolsResult?.output).toContain("applyDiscount");

      const definitionResult = await tools
        .get("lsp_definition")
        ?.execute({ character: 0, line: 0, path: "money.ts" });
      expect(definitionResult?.output).toContain("money.ts");

      // The context compiler's port surfaces the same durable diagnostics.
      const contextDiagnostics = await manager.diagnostics(workspace);
      expect(contextDiagnostics).toEqual([
        expect.objectContaining({
          message: "Unused variable 'x'.",
          path: "money.ts",
          severity: "warning",
        }),
      ]);
    } finally {
      await manager.close();
    }
  });

  it("contributes no tools when no LSP server is configured", () => {
    const manager = new LspServerManager([]);
    expect(manager.createTools("/workspace").list()).toEqual([]);
  });
});
