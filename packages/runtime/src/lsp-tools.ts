import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isAbsolute, join } from "node:path";

import {
  LspClient,
  LspIntegrationError,
  NodeLspTransportFactory,
  type LspDiagnostic,
  type LspServerConfig,
  type LspSymbol,
  type LspTransportFactory,
} from "@ottili/integrations";

import type { DiagnosticsProvider, WorkspaceDiagnostic } from "./context.js";
import { ToolRegistry, type ToolDefinition, type ToolResult } from "./tools.js";

/** Server declarations without a workspace root; one is filled in per Run. */
export type LspServerTemplate = Omit<
  LspServerConfig,
  "rootUri" | "workspaceFolders"
>;

export interface LspManagerOptions {
  readonly transportFactory?: LspTransportFactory;
  /** How long a tool waits for a server to publish diagnostics after opening a document. */
  readonly diagnosticsTimeoutMs?: number;
}

const SEVERITY_BY_LSP_CODE: Readonly<
  Record<number, WorkspaceDiagnostic["severity"]>
> = { 1: "error", 2: "warning", 3: "information", 4: "hint" };

function requiredInputString(
  input: Record<string, unknown>,
  key: string,
): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return value;
}

function requiredInputInteger(
  input: Record<string, unknown>,
  key: string,
): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer.`);
  }
  return value;
}

/**
 * Owns one `LspClient` per (server template, workspace) pair and exposes both
 * a `DiagnosticsProvider` for the context compiler and a small set of durable
 * tools. One manager instance is shared by every Run the daemon executes, the
 * same way `RunContextCompiler` is; clients are created lazily and kept for
 * the daemon's lifetime rather than per-turn.
 */
export class LspServerManager implements DiagnosticsProvider {
  private readonly transportFactory: LspTransportFactory;
  private readonly diagnosticsTimeoutMs: number;
  private readonly clients = new Map<string, LspClient>();
  private readonly openDocuments = new Set<string>();

  public constructor(
    private readonly templates: readonly LspServerTemplate[],
    options: LspManagerOptions = {},
  ) {
    this.transportFactory =
      options.transportFactory ?? new NodeLspTransportFactory();
    this.diagnosticsTimeoutMs = options.diagnosticsTimeoutMs ?? 2_000;
  }

  public async diagnostics(
    workspacePath: string,
  ): Promise<readonly WorkspaceDiagnostic[]> {
    const results: WorkspaceDiagnostic[] = [];
    for (const template of this.templates) {
      const client = await this.clientFor(template, workspacePath).catch(
        () => undefined,
      );
      if (client === undefined) continue;
      for (const uri of this.openDocuments) {
        if (!uri.startsWith(pathToFileURL(workspacePath).href)) continue;
        for (const diagnostic of client.diagnosticsFor(uri)) {
          results.push(toWorkspaceDiagnostic(workspacePath, uri, diagnostic));
        }
      }
    }
    return results;
  }

  /** Durable tools every configured server contributes for one workspace. */
  public createTools(workspacePath: string): ToolRegistry {
    const registry = new ToolRegistry();
    if (this.templates.length === 0) return registry;
    registry.register(this.diagnosticsTool(workspacePath));
    registry.register(this.documentSymbolsTool(workspacePath));
    registry.register(this.definitionTool(workspacePath));
    return registry;
  }

  public async close(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    this.openDocuments.clear();
    await Promise.all(
      clients.map(async (client) => {
        try {
          await client.shutdown();
        } catch {
          // The client is being discarded regardless of shutdown outcome.
        }
      }),
    );
  }

  private diagnosticsTool(workspacePath: string): ToolDefinition {
    return {
      description:
        "Get language-server diagnostics for a workspace file, opening it in the language server first if needed.",
      idempotency: "safe",
      name: "lsp_diagnostics",
      permissions: { required: ["read"] },
      recovery: "retry",
      resourceScopes: (input) => [`file:${String(input.path ?? "")}`],
      sideEffect: "none",
      supportsBackground: false,
      execute: async (input): Promise<ToolResult> => {
        const path = requiredInputString(input, "path");
        const uri = await this.ensureOpenDocument(workspacePath, path);
        await this.waitForDiagnostics(workspacePath, uri);
        const found = (
          await Promise.all(
            this.templates.map(async (template) => {
              const client = await this.clientFor(template, workspacePath);
              return client.diagnosticsFor(uri);
            }),
          )
        ).flat();
        return {
          output:
            found.length === 0
              ? "No diagnostics reported."
              : JSON.stringify(
                  found.map((diagnostic) =>
                    toWorkspaceDiagnostic(workspacePath, uri, diagnostic),
                  ),
                ),
        };
      },
    };
  }

  private documentSymbolsTool(workspacePath: string): ToolDefinition {
    return {
      description:
        "List the symbols (functions, classes, ...) a language server finds in a workspace file.",
      idempotency: "safe",
      name: "lsp_document_symbols",
      permissions: { required: ["read"] },
      recovery: "retry",
      resourceScopes: (input) => [`file:${String(input.path ?? "")}`],
      sideEffect: "none",
      supportsBackground: false,
      execute: async (input, signal): Promise<ToolResult> => {
        const path = requiredInputString(input, "path");
        const uri = await this.ensureOpenDocument(workspacePath, path);
        const client = await this.firstAvailableClient(workspacePath);
        const symbols = await client.documentSymbols(uri, signal);
        return { output: JSON.stringify(symbols.map(summarizeSymbol)) };
      },
    };
  }

  private definitionTool(workspacePath: string): ToolDefinition {
    return {
      description:
        "Find where a symbol at a given line/character in a workspace file is defined.",
      idempotency: "safe",
      name: "lsp_definition",
      permissions: { required: ["read"] },
      recovery: "retry",
      resourceScopes: (input) => [`file:${String(input.path ?? "")}`],
      sideEffect: "none",
      supportsBackground: false,
      execute: async (input, signal): Promise<ToolResult> => {
        const path = requiredInputString(input, "path");
        const uri = await this.ensureOpenDocument(workspacePath, path);
        const client = await this.firstAvailableClient(workspacePath);
        const locations = await client.definition(
          uri,
          {
            character: requiredInputInteger(input, "character"),
            line: requiredInputInteger(input, "line"),
          },
          signal,
        );
        return {
          output:
            locations.length === 0
              ? "No definition found."
              : JSON.stringify(
                  locations.map((location) => ({
                    range:
                      "range" in location
                        ? location.range
                        : location.targetRange,
                    uri: "uri" in location ? location.uri : location.targetUri,
                  })),
                ),
        };
      },
    };
  }

  private async firstAvailableClient(
    workspacePath: string,
  ): Promise<LspClient> {
    for (const template of this.templates) {
      const client = await this.clientFor(template, workspacePath).catch(
        () => undefined,
      );
      if (client !== undefined) return client;
    }
    throw new Error("No configured language server is available.");
  }

  private async ensureOpenDocument(
    workspacePath: string,
    relativePath: string,
  ): Promise<string> {
    const absolute = isAbsolute(relativePath)
      ? relativePath
      : join(workspacePath, relativePath);
    const uri = pathToFileURL(absolute).href;
    if (this.openDocuments.has(uri)) return uri;
    const content = await readFile(absolute, "utf8");
    await Promise.all(
      this.templates.map(async (template) => {
        const client = await this.clientFor(template, workspacePath).catch(
          () => undefined,
        );
        await client?.openDocument(uri, languageIdFor(absolute), 1, content);
      }),
    );
    this.openDocuments.add(uri);
    return uri;
  }

  /** Bounded wait for at least one publish notification, not a fixed sleep. */
  private async waitForDiagnostics(
    workspacePath: string,
    uri: string,
  ): Promise<void> {
    const clients = await Promise.all(
      this.templates.map((template) =>
        this.clientFor(template, workspacePath).catch(() => undefined),
      ),
    );
    await Promise.race([
      new Promise<void>((resolve) => {
        const unsubscribes = clients
          .filter((client): client is LspClient => client !== undefined)
          .map((client) =>
            client.onDiagnostics((published) => {
              if (published.uri === uri) resolve();
            }),
          );
        // If nothing arrives, the timeout below still resolves the race;
        // listeners are torn down by garbage collection with the closure.
        void unsubscribes;
      }),
      new Promise<void>((resolve) =>
        setTimeout(resolve, this.diagnosticsTimeoutMs),
      ),
    ]);
  }

  private async clientFor(
    template: LspServerTemplate,
    workspacePath: string,
  ): Promise<LspClient> {
    const key = `${template.id}:${workspacePath}`;
    const existing = this.clients.get(key);
    if (existing !== undefined) return existing;
    const rootUri = pathToFileURL(workspacePath).href;
    const client = new LspClient(
      { ...template, rootUri },
      this.transportFactory,
    );
    try {
      await client.initialize();
    } catch (error: unknown) {
      throw error instanceof LspIntegrationError
        ? error
        : new LspIntegrationError(
            error instanceof Error ? error.message : "LSP initialize failed.",
            "LSP_INIT_FAILED",
            true,
          );
    }
    this.clients.set(key, client);
    return client;
  }
}

function toWorkspaceDiagnostic(
  workspacePath: string,
  uri: string,
  diagnostic: LspDiagnostic,
): WorkspaceDiagnostic {
  return {
    line: diagnostic.range.start.line,
    message: diagnostic.message,
    path: relativeFromUri(workspacePath, uri),
    severity: SEVERITY_BY_LSP_CODE[diagnostic.severity ?? 1] ?? "error",
  };
}

function relativeFromUri(workspacePath: string, uri: string): string {
  try {
    const absolute = fileURLToPath(uri);
    return absolute.startsWith(workspacePath)
      ? absolute.slice(workspacePath.length).replace(/^[/\\]/u, "")
      : absolute;
  } catch {
    return uri;
  }
}

function languageIdFor(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const known: Readonly<Record<string, string>> = {
    js: "javascript",
    jsx: "javascriptreact",
    mjs: "javascript",
    py: "python",
    rs: "rust",
    ts: "typescript",
    tsx: "typescriptreact",
  };
  return known[extension] ?? "plaintext";
}

function summarizeSymbol(symbol: LspSymbol): {
  readonly name: string;
  readonly kind: number;
  readonly containerName?: string;
} {
  return "containerName" in symbol
    ? {
        containerName: symbol.containerName,
        kind: symbol.kind,
        name: symbol.name,
      }
    : { kind: symbol.kind, name: symbol.name };
}
