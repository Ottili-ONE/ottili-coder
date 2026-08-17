import {
  type JsonRpcNotification,
  type LspConnection,
  type LspServerConfig,
  type LspTransportFactory,
  type McpConnection,
  type McpServerConfig,
  type McpTransportFactory,
  LspClient,
  LspMessageParser,
  LspProtocolError,
  McpClient,
  McpConfigurationError,
  McpServerCatalog,
  McpServerSupervisor,
  StreamableHttpMcpConnection,
  parseLspServerConfig,
  parseMcpServerConfig,
  serializeLspMessage,
  toMcpToolDefinition,
} from "@ottili/integrations";
import type { JsonValue } from "@ottili/protocol";
import { describe, expect, it } from "vitest";

class FakeMcpConnection implements McpConnection {
  public readonly requests: Array<{
    readonly method: string;
    readonly params?: unknown;
  }> = [];
  public readonly notifications: Array<{
    readonly method: string;
    readonly params?: unknown;
  }> = [];
  private readonly closeListeners = new Set<(reason?: Error) => void>();
  private readonly notificationListeners = new Set<
    (notification: JsonRpcNotification) => void
  >();

  public async request(
    method: string,
    params?: JsonValue,
    _signal?: AbortSignal,
  ): Promise<JsonValue> {
    this.requests.push({ method, ...(params === undefined ? {} : { params }) });
    switch (method) {
      case "initialize":
        return { capabilities: {} };
      case "tools/list":
        return {
          tools: [
            {
              description: "Reads a project fact",
              inputSchema: { type: "object" },
              name: "project_fact",
            },
          ],
        };
      case "tools/call":
        return {
          content: [{ text: "ready", type: "text" }],
          structuredContent: { answer: 42 },
        };
      default:
        throw new Error(`Unexpected MCP method ${method}`);
    }
  }

  public async notify(method: string, params?: JsonValue): Promise<void> {
    this.notifications.push({
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  public async close(): Promise<void> {
    for (const listener of this.closeListeners) listener(undefined);
  }

  public onNotification(
    listener: (notification: JsonRpcNotification) => void,
  ): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  public onClose(listener: (reason?: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
}

class QueueMcpFactory implements McpTransportFactory {
  public attempts = 0;

  public constructor(
    private readonly connection: McpConnection,
    private failuresBeforeSuccess: number,
  ) {}

  public async connect(_config: McpServerConfig): Promise<McpConnection> {
    this.attempts += 1;
    if (this.failuresBeforeSuccess > 0) {
      this.failuresBeforeSuccess -= 1;
      throw new Error("temporary MCP outage");
    }
    return this.connection;
  }
}

class FakeLspConnection implements LspConnection {
  public readonly requests: Array<{
    readonly method: string;
    readonly params?: unknown;
  }> = [];
  public readonly notifications: Array<{
    readonly method: string;
    readonly params?: unknown;
  }> = [];
  public closed = false;
  private readonly closeListeners = new Set<(reason?: Error) => void>();
  private readonly notificationListeners = new Set<
    (notification: JsonRpcNotification) => void
  >();

  public async request(
    method: string,
    params?: JsonValue,
    _signal?: AbortSignal,
  ): Promise<JsonValue> {
    this.requests.push({ method, ...(params === undefined ? {} : { params }) });
    switch (method) {
      case "initialize":
        return { capabilities: { definitionProvider: true } };
      case "shutdown":
        return null;
      case "textDocument/definition":
        return [
          {
            range: {
              end: { character: 3, line: 2 },
              start: { character: 0, line: 2 },
            },
            uri: "file:///workspace/src/fact.ts",
          },
        ];
      case "textDocument/references":
        return [];
      case "textDocument/hover":
        return { contents: { kind: "markdown", value: "A project fact" } };
      case "textDocument/documentSymbol":
        return [];
      default:
        throw new Error(`Unexpected LSP method ${method}`);
    }
  }

  public async notify(method: string, params?: JsonValue): Promise<void> {
    this.notifications.push({
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  public async close(): Promise<void> {
    this.closed = true;
    for (const listener of this.closeListeners) listener(undefined);
  }

  public onNotification(
    listener: (notification: JsonRpcNotification) => void,
  ): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  public onClose(listener: (reason?: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  public emit(notification: JsonRpcNotification): void {
    for (const listener of this.notificationListeners) listener(notification);
  }
}

class FakeLspFactory implements LspTransportFactory {
  public constructor(private readonly connection: LspConnection) {}

  public async connect(_config: LspServerConfig): Promise<LspConnection> {
    return this.connection;
  }
}

describe("MCP integration", () => {
  it("keeps server configuration declarative and maps remote tools conservatively", async () => {
    const config = parseMcpServerConfig({
      id: "project-tools",
      reconnect: { baseDelayMs: 10, maxAttempts: 3, maxDelayMs: 100 },
      transport: {
        args: ["server.mjs"],
        command: process.execPath,
        kind: "stdio",
      },
    });
    expect(config.transport.kind).toBe("stdio");
    expect(() =>
      parseMcpServerConfig({
        id: "unsafe",
        module: "arbitrary-package",
        transport: { command: "x", kind: "stdio" },
      }),
    ).toThrow(McpConfigurationError);

    const connection = new FakeMcpConnection();
    const client = new McpClient(config.id, connection);
    await client.initialize();
    const [tool] = await client.listTools();
    expect(tool?.name).toBe("project_fact");
    const definition = toMcpToolDefinition(config.id, tool!);
    expect(definition).toMatchObject({
      idempotency: "conditional",
      name: "mcp.project-tools.project_fact",
      recovery: "reconcile",
      sideEffectClass: "external",
    });
    expect(await client.callTool("project_fact", {})).toMatchObject({
      isError: false,
      structuredContent: { answer: 42 },
    });
    expect(connection.notifications.map((entry) => entry.method)).toEqual([
      "notifications/initialized",
    ]);
  });

  it("reconciles a desired connection after a bounded retry delay", async () => {
    const connection = new FakeMcpConnection();
    const factory = new QueueMcpFactory(connection, 1);
    let now = new Date("2026-01-01T00:00:00.000Z");
    const supervisor = new McpServerSupervisor(
      new McpServerCatalog([
        {
          desiredState: "connected",
          id: "retryable",
          reconnect: { baseDelayMs: 5, maxAttempts: 3, maxDelayMs: 20 },
          transport: { command: process.execPath, kind: "stdio" },
        },
      ]),
      factory,
      { clock: { now: () => now } },
    );
    await supervisor.reconcile();
    expect(supervisor.get("retryable")).toMatchObject({
      attempt: 1,
      state: "reconnecting",
    });
    now = new Date(now.getTime() + 5);
    await supervisor.reconcile();
    expect(supervisor.get("retryable")).toMatchObject({
      attempt: 0,
      state: "connected",
    });
    expect(factory.attempts).toBe(2);
  });

  it("accepts streamable HTTP JSON-RPC replies carried by SSE", async () => {
    const connection = new StreamableHttpMcpConnection(
      { kind: "streamable-http", url: "https://mcp.example.test/v1" },
      async (_url, init) => {
        const request = JSON.parse(String(init.body)) as {
          readonly id: string;
        };
        return {
          headers: { get: () => "text/event-stream" },
          ok: true,
          status: 200,
          text: async () =>
            `data: ${JSON.stringify({ id: request.id, jsonrpc: "2.0", result: { ok: true } })}\n\n`,
        };
      },
    );
    await expect(connection.request("ping", {})).resolves.toEqual({ ok: true });
  });
});

describe("LSP integration", () => {
  it("parses split Content-Length frames and rejects malformed framing", () => {
    const parser = new LspMessageParser();
    const frame = serializeLspMessage({
      jsonrpc: "2.0",
      method: "$/progress",
      params: { value: 1 },
    });
    expect(parser.push(frame.subarray(0, 7))).toEqual([]);
    expect(parser.push(frame.subarray(7))).toEqual([
      { jsonrpc: "2.0", method: "$/progress", params: { value: 1 } },
    ]);
    expect(() =>
      parser.push("Content-Length: not-a-number\r\n\r\n{} "),
    ).toThrow(LspProtocolError);
  });

  it("initializes, captures diagnostics, serves intelligence requests, and shuts down cleanly", async () => {
    const connection = new FakeLspConnection();
    const client = new LspClient(
      {
        command: process.execPath,
        id: "typescript",
        rootUri: "file:///workspace",
      },
      new FakeLspFactory(connection),
    );
    await client.initialize();
    connection.emit({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        diagnostics: [
          {
            message: "Missing test",
            range: {
              end: { character: 5, line: 1 },
              start: { character: 0, line: 1 },
            },
            severity: 2,
          },
        ],
        uri: "file:///workspace/src/fact.ts",
      },
    });
    expect(client.diagnosticsFor("file:///workspace/src/fact.ts")).toHaveLength(
      1,
    );
    await expect(
      client.definition("file:///workspace/src/fact.ts", {
        character: 2,
        line: 1,
      }),
    ).resolves.toMatchObject([{ uri: "file:///workspace/src/fact.ts" }]);
    await client.openDocument(
      "file:///workspace/src/fact.ts",
      "typescript",
      1,
      "export const fact = 42",
    );
    await client.shutdown();
    expect(client.state).toBe("stopped");
    expect(connection.closed).toBe(true);
    expect(connection.requests.map((entry) => entry.method)).toEqual([
      "initialize",
      "textDocument/definition",
      "shutdown",
    ]);
    expect(connection.notifications.map((entry) => entry.method)).toEqual([
      "initialized",
      "textDocument/didOpen",
      "exit",
    ]);
  });

  it("rejects dynamic LSP loader settings", () => {
    expect(() =>
      parseLspServerConfig({
        command: "typescript-language-server",
        id: "ts",
        plugin: "untrusted",
      }),
    ).toThrow("plug-in/module loading is disabled");
  });
});
