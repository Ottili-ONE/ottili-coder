import { spawn } from "node:child_process";

import type { JsonObject, JsonValue } from "@ottili/protocol";

import {
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  parseJsonRpcMessage,
} from "./mcp.js";

export type LspClientState =
  | "new"
  | "initializing"
  | "initialized"
  | "shutting_down"
  | "stopped"
  | "failed";

export interface LspWorkspaceFolder {
  readonly uri: string;
  readonly name: string;
}

/** A declarative stdio LSP configuration. Dynamic plug-in/module loading is intentionally absent. */
export interface LspServerConfig {
  readonly id: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly rootUri?: string;
  readonly workspaceFolders?: readonly LspWorkspaceFolder[];
  readonly initializationOptions?: JsonValue;
  readonly clientCapabilities?: JsonObject;
}

export interface LspPosition {
  readonly line: number;
  readonly character: number;
}

export interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}

export interface LspDiagnostic {
  readonly range: LspRange;
  readonly message: string;
  readonly severity?: 1 | 2 | 3 | 4;
  readonly code?: number | string;
  readonly source?: string;
  readonly data?: JsonValue;
}

export interface LspPublishDiagnostics {
  readonly uri: string;
  readonly version?: number;
  readonly diagnostics: readonly LspDiagnostic[];
}

export interface LspLocation {
  readonly uri: string;
  readonly range: LspRange;
}

export interface LspLocationLink {
  readonly targetUri: string;
  readonly targetRange: LspRange;
  readonly targetSelectionRange: LspRange;
  readonly originSelectionRange?: LspRange;
}

export interface LspHover {
  readonly contents: JsonValue;
  readonly range?: LspRange;
}

export interface LspDocumentSymbol {
  readonly name: string;
  readonly kind: number;
  readonly range: LspRange;
  readonly selectionRange: LspRange;
  readonly detail?: string;
  readonly children?: readonly LspDocumentSymbol[];
}

export interface LspSymbolInformation {
  readonly name: string;
  readonly kind: number;
  readonly location: LspLocation;
  readonly containerName?: string;
}

export type LspSymbol = LspDocumentSymbol | LspSymbolInformation;

export interface LspInitializeResult {
  readonly capabilities: JsonObject;
  readonly serverInfo?: {
    readonly name: string;
    readonly version?: string;
  };
}

export interface LspClientOptions {
  readonly processId?: number | null;
  readonly trace?: "off" | "messages" | "verbose";
}

export interface LspConnection {
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

export interface LspTransportFactory {
  connect(config: LspServerConfig): Promise<LspConnection>;
}

export class LspIntegrationError extends Error {
  public constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "LspIntegrationError";
  }
}

export class LspConfigurationError extends LspIntegrationError {
  public constructor(message: string) {
    super(message, "LSP_CONFIGURATION", false);
    this.name = "LspConfigurationError";
  }
}

export class LspProtocolError extends LspIntegrationError {
  public constructor(message: string) {
    super(message, "LSP_PROTOCOL", false);
    this.name = "LspProtocolError";
  }
}

export class LspTransportError extends LspIntegrationError {
  public constructor(message: string, retryable = true) {
    super(message, "LSP_TRANSPORT", retryable);
    this.name = "LspTransportError";
  }
}

export class LspRpcError extends LspIntegrationError {
  public constructor(
    readonly rpcCode: number,
    message: string,
    readonly data?: JsonValue,
  ) {
    super(message, "LSP_RPC", rpcCode === -32_000 || rpcCode === -32_001);
    this.name = "LspRpcError";
  }
}

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
    throw new LspConfigurationError(`${label} must be a JSON object.`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new LspConfigurationError(`${label} must be a non-empty string.`);
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
      throw new LspConfigurationError(
        `${label}.${key} is not supported; LSP plug-in/module loading is disabled.`,
      );
    }
    if (!allowed.has(key))
      throw new LspConfigurationError(
        `${label}.${key} is not a supported declarative setting.`,
      );
  }
}

function parseStringArray(value: unknown, label: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new LspConfigurationError(`${label} must be an array of strings.`);
  }
  return value;
}

function parseStringRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, string>> {
  const record = requireRecord(value, label);
  const parsed: Record<string, string> = {};
  for (const [key, candidate] of Object.entries(record)) {
    if (typeof candidate !== "string")
      throw new LspConfigurationError(`${label}.${key} must be a string.`);
    parsed[key] = candidate;
  }
  return parsed;
}

/**
 * A bare Windows drive-letter path (`C:\...`) is not a URI, but `new URL()`
 * disagrees: a single letter followed by `:` is syntactically a valid URL
 * scheme, so `new URL("C:\\project").protocol` is `"c:"` — non-empty, and
 * would otherwise pass this check. The LSP spec requires a genuine
 * `DocumentUri` (`file://...`) here; silently accepting a native path would
 * send the language server something it cannot resolve.
 */
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/u;

function assertAbsoluteUri(value: string, label: string): void {
  if (WINDOWS_DRIVE_PATH.test(value)) {
    throw new LspConfigurationError(
      `${label} must be a URI (e.g. file:///C:/...), not a bare path.`,
    );
  }
  try {
    const uri = new URL(value);
    if (uri.protocol.length === 0) throw new Error("missing protocol");
  } catch {
    throw new LspConfigurationError(`${label} must be an absolute URI.`);
  }
}

function parseWorkspaceFolders(value: unknown): readonly LspWorkspaceFolder[] {
  if (!Array.isArray(value))
    throw new LspConfigurationError("LSP workspaceFolders must be an array.");
  return value.map((folder, index) => {
    const record = requireRecord(folder, `LSP workspaceFolders[${index}]`);
    assertKnownKeys(record, ["uri", "name"], `LSP workspaceFolders[${index}]`);
    const uri = requireString(record.uri, `LSP workspaceFolders[${index}].uri`);
    assertAbsoluteUri(uri, `LSP workspaceFolders[${index}].uri`);
    return {
      name: requireString(record.name, `LSP workspaceFolders[${index}].name`),
      uri,
    };
  });
}

/** Parses untrusted LSP configuration and rejects arbitrary module/plugin loaders. */
export function parseLspServerConfig(value: unknown): LspServerConfig {
  const record = requireRecord(value, "LSP server");
  assertKnownKeys(
    record,
    [
      "id",
      "command",
      "args",
      "cwd",
      "env",
      "rootUri",
      "workspaceFolders",
      "initializationOptions",
      "clientCapabilities",
    ],
    "LSP server",
  );
  const id = requireString(record.id, "LSP server id");
  if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(id)) {
    throw new LspConfigurationError(
      "LSP server id must use letters, numbers, underscores, or dashes.",
    );
  }
  const command = requireString(record.command, "LSP command");
  const args =
    record.args === undefined
      ? undefined
      : parseStringArray(record.args, "LSP args");
  const cwd =
    record.cwd === undefined ? undefined : requireString(record.cwd, "LSP cwd");
  const env =
    record.env === undefined
      ? undefined
      : parseStringRecord(record.env, "LSP env");
  const rootUri =
    record.rootUri === undefined
      ? undefined
      : requireString(record.rootUri, "LSP rootUri");
  if (rootUri !== undefined) assertAbsoluteUri(rootUri, "LSP rootUri");
  const workspaceFolders =
    record.workspaceFolders === undefined
      ? undefined
      : parseWorkspaceFolders(record.workspaceFolders);
  if (
    record.initializationOptions !== undefined &&
    !isJsonValue(record.initializationOptions)
  ) {
    throw new LspConfigurationError(
      "LSP initializationOptions must be JSON-serializable.",
    );
  }
  if (
    record.clientCapabilities !== undefined &&
    !isRecord(record.clientCapabilities)
  ) {
    throw new LspConfigurationError(
      "LSP clientCapabilities must be an object.",
    );
  }
  const initializationOptions = record.initializationOptions as
    JsonValue | undefined;
  const clientCapabilities = record.clientCapabilities as
    JsonObject | undefined;
  return {
    command,
    id,
    ...(args === undefined ? {} : { args }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(env === undefined ? {} : { env }),
    ...(rootUri === undefined ? {} : { rootUri }),
    ...(workspaceFolders === undefined ? {} : { workspaceFolders }),
    ...(initializationOptions === undefined ? {} : { initializationOptions }),
    ...(clientCapabilities === undefined ? {} : { clientCapabilities }),
  };
}

export function assertLspServerConfig(config: LspServerConfig): void {
  parseLspServerConfig(config);
}

/** Incremental Content-Length JSON-RPC parser used by LSP stdio streams. */
export class LspMessageParser {
  private buffer = Buffer.alloc(0);

  public constructor(private readonly maxContentLength = 16 * 1024 * 1024) {
    if (!Number.isInteger(maxContentLength) || maxContentLength <= 0) {
      throw new LspConfigurationError(
        "LSP maxContentLength must be a positive integer.",
      );
    }
  }

  public push(chunk: Buffer | Uint8Array | string): readonly JsonRpcMessage[] {
    const incoming =
      typeof chunk === "string"
        ? Buffer.from(chunk, "utf8")
        : Buffer.from(chunk);
    this.buffer =
      this.buffer.length === 0
        ? incoming
        : Buffer.concat([this.buffer, incoming]);
    const messages: JsonRpcMessage[] = [];
    while (true) {
      const header = this.readHeader();
      if (header === undefined) break;
      if (header.contentLength > this.maxContentLength) {
        this.buffer = Buffer.alloc(0);
        throw new LspProtocolError(
          `LSP message exceeds ${this.maxContentLength} bytes.`,
        );
      }
      const bodyStart = header.end;
      const bodyEnd = bodyStart + header.contentLength;
      if (this.buffer.length < bodyEnd) break;
      const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.subarray(bodyEnd);
      try {
        const value: unknown = JSON.parse(body);
        messages.push(parseJsonRpcMessage(value));
      } catch (error: unknown) {
        if (error instanceof LspIntegrationError) throw error;
        const message = error instanceof Error ? error.message : "invalid JSON";
        throw new LspProtocolError(`LSP message body is invalid: ${message}`);
      }
    }
    return messages;
  }

  public bufferedBytes(): number {
    return this.buffer.length;
  }

  private readHeader():
    { readonly contentLength: number; readonly end: number } | undefined {
    const crlf = this.buffer.indexOf("\r\n\r\n");
    const lf = this.buffer.indexOf("\n\n");
    if (crlf === -1 && lf === -1) {
      if (this.buffer.length > 16 * 1024) {
        this.buffer = Buffer.alloc(0);
        throw new LspProtocolError(
          "LSP header exceeds 16 KiB or is missing Content-Length.",
        );
      }
      return undefined;
    }
    const useCrlf = crlf !== -1 && (lf === -1 || crlf <= lf);
    const end = (useCrlf ? crlf : lf) + (useCrlf ? 4 : 2);
    const raw = this.buffer
      .subarray(0, end - (useCrlf ? 4 : 2))
      .toString("ascii");
    const values = new Map<string, string>();
    for (const line of raw.split(useCrlf ? "\r\n" : "\n")) {
      const separator = line.indexOf(":");
      if (separator <= 0)
        throw new LspProtocolError("LSP header line is malformed.");
      const key = line.slice(0, separator).trim().toLowerCase();
      const value = line.slice(separator + 1).trim();
      if (values.has(key))
        throw new LspProtocolError(`LSP header ${key} is duplicated.`);
      values.set(key, value);
    }
    const contentLength = values.get("content-length");
    if (contentLength === undefined || !/^\d+$/.test(contentLength)) {
      throw new LspProtocolError(
        "LSP message is missing a valid Content-Length header.",
      );
    }
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength))
      throw new LspProtocolError("LSP Content-Length is too large.");
    return { contentLength: parsedLength, end };
  }
}

export function serializeLspMessage(message: JsonRpcMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
    body,
  ]);
}

interface PendingLspRequest {
  readonly resolve: (value: JsonValue) => void;
  readonly reject: (reason?: unknown) => void;
  readonly removeAbortListener: () => void;
}

/** Node-native, shell-free stdio LSP connection. */
export class NodeLspConnection implements LspConnection {
  private readonly closeListeners = new Set<(reason?: Error) => void>();
  private readonly notificationListeners = new Set<
    (notification: JsonRpcNotification) => void
  >();
  private readonly parser = new LspMessageParser();
  private readonly pending = new Map<JsonRpcId, PendingLspRequest>();
  private nextId = 1;
  private closed = false;
  private closeReason: Error | undefined;

  private constructor(private readonly child: ReturnType<typeof spawn>) {
    this.child.stdout?.on("data", (chunk: Buffer) => this.consume(chunk));
    this.child.stderr?.on("data", () => {
      // Diagnostics use protocol notifications; stderr must never be treated as one.
    });
    this.child.once("error", (error: Error) =>
      this.finish(new LspTransportError(error.message)),
    );
    this.child.once("close", (code: number | null) => {
      this.finish(
        new LspTransportError(
          `LSP process exited with code ${code ?? "unknown"}.`,
        ),
      );
    });
  }

  public static async connect(
    config: LspServerConfig,
  ): Promise<NodeLspConnection> {
    assertLspServerConfig(config);
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
        reject(new LspTransportError(error.message));
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
    return new NodeLspConnection(child);
  }

  public async request(
    method: string,
    params?: JsonValue,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    if (this.closed) throw this.closedError();
    const id = this.nextId++;
    return await new Promise<JsonValue>((resolve, reject) => {
      const abort = (): void => {
        this.pending.delete(id);
        reject(
          new LspTransportError(`LSP request ${method} was aborted.`, false),
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
      throw new LspTransportError("LSP stdio input is unavailable.");
    await new Promise<void>((resolve, reject) => {
      stdin.write(
        serializeLspMessage(message),
        (error: Error | null | undefined) =>
          error === undefined || error === null ? resolve() : reject(error),
      );
    });
  }

  private consume(chunk: Buffer): void {
    try {
      for (const message of this.parser.push(chunk))
        this.handleMessage(message);
    } catch (error: unknown) {
      this.finish(
        error instanceof LspIntegrationError
          ? error
          : new LspProtocolError("LSP stream could not be parsed."),
      );
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if ("method" in message) {
      if ("id" in message) {
        void this.send({
          error: {
            code: -32_601,
            message: "Ottili LSP client does not handle server requests.",
          },
          id: message.id,
          jsonrpc: "2.0",
        });
        return;
      }
      for (const listener of this.notificationListeners) listener(message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    this.pending.delete(message.id);
    pending.removeAbortListener();
    if ("error" in message) {
      pending.reject(
        new LspRpcError(
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
        reason ?? new LspTransportError("LSP connection closed.", false),
      );
    }
    for (const listener of this.closeListeners) listener(reason);
  }

  private closedError(): Error {
    return (
      this.closeReason ??
      new LspTransportError("LSP connection is closed.", false)
    );
  }
}

export class NodeLspTransportFactory implements LspTransportFactory {
  public async connect(config: LspServerConfig): Promise<LspConnection> {
    return await NodeLspConnection.connect(config);
  }
}

function asJsonObject(value: JsonValue, message: string): JsonObject {
  if (!isRecord(value)) throw new LspProtocolError(message);
  return value;
}

function parsePosition(value: unknown, label: string): LspPosition {
  if (!isRecord(value)) {
    throw new LspProtocolError(
      `${label} must contain non-negative integer line and character values.`,
    );
  }
  const line = value.line;
  const character = value.character;
  if (
    typeof line !== "number" ||
    !Number.isInteger(line) ||
    line < 0 ||
    typeof character !== "number" ||
    !Number.isInteger(character) ||
    character < 0
  ) {
    throw new LspProtocolError(
      `${label} must contain non-negative integer line and character values.`,
    );
  }
  return { character, line };
}

function parseRange(value: unknown, label: string): LspRange {
  if (!isRecord(value))
    throw new LspProtocolError(`${label} must be an object.`);
  return {
    end: parsePosition(value.end, `${label}.end`),
    start: parsePosition(value.start, `${label}.start`),
  };
}

function parseDiagnostic(value: unknown): LspDiagnostic {
  if (!isRecord(value) || typeof value.message !== "string")
    throw new LspProtocolError("LSP diagnostic is malformed.");
  const severity = value.severity;
  if (
    severity !== undefined &&
    severity !== 1 &&
    severity !== 2 &&
    severity !== 3 &&
    severity !== 4
  ) {
    throw new LspProtocolError(
      "LSP diagnostic severity must be between 1 and 4.",
    );
  }
  if (
    value.code !== undefined &&
    typeof value.code !== "string" &&
    typeof value.code !== "number"
  ) {
    throw new LspProtocolError(
      "LSP diagnostic code must be a string or number.",
    );
  }
  if (value.source !== undefined && typeof value.source !== "string") {
    throw new LspProtocolError("LSP diagnostic source must be a string.");
  }
  if (value.data !== undefined && !isJsonValue(value.data))
    throw new LspProtocolError("LSP diagnostic data must be JSON.");
  return {
    message: value.message,
    range: parseRange(value.range, "LSP diagnostic range"),
    ...(severity === undefined ? {} : { severity }),
    ...(value.code === undefined ? {} : { code: value.code }),
    ...(value.source === undefined ? {} : { source: value.source }),
    ...(value.data === undefined ? {} : { data: value.data }),
  };
}

export function parseLspPublishDiagnostics(
  value: unknown,
): LspPublishDiagnostics {
  if (
    !isRecord(value) ||
    typeof value.uri !== "string" ||
    !Array.isArray(value.diagnostics)
  ) {
    throw new LspProtocolError(
      "textDocument/publishDiagnostics notification is malformed.",
    );
  }
  const version = value.version;
  if (
    version !== undefined &&
    (typeof version !== "number" || !Number.isInteger(version))
  ) {
    throw new LspProtocolError("LSP diagnostic version must be an integer.");
  }
  return {
    diagnostics: value.diagnostics.map(parseDiagnostic),
    uri: value.uri,
    ...(version === undefined ? {} : { version }),
  };
}

function parseLocation(value: unknown, label: string): LspLocation {
  if (!isRecord(value) || typeof value.uri !== "string")
    throw new LspProtocolError(`${label} must contain a URI.`);
  return { range: parseRange(value.range, `${label}.range`), uri: value.uri };
}

function parseLocationLink(value: unknown): LspLocationLink {
  if (!isRecord(value) || typeof value.targetUri !== "string")
    throw new LspProtocolError("LSP location link is malformed.");
  return {
    targetRange: parseRange(value.targetRange, "LSP location link targetRange"),
    targetSelectionRange: parseRange(
      value.targetSelectionRange,
      "LSP location link targetSelectionRange",
    ),
    targetUri: value.targetUri,
    ...(value.originSelectionRange === undefined
      ? {}
      : {
          originSelectionRange: parseRange(
            value.originSelectionRange,
            "LSP location link originSelectionRange",
          ),
        }),
  };
}

export function parseLspLocations(
  value: JsonValue,
): readonly (LspLocation | LspLocationLink)[] {
  if (value === null) return [];
  const candidates = Array.isArray(value) ? value : [value];
  return candidates.map((candidate) =>
    isRecord(candidate) && typeof candidate.targetUri === "string"
      ? parseLocationLink(candidate)
      : parseLocation(candidate, "LSP location"),
  );
}

function parseHover(value: JsonValue): LspHover | null {
  if (value === null) return null;
  const record = asJsonObject(
    value,
    "LSP hover result must be an object or null.",
  );
  if (record.contents === undefined || !isJsonValue(record.contents))
    throw new LspProtocolError("LSP hover result is missing contents.");
  return {
    contents: record.contents,
    ...(record.range === undefined
      ? {}
      : { range: parseRange(record.range, "LSP hover range") }),
  };
}

function parseDocumentSymbol(value: unknown): LspDocumentSymbol {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.kind !== "number" ||
    !Number.isInteger(value.kind)
  ) {
    throw new LspProtocolError("LSP document symbol is malformed.");
  }
  if (value.detail !== undefined && typeof value.detail !== "string")
    throw new LspProtocolError("LSP symbol detail must be a string.");
  if (value.children !== undefined && !Array.isArray(value.children))
    throw new LspProtocolError("LSP symbol children must be an array.");
  return {
    kind: value.kind,
    name: value.name,
    range: parseRange(value.range, "LSP document symbol range"),
    selectionRange: parseRange(
      value.selectionRange,
      "LSP document symbol selectionRange",
    ),
    ...(value.detail === undefined ? {} : { detail: value.detail }),
    ...(value.children === undefined
      ? {}
      : { children: value.children.map(parseDocumentSymbol) }),
  };
}

function parseSymbolInformation(value: unknown): LspSymbolInformation {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.kind !== "number" ||
    !Number.isInteger(value.kind)
  ) {
    throw new LspProtocolError("LSP symbol information is malformed.");
  }
  if (
    value.containerName !== undefined &&
    typeof value.containerName !== "string"
  ) {
    throw new LspProtocolError(
      "LSP symbol information containerName must be a string.",
    );
  }
  return {
    kind: value.kind,
    location: parseLocation(value.location, "LSP symbol information location"),
    name: value.name,
    ...(value.containerName === undefined
      ? {}
      : { containerName: value.containerName }),
  };
}

function parseSymbols(value: JsonValue): readonly LspSymbol[] {
  if (!Array.isArray(value))
    throw new LspProtocolError("LSP documentSymbol result must be an array.");
  return value.map((symbol) =>
    isRecord(symbol) && Object.hasOwn(symbol, "range")
      ? parseDocumentSymbol(symbol)
      : parseSymbolInformation(symbol),
  );
}

function failure(error: unknown): LspIntegrationError {
  if (error instanceof LspIntegrationError) return error;
  if (error instanceof Error) return new LspTransportError(error.message);
  return new LspTransportError("Unknown LSP connection failure.");
}

/**
 * Lifecycle-aware LSP client. It retains diagnostics as live repository
 * evidence and exposes only common read-only intelligence operations.
 */
export class LspClient {
  private readonly diagnostics = new Map<string, readonly LspDiagnostic[]>();
  private readonly diagnosticListeners = new Set<
    (diagnostics: LspPublishDiagnostics) => void
  >();
  private connection: LspConnection | undefined;
  private unsubscribeClose: (() => void) | undefined;
  private unsubscribeNotification: (() => void) | undefined;
  private initialization: LspInitializeResult | undefined;
  private stateValue: LspClientState = "new";
  private lastFailure: LspIntegrationError | undefined;

  public constructor(
    public readonly config: LspServerConfig,
    private readonly transportFactory: LspTransportFactory,
    private readonly options: LspClientOptions = {},
  ) {
    assertLspServerConfig(config);
  }

  public get state(): LspClientState {
    return this.stateValue;
  }

  public get failure(): LspIntegrationError | undefined {
    return this.lastFailure;
  }

  public async initialize(signal?: AbortSignal): Promise<LspInitializeResult> {
    if (this.stateValue === "initialized" && this.initialization !== undefined)
      return this.initialization;
    if (this.stateValue !== "new")
      throw new LspProtocolError(
        `LSP client cannot initialize from ${this.stateValue}.`,
      );
    this.stateValue = "initializing";
    try {
      const connection = await this.transportFactory.connect(this.config);
      this.connection = connection;
      this.unsubscribeNotification = connection.onNotification((notification) =>
        this.handleNotification(notification),
      );
      this.unsubscribeClose = connection.onClose((reason) => {
        if (
          this.stateValue === "shutting_down" ||
          this.stateValue === "stopped"
        )
          return;
        this.stateValue = "failed";
        this.lastFailure = failure(reason);
      });
      const params: JsonObject = {
        capabilities: this.config.clientCapabilities ?? {},
        processId:
          this.options.processId === undefined
            ? process.pid
            : this.options.processId,
        rootUri: this.config.rootUri ?? null,
        workspaceFolders:
          this.config.workspaceFolders?.map((folder) => ({
            name: folder.name,
            uri: folder.uri,
          })) ?? null,
        ...(this.config.initializationOptions === undefined
          ? {}
          : { initializationOptions: this.config.initializationOptions }),
        ...(this.options.trace === undefined
          ? {}
          : { trace: this.options.trace }),
      };
      const result = asJsonObject(
        await connection.request("initialize", params, signal),
        "LSP initialize returned a non-object result.",
      );
      if (!isRecord(result.capabilities))
        throw new LspProtocolError(
          "LSP initialize result must include capabilities.",
        );
      if (
        result.serverInfo !== undefined &&
        (!isRecord(result.serverInfo) ||
          typeof result.serverInfo.name !== "string")
      ) {
        throw new LspProtocolError("LSP serverInfo must contain a name.");
      }
      const serverInfo = isRecord(result.serverInfo)
        ? {
            name: result.serverInfo.name as string,
            ...(typeof result.serverInfo.version === "string"
              ? { version: result.serverInfo.version }
              : {}),
          }
        : undefined;
      const initialization: LspInitializeResult = {
        capabilities: result.capabilities as JsonObject,
        ...(serverInfo === undefined ? {} : { serverInfo }),
      };
      await connection.notify("initialized", {});
      this.initialization = initialization;
      this.lastFailure = undefined;
      this.stateValue = "initialized";
      return initialization;
    } catch (error: unknown) {
      this.stateValue = "failed";
      this.lastFailure = failure(error);
      await this.disposeConnection();
      throw error;
    }
  }

  public async shutdown(): Promise<void> {
    if (this.stateValue === "stopped") return;
    const connection = this.connection;
    this.stateValue = "shutting_down";
    try {
      if (connection !== undefined && this.initialization !== undefined) {
        await connection.request("shutdown", {});
        await connection.notify("exit", {});
      }
    } finally {
      await this.disposeConnection();
      this.stateValue = "stopped";
    }
  }

  public onDiagnostics(
    listener: (diagnostics: LspPublishDiagnostics) => void,
  ): () => void {
    this.diagnosticListeners.add(listener);
    return () => this.diagnosticListeners.delete(listener);
  }

  public diagnosticsFor(uri: string): readonly LspDiagnostic[] {
    return this.diagnostics.get(uri) ?? [];
  }

  public async definition(
    uri: string,
    position: LspPosition,
    signal?: AbortSignal,
  ): Promise<readonly (LspLocation | LspLocationLink)[]> {
    return parseLspLocations(
      await this.request(
        "textDocument/definition",
        documentPositionParams(uri, position),
        signal,
      ),
    );
  }

  public async references(
    uri: string,
    position: LspPosition,
    includeDeclaration = true,
    signal?: AbortSignal,
  ): Promise<readonly LspLocation[]> {
    const result = await this.request(
      "textDocument/references",
      {
        context: { includeDeclaration },
        ...documentPositionParams(uri, position),
      },
      signal,
    );
    return parseLspLocations(result).map((location) =>
      "targetUri" in location
        ? { range: location.targetSelectionRange, uri: location.targetUri }
        : location,
    );
  }

  public async hover(
    uri: string,
    position: LspPosition,
    signal?: AbortSignal,
  ): Promise<LspHover | null> {
    return parseHover(
      await this.request(
        "textDocument/hover",
        documentPositionParams(uri, position),
        signal,
      ),
    );
  }

  public async documentSymbols(
    uri: string,
    signal?: AbortSignal,
  ): Promise<readonly LspSymbol[]> {
    return parseSymbols(
      await this.request(
        "textDocument/documentSymbol",
        { textDocument: { uri } },
        signal,
      ),
    );
  }

  public async openDocument(
    uri: string,
    languageId: string,
    version: number,
    text: string,
  ): Promise<void> {
    this.assertInitialized();
    if (!Number.isInteger(version))
      throw new LspProtocolError("LSP document version must be an integer.");
    await this.requireConnection().notify("textDocument/didOpen", {
      textDocument: { languageId, text, uri, version },
    });
  }

  public async changeDocument(
    uri: string,
    version: number,
    text: string,
  ): Promise<void> {
    this.assertInitialized();
    if (!Number.isInteger(version))
      throw new LspProtocolError("LSP document version must be an integer.");
    await this.requireConnection().notify("textDocument/didChange", {
      contentChanges: [{ text }],
      textDocument: { uri, version },
    });
  }

  public async closeDocument(uri: string): Promise<void> {
    this.assertInitialized();
    await this.requireConnection().notify("textDocument/didClose", {
      textDocument: { uri },
    });
    this.diagnostics.delete(uri);
  }

  private async request(
    method: string,
    params: JsonObject,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    this.assertInitialized();
    return await this.requireConnection().request(method, params, signal);
  }

  private assertInitialized(): void {
    if (this.stateValue !== "initialized")
      throw new LspProtocolError(
        `LSP client is not initialized (state: ${this.stateValue}).`,
      );
  }

  private requireConnection(): LspConnection {
    if (this.connection === undefined)
      throw new LspTransportError("LSP connection is unavailable.", false);
    return this.connection;
  }

  private handleNotification(notification: JsonRpcNotification): void {
    if (notification.method !== "textDocument/publishDiagnostics") return;
    try {
      const published = parseLspPublishDiagnostics(notification.params);
      this.diagnostics.set(published.uri, published.diagnostics);
      for (const listener of this.diagnosticListeners) listener(published);
    } catch (error: unknown) {
      this.lastFailure = failure(error);
    }
  }

  private async disposeConnection(): Promise<void> {
    const unsubscribeNotification = this.unsubscribeNotification;
    const unsubscribeClose = this.unsubscribeClose;
    this.unsubscribeNotification = undefined;
    this.unsubscribeClose = undefined;
    unsubscribeNotification?.();
    unsubscribeClose?.();
    const connection = this.connection;
    this.connection = undefined;
    if (connection !== undefined) await connection.close();
  }
}

function documentPositionParams(
  uri: string,
  position: LspPosition,
): JsonObject {
  if (
    !Number.isInteger(position.line) ||
    position.line < 0 ||
    !Number.isInteger(position.character) ||
    position.character < 0
  ) {
    throw new LspProtocolError(
      "LSP position must have non-negative integer line and character values.",
    );
  }
  return {
    position: { character: position.character, line: position.line },
    textDocument: { uri },
  };
}
