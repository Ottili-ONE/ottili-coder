import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import type {
  JsonObject,
  JsonValue,
  PermissionAction,
  ResourceScope,
  ToolDefinition,
  ToolIdempotency,
  ToolPermissionPolicy,
  ToolRecoveryStrategy,
  ToolSideEffectClass,
} from "@ottili/protocol";

/**
 * MCP integration deliberately accepts declarative server definitions only.
 * In particular, it never resolves a package name, imports a module, or runs a
 * shell string. A configured stdio command is started with `shell: false`.
 */
export type McpDesiredState = "connected" | "disconnected";
export type McpServerState =
  "disconnected" | "connecting" | "connected" | "reconnecting" | "failed";

export interface McpStdioTransportConfig {
  readonly kind: "stdio";
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface McpStreamableHttpTransportConfig {
  readonly kind: "streamable-http";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export type McpTransportConfig =
  McpStdioTransportConfig | McpStreamableHttpTransportConfig;

export interface McpReconnectPolicy {
  /** Total failed connection attempts before supervision stops retrying. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export interface McpServerConfig {
  readonly id: string;
  readonly transport: McpTransportConfig;
  readonly desiredState?: McpDesiredState;
  readonly reconnect?: Partial<McpReconnectPolicy>;
}

export interface McpToolSafetyMetadata {
  readonly sideEffectClass?: ToolSideEffectClass;
  readonly idempotency?: ToolIdempotency;
  readonly recovery?: ToolRecoveryStrategy;
  readonly supportsBackground?: boolean;
  readonly resourceScopes?: readonly ResourceScope[];
  readonly permissions?: ToolPermissionPolicy;
}

export interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: JsonObject;
  readonly annotations?: JsonObject;
}

export interface McpToolResult {
  readonly content: readonly JsonObject[];
  readonly structuredContent?: JsonObject;
  readonly isError: boolean;
}

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: JsonValue;
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: JsonValue;
}

export interface JsonRpcSuccessResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result: JsonValue;
}

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: JsonValue;
}

export interface JsonRpcErrorResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly error: JsonRpcErrorObject;
}

export type JsonRpcMessage =
  | JsonRpcErrorResponse
  | JsonRpcNotification
  | JsonRpcRequest
  | JsonRpcSuccessResponse;

export interface McpInitializeResult {
  readonly protocolVersion?: string;
  readonly capabilities: JsonObject;
  readonly serverInfo?: {
    readonly name: string;
    readonly version?: string;
  };
  readonly instructions?: string;
}

export interface McpClientOptions {
  readonly protocolVersion?: string;
  readonly clientName?: string;
  readonly clientVersion?: string;
}

export interface McpConnection {
  request(
    method: string,
    params?: JsonValue,
    signal?: AbortSignal,
  ): Promise<JsonValue>;
  notify(method: string, params?: JsonValue): Promise<void>;
  close(): Promise<void>;
  onNotification(
    listener: (notification: JsonRpcNotification) => void,
  ): () => void;
  onClose(listener: (reason?: Error) => void): () => void;
}

export interface McpTransportFactory {
  connect(config: McpServerConfig): Promise<McpConnection>;
}

export interface McpServerStatus {
  readonly id: string;
  readonly desiredState: McpDesiredState;
  readonly state: McpServerState;
  readonly attempt: number;
  readonly nextReconnectAt?: string;
  readonly connectedAt?: string;
  readonly lastError?: McpFailure;
}

export interface McpFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface McpClock {
  now(): Date;
}

export const DEFAULT_MCP_RECONNECT_POLICY: McpReconnectPolicy = Object.freeze({
  baseDelayMs: 1_000,
  maxAttempts: 3,
  maxDelayMs: 30_000,
});

export class McpIntegrationError extends Error {
  public constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "McpIntegrationError";
  }
}

export class McpConfigurationError extends McpIntegrationError {
  public constructor(message: string) {
    super(message, "MCP_CONFIGURATION", false);
    this.name = "McpConfigurationError";
  }
}

export class McpProtocolError extends McpIntegrationError {
  public constructor(message: string) {
    super(message, "MCP_PROTOCOL", false);
    this.name = "McpProtocolError";
  }
}

export class McpTransportError extends McpIntegrationError {
  public constructor(message: string, retryable = true) {
    super(message, "MCP_TRANSPORT", retryable);
    this.name = "McpTransportError";
  }
}

export class McpRpcError extends McpIntegrationError {
  public constructor(
    readonly rpcCode: number,
    message: string,
    readonly data?: JsonValue,
  ) {
    super(message, "MCP_RPC", rpcCode === -32_000 || rpcCode === -32_001);
    this.name = "McpRpcError";
  }
}

const systemClock: McpClock = {
  now: (): Date => new Date(),
};

const prohibitedConfigKeys = new Set([
  "module",
  "package",
  "plugin",
  "loader",
  "require",
  "import",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value))
    throw new McpConfigurationError(`${label} must be a JSON object.`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new McpConfigurationError(`${label} must be a non-empty string.`);
  }
  return value;
}

function assertKnownKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    if (prohibitedConfigKeys.has(key)) {
      throw new McpConfigurationError(
        `${label}.${key} is not supported; MCP plug-in/module loading is disabled.`,
      );
    }
    if (!allowed.has(key)) {
      throw new McpConfigurationError(
        `${label}.${key} is not a supported declarative setting.`,
      );
    }
  }
}

function parseStringArray(value: unknown, label: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new McpConfigurationError(`${label} must be an array of strings.`);
  }
  return value;
}

function parseStringRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, string>> {
  const record = requireRecord(value, label);
  const parsed: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== "string")
      throw new McpConfigurationError(`${label}.${key} must be a string.`);
    parsed[key] = item;
  }
  return parsed;
}

function parseDesiredState(value: unknown): McpDesiredState {
  if (value === "connected" || value === "disconnected") return value;
  throw new McpConfigurationError(
    "MCP desiredState must be connected or disconnected.",
  );
}

function parseReconnect(value: unknown): Partial<McpReconnectPolicy> {
  const record = requireRecord(value, "MCP reconnect");
  assertKnownKeys(
    record,
    ["maxAttempts", "baseDelayMs", "maxDelayMs"],
    "MCP reconnect",
  );
  const parseLimit = (key: keyof McpReconnectPolicy): number | undefined => {
    const candidate = record[key];
    if (candidate === undefined) return undefined;
    if (
      typeof candidate !== "number" ||
      !Number.isInteger(candidate) ||
      candidate < 0
    ) {
      throw new McpConfigurationError(
        `MCP reconnect.${key} must be a non-negative integer.`,
      );
    }
    return candidate;
  };
  const maxAttempts = parseLimit("maxAttempts");
  const baseDelayMs = parseLimit("baseDelayMs");
  const maxDelayMs = parseLimit("maxDelayMs");
  return {
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
    ...(baseDelayMs === undefined ? {} : { baseDelayMs }),
    ...(maxDelayMs === undefined ? {} : { maxDelayMs }),
  };
}

function parseTransport(value: unknown): McpTransportConfig {
  const record = requireRecord(value, "MCP transport");
  const kind = record.kind;
  if (kind === "stdio") {
    assertKnownKeys(
      record,
      ["kind", "command", "args", "cwd", "env"],
      "MCP stdio transport",
    );
    const command = requireString(record.command, "MCP stdio command");
    const args =
      record.args === undefined
        ? undefined
        : parseStringArray(record.args, "MCP stdio args");
    const cwd =
      record.cwd === undefined
        ? undefined
        : requireString(record.cwd, "MCP stdio cwd");
    const env =
      record.env === undefined
        ? undefined
        : parseStringRecord(record.env, "MCP stdio env");
    return {
      kind,
      command,
      ...(args === undefined ? {} : { args }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(env === undefined ? {} : { env }),
    };
  }
  if (kind === "streamable-http") {
    assertKnownKeys(
      record,
      ["kind", "url", "headers"],
      "MCP streamable HTTP transport",
    );
    const url = requireString(record.url, "MCP streamable HTTP URL");
    assertSafeMcpUrl(url);
    const headers =
      record.headers === undefined
        ? undefined
        : parseStringRecord(record.headers, "MCP streamable HTTP headers");
    return { kind, url, ...(headers === undefined ? {} : { headers }) };
  }
  throw new McpConfigurationError(
    "MCP transport.kind must be stdio or streamable-http.",
  );
}

/** Parses an untrusted configuration object and rejects module/plugin loading knobs. */
export function parseMcpServerConfig(value: unknown): McpServerConfig {
  const record = requireRecord(value, "MCP server");
  assertKnownKeys(
    record,
    ["id", "transport", "desiredState", "reconnect"],
    "MCP server",
  );
  const id = requireString(record.id, "MCP server id");
  if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(id)) {
    throw new McpConfigurationError(
      "MCP server id must use letters, numbers, underscores, or dashes.",
    );
  }
  const transport = parseTransport(record.transport);
  const desiredState =
    record.desiredState === undefined
      ? undefined
      : parseDesiredState(record.desiredState);
  const reconnect =
    record.reconnect === undefined
      ? undefined
      : parseReconnect(record.reconnect);
  return {
    id,
    transport,
    ...(desiredState === undefined ? {} : { desiredState }),
    ...(reconnect === undefined ? {} : { reconnect }),
  };
}

/** Validates a typed configuration at a runtime boundary as well. */
export function assertMcpServerConfig(config: McpServerConfig): void {
  parseMcpServerConfig(config);
}

function assertSafeMcpUrl(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new McpConfigurationError(
      "MCP streamable HTTP URL must be absolute.",
    );
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new McpConfigurationError(
      "MCP streamable HTTP URLs must not contain credentials.",
    );
  }
  if (url.protocol === "https:") return;
  const localHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]");
  if (!localHttp) {
    throw new McpConfigurationError(
      "MCP streamable HTTP requires HTTPS except for a loopback server.",
    );
  }
}

function normalizeReconnectPolicy(
  policy?: Partial<McpReconnectPolicy>,
): McpReconnectPolicy {
  const normalized: McpReconnectPolicy = {
    baseDelayMs:
      policy?.baseDelayMs ?? DEFAULT_MCP_RECONNECT_POLICY.baseDelayMs,
    maxAttempts:
      policy?.maxAttempts ?? DEFAULT_MCP_RECONNECT_POLICY.maxAttempts,
    maxDelayMs: policy?.maxDelayMs ?? DEFAULT_MCP_RECONNECT_POLICY.maxDelayMs,
  };
  if (
    !Number.isInteger(normalized.maxAttempts) ||
    normalized.maxAttempts < 0 ||
    !Number.isInteger(normalized.baseDelayMs) ||
    normalized.baseDelayMs < 0 ||
    !Number.isInteger(normalized.maxDelayMs) ||
    normalized.maxDelayMs < normalized.baseDelayMs
  ) {
    throw new McpConfigurationError("MCP reconnect policy has invalid limits.");
  }
  return normalized;
}

function jsonRpcId(value: unknown): JsonRpcId | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

/** Strictly parses a JSON-RPC 2.0 message so transport failures cannot masquerade as successful tool calls. */
export function parseJsonRpcMessage(value: unknown): JsonRpcMessage {
  if (!isRecord(value) || value.jsonrpc !== "2.0") {
    throw new McpProtocolError("Expected a JSON-RPC 2.0 object.");
  }
  if (typeof value.method === "string") {
    if (value.params !== undefined && !isJsonValue(value.params)) {
      throw new McpProtocolError(
        "JSON-RPC request parameters must be JSON values.",
      );
    }
    const id = Object.hasOwn(value, "id") ? jsonRpcId(value.id) : undefined;
    if (Object.hasOwn(value, "id") && id === undefined) {
      throw new McpProtocolError(
        "JSON-RPC request id must be a string or finite number.",
      );
    }
    const shared = {
      jsonrpc: "2.0" as const,
      method: value.method,
      ...(value.params === undefined ? {} : { params: value.params }),
    };
    return id === undefined ? shared : { ...shared, id };
  }

  const id = jsonRpcId(value.id);
  if (id === undefined)
    throw new McpProtocolError(
      "JSON-RPC response id must be a string or finite number.",
    );
  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");
  if (hasResult === hasError) {
    throw new McpProtocolError(
      "JSON-RPC responses must contain exactly one of result or error.",
    );
  }
  if (hasResult) {
    if (!isJsonValue(value.result))
      throw new McpProtocolError("JSON-RPC result must be a JSON value.");
    return { id, jsonrpc: "2.0", result: value.result };
  }
  if (
    !isRecord(value.error) ||
    typeof value.error.code !== "number" ||
    typeof value.error.message !== "string"
  ) {
    throw new McpProtocolError("JSON-RPC error response is malformed.");
  }
  if (value.error.data !== undefined && !isJsonValue(value.error.data)) {
    throw new McpProtocolError("JSON-RPC error data must be a JSON value.");
  }
  return {
    error: {
      code: value.error.code,
      message: value.error.message,
      ...(value.error.data === undefined ? {} : { data: value.error.data }),
    },
    id,
    jsonrpc: "2.0",
  };
}

function asJsonObject(value: JsonValue, message: string): JsonObject {
  if (!isRecord(value)) throw new McpProtocolError(message);
  return value;
}

function parseMcpTool(value: unknown): McpToolDescriptor {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    value.name.trim().length === 0
  ) {
    throw new McpProtocolError(
      "MCP tools/list returned a tool without a valid name.",
    );
  }
  if (
    value.description !== undefined &&
    typeof value.description !== "string"
  ) {
    throw new McpProtocolError(
      `MCP tool ${value.name} has a non-string description.`,
    );
  }
  if (value.inputSchema !== undefined && !isRecord(value.inputSchema)) {
    throw new McpProtocolError(
      `MCP tool ${value.name} has an invalid input schema.`,
    );
  }
  if (value.annotations !== undefined && !isRecord(value.annotations)) {
    throw new McpProtocolError(
      `MCP tool ${value.name} has invalid annotations.`,
    );
  }
  return {
    name: value.name,
    ...(value.description === undefined
      ? {}
      : { description: value.description }),
    ...(value.inputSchema === undefined
      ? {}
      : { inputSchema: value.inputSchema as JsonObject }),
    ...(value.annotations === undefined
      ? {}
      : { annotations: value.annotations as JsonObject }),
  };
}

function parseMcpToolResult(value: JsonValue): McpToolResult {
  const record = asJsonObject(
    value,
    "MCP tools/call returned a non-object result.",
  );
  if (!Array.isArray(record.content) || !record.content.every(isRecord)) {
    throw new McpProtocolError(
      "MCP tools/call result must include an array of content objects.",
    );
  }
  if (
    record.structuredContent !== undefined &&
    !isRecord(record.structuredContent)
  ) {
    throw new McpProtocolError(
      "MCP tools/call structuredContent must be an object.",
    );
  }
  if (record.isError !== undefined && typeof record.isError !== "boolean") {
    throw new McpProtocolError("MCP tools/call isError must be a boolean.");
  }
  return {
    content: record.content as readonly JsonObject[],
    ...(record.structuredContent === undefined
      ? {}
      : { structuredContent: record.structuredContent as JsonObject }),
    isError: record.isError === true,
  };
}

/** A typed MCP client over any transport; callers cannot invoke a server before initialize succeeds. */
export class McpClient {
  private initialized = false;

  public constructor(
    public readonly serverId: string,
    private readonly connection: McpConnection,
    private readonly options: McpClientOptions = {},
  ) {}

  public async initialize(signal?: AbortSignal): Promise<McpInitializeResult> {
    const result = await this.connection.request(
      "initialize",
      {
        capabilities: {},
        clientInfo: {
          name: this.options.clientName ?? "ottili-coder",
          version: this.options.clientVersion ?? "0.1.0",
        },
        protocolVersion: this.options.protocolVersion ?? "2025-03-26",
      },
      signal,
    );
    const record = asJsonObject(
      result,
      "MCP initialize returned a non-object result.",
    );
    if (record.capabilities !== undefined && !isRecord(record.capabilities)) {
      throw new McpProtocolError(
        "MCP initialize capabilities must be an object.",
      );
    }
    if (
      record.protocolVersion !== undefined &&
      typeof record.protocolVersion !== "string"
    ) {
      throw new McpProtocolError(
        "MCP initialize protocolVersion must be a string.",
      );
    }
    if (
      record.instructions !== undefined &&
      typeof record.instructions !== "string"
    ) {
      throw new McpProtocolError(
        "MCP initialize instructions must be a string.",
      );
    }
    if (
      record.serverInfo !== undefined &&
      (!isRecord(record.serverInfo) ||
        typeof record.serverInfo.name !== "string")
    ) {
      throw new McpProtocolError(
        "MCP initialize serverInfo must contain a name.",
      );
    }
    const serverInfo = isRecord(record.serverInfo)
      ? {
          name: record.serverInfo.name as string,
          ...(typeof record.serverInfo.version === "string"
            ? { version: record.serverInfo.version }
            : {}),
        }
      : undefined;
    this.initialized = true;
    await this.connection.notify("notifications/initialized");
    return {
      capabilities: isRecord(record.capabilities)
        ? (record.capabilities as JsonObject)
        : {},
      ...(typeof record.protocolVersion === "string"
        ? { protocolVersion: record.protocolVersion }
        : {}),
      ...(serverInfo === undefined ? {} : { serverInfo }),
      ...(typeof record.instructions === "string"
        ? { instructions: record.instructions }
        : {}),
    };
  }

  public async listTools(
    signal?: AbortSignal,
  ): Promise<readonly McpToolDescriptor[]> {
    this.assertInitialized();
    const result = asJsonObject(
      await this.connection.request("tools/list", {}, signal),
      "MCP tools/list returned a non-object result.",
    );
    if (!Array.isArray(result.tools))
      throw new McpProtocolError(
        "MCP tools/list result must contain a tools array.",
      );
    return result.tools.map(parseMcpTool);
  }

  public async callTool(
    name: string,
    args: JsonObject,
    signal?: AbortSignal,
  ): Promise<McpToolResult> {
    this.assertInitialized();
    if (name.trim().length === 0)
      throw new McpProtocolError("MCP tool name must not be empty.");
    return parseMcpToolResult(
      await this.connection.request(
        "tools/call",
        { arguments: args, name },
        signal,
      ),
    );
  }

  public async close(): Promise<void> {
    this.initialized = false;
    await this.connection.close();
  }

  public onNotification(
    listener: (notification: JsonRpcNotification) => void,
  ): () => void {
    return this.connection.onNotification(listener);
  }

  public onClose(listener: (reason?: Error) => void): () => void {
    return this.connection.onClose(listener);
  }

  private assertInitialized(): void {
    if (!this.initialized)
      throw new McpProtocolError(
        `MCP server ${this.serverId} has not completed initialize.`,
      );
  }
}

interface ManagedMcpServer {
  readonly config: McpServerConfig;
  desiredState: McpDesiredState;
  state: McpServerState;
  attempt: number;
  nextReconnectAt: Date | undefined;
  connectedAt: Date | undefined;
  lastError: McpFailure | undefined;
  client: McpClient | undefined;
  unsubscribeClose: (() => void) | undefined;
  connecting: Promise<McpClient> | undefined;
}

/** Static catalog; it cannot load MCP plug-ins or JavaScript modules. */
export class McpServerCatalog {
  private readonly servers = new Map<string, McpServerConfig>();

  public constructor(configs: readonly McpServerConfig[]) {
    for (const config of configs) {
      assertMcpServerConfig(config);
      if (this.servers.has(config.id))
        throw new McpConfigurationError(
          `MCP server ${config.id} is configured more than once.`,
        );
      this.servers.set(config.id, config);
    }
  }

  public get(id: string): McpServerConfig {
    const config = this.servers.get(id);
    if (config === undefined)
      throw new McpConfigurationError(`Unknown MCP server ${id}.`);
    return config;
  }

  public list(): readonly McpServerConfig[] {
    return [...this.servers.values()];
  }
}

/**
 * Reconnection is scheduler-driven through reconcile(), rather than hidden
 * timers. That makes desired state durable and recovery deterministic.
 */
export class McpServerSupervisor {
  private readonly entries = new Map<string, ManagedMcpServer>();
  private readonly clock: McpClock;

  public constructor(
    catalog: McpServerCatalog,
    private readonly transportFactory: McpTransportFactory,
    options: {
      readonly clock?: McpClock;
      readonly client?: McpClientOptions;
    } = {},
  ) {
    this.clock = options.clock ?? systemClock;
    for (const config of catalog.list()) {
      this.entries.set(config.id, {
        attempt: 0,
        client: undefined,
        config,
        connectedAt: undefined,
        desiredState: config.desiredState ?? "disconnected",
        lastError: undefined,
        nextReconnectAt: undefined,
        state: "disconnected",
        unsubscribeClose: undefined,
        connecting: undefined,
      });
    }
    this.clientOptions = options.client ?? {};
  }

  private readonly clientOptions: McpClientOptions;

  public list(): readonly McpServerStatus[] {
    return [...this.entries.values()].map((entry) => this.status(entry));
  }

  public get(id: string): McpServerStatus {
    return this.status(this.entry(id));
  }

  public async setDesiredState(
    id: string,
    desiredState: McpDesiredState,
  ): Promise<McpServerStatus> {
    const entry = this.entry(id);
    entry.desiredState = desiredState;
    if (desiredState === "disconnected") {
      await this.closeEntry(entry);
      entry.state = "disconnected";
      entry.attempt = 0;
      entry.nextReconnectAt = undefined;
      return this.status(entry);
    }
    if (entry.state === "failed") {
      entry.attempt = 0;
      entry.nextReconnectAt = undefined;
      entry.lastError = undefined;
      entry.state = "disconnected";
    }
    return this.status(entry);
  }

  public async connect(id: string, signal?: AbortSignal): Promise<McpClient> {
    const entry = this.entry(id);
    await this.setDesiredState(id, "connected");
    return await this.open(entry, signal, true);
  }

  public async disconnect(id: string): Promise<McpServerStatus> {
    return await this.setDesiredState(id, "disconnected");
  }

  public async reconcile(
    now = this.clock.now(),
  ): Promise<readonly McpServerStatus[]> {
    for (const entry of this.entries.values()) {
      if (
        entry.desiredState !== "connected" ||
        entry.client !== undefined ||
        entry.connecting !== undefined
      )
        continue;
      if (entry.state === "failed") continue;
      if (entry.nextReconnectAt !== undefined && entry.nextReconnectAt > now)
        continue;
      try {
        await this.open(entry, undefined, false);
      } catch {
        // The failure is recorded as status; one broken server must not stop others.
      }
    }
    return this.list();
  }

  public async listTools(
    id: string,
    signal?: AbortSignal,
  ): Promise<readonly McpToolDescriptor[]> {
    const client = await this.connect(id, signal);
    return await client.listTools(signal);
  }

  public async callTool(
    id: string,
    name: string,
    args: JsonObject,
    signal?: AbortSignal,
  ): Promise<McpToolResult> {
    const client = await this.connect(id, signal);
    return await client.callTool(name, args, signal);
  }

  private entry(id: string): ManagedMcpServer {
    const entry = this.entries.get(id);
    if (entry === undefined)
      throw new McpConfigurationError(`Unknown MCP server ${id}.`);
    return entry;
  }

  private async open(
    entry: ManagedMcpServer,
    signal: AbortSignal | undefined,
    manual: boolean,
  ): Promise<McpClient> {
    if (entry.client !== undefined) return entry.client;
    if (entry.connecting !== undefined) return await entry.connecting;
    if (entry.desiredState !== "connected") {
      throw new McpTransportError(
        `MCP server ${entry.config.id} is desired-disconnected.`,
        false,
      );
    }
    if (manual && entry.state === "failed") {
      entry.attempt = 0;
      entry.lastError = undefined;
      entry.nextReconnectAt = undefined;
    }
    const connecting = this.connectEntry(entry, signal);
    entry.connecting = connecting;
    try {
      return await connecting;
    } finally {
      if (entry.connecting === connecting) entry.connecting = undefined;
    }
  }

  private async connectEntry(
    entry: ManagedMcpServer,
    signal?: AbortSignal,
  ): Promise<McpClient> {
    entry.state = entry.attempt === 0 ? "connecting" : "reconnecting";
    try {
      const connection = await this.transportFactory.connect(entry.config);
      const client = new McpClient(
        entry.config.id,
        connection,
        this.clientOptions,
      );
      entry.client = client;
      entry.unsubscribeClose = client.onClose((reason) => {
        if (entry.client !== client) return;
        entry.client = undefined;
        entry.unsubscribeClose = undefined;
        if (entry.desiredState === "connected")
          this.recordFailure(
            entry,
            reason ??
              new McpTransportError("MCP connection closed unexpectedly."),
          );
      });
      await client.initialize(signal);
      entry.attempt = 0;
      entry.connectedAt = this.clock.now();
      entry.lastError = undefined;
      entry.nextReconnectAt = undefined;
      entry.state = "connected";
      return client;
    } catch (error: unknown) {
      await this.closeEntry(entry);
      this.recordFailure(entry, error);
      throw error;
    }
  }

  private recordFailure(entry: ManagedMcpServer, error: unknown): void {
    const failure = toMcpFailure(error);
    entry.client = undefined;
    entry.connectedAt = undefined;
    entry.lastError = failure;
    entry.attempt += 1;
    const policy = normalizeReconnectPolicy(entry.config.reconnect);
    if (
      entry.desiredState === "connected" &&
      failure.retryable &&
      entry.attempt < policy.maxAttempts
    ) {
      const delay = Math.min(
        policy.maxDelayMs,
        policy.baseDelayMs * 2 ** Math.max(0, entry.attempt - 1),
      );
      entry.nextReconnectAt = new Date(this.clock.now().getTime() + delay);
      entry.state = "reconnecting";
      return;
    }
    entry.nextReconnectAt = undefined;
    entry.state = "failed";
  }

  private async closeEntry(entry: ManagedMcpServer): Promise<void> {
    const unsubscribe = entry.unsubscribeClose;
    entry.unsubscribeClose = undefined;
    unsubscribe?.();
    const client = entry.client;
    entry.client = undefined;
    entry.connectedAt = undefined;
    if (client !== undefined) await client.close();
  }

  private status(entry: ManagedMcpServer): McpServerStatus {
    return {
      attempt: entry.attempt,
      desiredState: entry.desiredState,
      id: entry.config.id,
      state: entry.state,
      ...(entry.nextReconnectAt === undefined
        ? {}
        : { nextReconnectAt: entry.nextReconnectAt.toISOString() }),
      ...(entry.connectedAt === undefined
        ? {}
        : { connectedAt: entry.connectedAt.toISOString() }),
      ...(entry.lastError === undefined ? {} : { lastError: entry.lastError }),
    };
  }
}

function toMcpFailure(error: unknown): McpFailure {
  if (error instanceof McpIntegrationError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  if (error instanceof Error)
    return { code: "MCP_UNKNOWN", message: error.message, retryable: true };
  return {
    code: "MCP_UNKNOWN",
    message: "Unknown MCP connection failure.",
    retryable: true,
  };
}

/**
 * Maps a discovered MCP tool into the ordinary Ottili tool/recovery contract.
 * Unknown remote tools are conservative by default: external, conditional,
 * reconciliation-required, and approval-gated.
 */
export function toMcpToolDefinition(
  serverId: string,
  tool: McpToolDescriptor,
  metadata: McpToolSafetyMetadata = {},
): ToolDefinition {
  if (serverId.trim().length === 0 || tool.name.trim().length === 0) {
    throw new McpConfigurationError(
      "MCP server and tool names must not be empty.",
    );
  }
  return {
    idempotency: metadata.idempotency ?? "conditional",
    name: `mcp.${serverId}.${tool.name}`,
    permissions: metadata.permissions ?? {
      required: ["external", "network" satisfies PermissionAction],
      requiresApproval: true,
    },
    recovery: metadata.recovery ?? "reconcile",
    resourceScopes: metadata.resourceScopes ?? [
      {
        access: "write",
        identifier: `mcp:${serverId}`,
        kind: "service",
      },
    ],
    sideEffectClass: metadata.sideEffectClass ?? "external",
    supportsBackground: metadata.supportsBackground ?? false,
    ...(tool.description === undefined
      ? {}
      : { description: tool.description }),
    ...(tool.inputSchema === undefined
      ? {}
      : { inputSchema: tool.inputSchema }),
  };
}

interface PendingRequest {
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (value: JsonValue) => void;
  readonly removeAbortListener: () => void;
}

/** JSON-lines transport used by standard MCP stdio servers. */
export class NodeStdioMcpConnection implements McpConnection {
  private readonly closeListeners = new Set<(reason?: Error) => void>();
  private readonly notificationListeners = new Set<
    (notification: JsonRpcNotification) => void
  >();
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly decoder = new StringDecoder("utf8");
  private nextId = 1;
  private buffered = "";
  private closed = false;
  private closeReason: Error | undefined;

  private constructor(private readonly child: ReturnType<typeof spawn>) {
    this.child.stdout?.on("data", (chunk: Buffer) => this.consume(chunk));
    this.child.stderr?.on("data", () => {
      // Stderr is intentionally not parsed as protocol data or leaked into events.
    });
    this.child.once("error", (error: Error) =>
      this.finish(new McpTransportError(error.message)),
    );
    this.child.once("close", (code: number | null) => {
      this.finish(
        new McpTransportError(
          `MCP stdio process exited with code ${code ?? "unknown"}.`,
        ),
      );
    });
  }

  public static async connect(
    config: McpStdioTransportConfig,
  ): Promise<NodeStdioMcpConnection> {
    const child = spawn(config.command, config.args ?? [], {
      ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
      env:
        config.env === undefined
          ? process.env
          : { ...process.env, ...config.env },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        child.removeListener("error", onError);
        resolve();
      };
      const onError = (error: Error): void => {
        child.removeListener("spawn", onSpawn);
        reject(new McpTransportError(error.message));
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
    return new NodeStdioMcpConnection(child);
  }

  public async request(
    method: string,
    params?: JsonValue,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    if (this.closed) throw this.closedError();
    const id = `mcp-${this.nextId++}`;
    return await new Promise<JsonValue>((resolve, reject) => {
      const abort = (): void => {
        this.pending.delete(id);
        reject(
          new McpTransportError(`MCP request ${method} was aborted.`, false),
        );
        void this.notify("$/cancelRequest", { id });
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        reject,
        resolve,
        removeAbortListener: () => signal?.removeEventListener("abort", abort),
      });
      void this.send({
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      }).catch((error: unknown) => {
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        this.pending.delete(id);
        pending.removeAbortListener();
        pending.reject(error);
      });
    });
  }

  public async notify(method: string, params?: JsonValue): Promise<void> {
    if (this.closed) throw this.closedError();
    await this.send({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.child.kill("SIGTERM");
    this.finish(undefined);
  }

  public onNotification(
    listener: (notification: JsonRpcNotification) => void,
  ): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  public onClose(listener: (reason?: Error) => void): () => void {
    this.closeListeners.add(listener);
    if (this.closed) queueMicrotask(() => listener(this.closeReason));
    return () => this.closeListeners.delete(listener);
  }

  private async send(message: JsonRpcMessage): Promise<void> {
    const stdin = this.child.stdin;
    if (stdin === null || stdin.destroyed)
      throw new McpTransportError("MCP stdio input is unavailable.");
    const line = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      stdin.write(line, (error: Error | null | undefined) =>
        error === undefined || error === null ? resolve() : reject(error),
      );
    });
  }

  private consume(chunk: Buffer): void {
    this.buffered += this.decoder.write(chunk);
    while (true) {
      const newline = this.buffered.indexOf("\n");
      if (newline === -1) return;
      const line = this.buffered.slice(0, newline).trim();
      this.buffered = this.buffered.slice(newline + 1);
      if (line.length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        this.handleMessage(parseJsonRpcMessage(parsed));
      } catch (error: unknown) {
        this.finish(
          error instanceof Error
            ? error
            : new McpProtocolError("MCP stdio sent invalid JSON."),
        );
        return;
      }
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if ("method" in message) {
      if (!("id" in message)) {
        for (const listener of this.notificationListeners) listener(message);
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    this.pending.delete(message.id);
    pending.removeAbortListener();
    if ("error" in message) {
      pending.reject(
        new McpRpcError(
          message.error.code,
          message.error.message,
          message.error.data,
        ),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  private finish(reason: Error | undefined): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.removeAbortListener();
      pending.reject(
        reason ?? new McpTransportError("MCP connection closed.", false),
      );
    }
    for (const listener of this.closeListeners) listener(reason);
  }

  private closedError(): Error {
    return (
      this.closeReason ??
      new McpTransportError("MCP connection is closed.", false)
    );
  }
}

export interface McpHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type McpFetch = (
  url: string,
  init: RequestInit,
) => Promise<McpHttpResponse>;

/** Streamable HTTP connection with JSON and SSE response handling. */
export class StreamableHttpMcpConnection implements McpConnection {
  private readonly closeListeners = new Set<(reason?: Error) => void>();
  private readonly notificationListeners = new Set<
    (notification: JsonRpcNotification) => void
  >();
  private nextId = 1;
  private closed = false;

  public constructor(
    private readonly config: McpStreamableHttpTransportConfig,
    private readonly fetchImpl: McpFetch = fetch,
  ) {}

  public async request(
    method: string,
    params?: JsonValue,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    if (this.closed)
      throw new McpTransportError("MCP HTTP connection is closed.", false);
    const id = `mcp-http-${this.nextId++}`;
    const response = await this.post(
      {
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      },
      signal,
    );
    const messages = await parseMcpHttpMessages(response);
    const message = messages.find(
      (candidate): candidate is JsonRpcErrorResponse | JsonRpcSuccessResponse =>
        !("method" in candidate) && candidate.id === id,
    );
    if (message === undefined)
      throw new McpProtocolError(
        "MCP HTTP response did not include the request result.",
      );
    if ("error" in message)
      throw new McpRpcError(
        message.error.code,
        message.error.message,
        message.error.data,
      );
    return message.result;
  }

  public async notify(method: string, params?: JsonValue): Promise<void> {
    if (this.closed)
      throw new McpTransportError("MCP HTTP connection is closed.", false);
    await this.post({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  public async close(): Promise<void> {
    if (this.closed) return;
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
    if (this.closed) queueMicrotask(() => listener(undefined));
    return () => this.closeListeners.delete(listener);
  }

  private async post(
    message: JsonRpcMessage,
    signal?: AbortSignal,
  ): Promise<McpHttpResponse> {
    let response: McpHttpResponse;
    try {
      response = await this.fetchImpl(this.config.url, {
        body: JSON.stringify(message),
        headers: {
          ...(this.config.headers ?? {}),
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        method: "POST",
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error: unknown) {
      const detail =
        error instanceof Error ? error.message : "network request failed";
      throw new McpTransportError(`MCP HTTP request failed: ${detail}`);
    }
    if (!response.ok) {
      throw new McpTransportError(
        `MCP HTTP server returned ${response.status}.`,
        response.status >= 500 || response.status === 429,
      );
    }
    return response;
  }
}

async function parseMcpHttpMessages(
  response: McpHttpResponse,
): Promise<readonly JsonRpcMessage[]> {
  const text = await response.text();
  if (text.trim().length === 0)
    throw new McpProtocolError("MCP HTTP server returned an empty response.");
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/event-stream")) {
    return parseSseJsonRpcMessages(text);
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed)
      ? parsed.map(parseJsonRpcMessage)
      : [parseJsonRpcMessage(parsed)];
  } catch (error: unknown) {
    if (error instanceof McpIntegrationError) throw error;
    throw new McpProtocolError("MCP HTTP server returned invalid JSON.");
  }
}

function parseSseJsonRpcMessages(text: string): readonly JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = [];
  for (const event of text.replace(/\r\n/g, "\n").split("\n\n")) {
    const data = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");
    if (data.length === 0 || data === "[DONE]") continue;
    try {
      const parsed: unknown = JSON.parse(data);
      messages.push(parseJsonRpcMessage(parsed));
    } catch (error: unknown) {
      if (error instanceof McpIntegrationError) throw error;
      throw new McpProtocolError(
        "MCP HTTP server returned invalid JSON in an SSE event.",
      );
    }
  }
  if (messages.length === 0)
    throw new McpProtocolError("MCP HTTP SSE response had no JSON-RPC event.");
  return messages;
}

/** Standard Node factory for static stdio and streamable-HTTP MCP configurations. */
export class NodeMcpTransportFactory implements McpTransportFactory {
  public async connect(config: McpServerConfig): Promise<McpConnection> {
    assertMcpServerConfig(config);
    if (config.transport.kind === "stdio")
      return await NodeStdioMcpConnection.connect(config.transport);
    return new StreamableHttpMcpConnection(config.transport);
  }
}
