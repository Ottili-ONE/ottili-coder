#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  McpServerCatalog,
  McpServerSupervisor,
  NodeMcpTransportFactory,
  parseMcpServerConfig,
  parseLspServerConfig,
  type McpServerConfig,
} from "@ottili/integrations";
import { DurableDaemon } from "@ottili/server";
import {
  GitCheckpointRestorer,
  GitWorktreeProvisioner,
  LspServerManager,
  PROVIDER_KINDS,
  ProviderConfigurationError,
  ProviderFailure,
  RunCoordinator,
  ToolRegistry,
  createMcpTools,
  createProviderRuntime,
  createWorkspaceTools,
  type LspServerTemplate,
  type ProviderConfig,
  type ProviderKind,
  type TurnProvider,
} from "@ottili/runtime";

const defaultDaemonUrl = "http://127.0.0.1:7411";

/**
 * A Run whose provider is not configured must wait for an operator rather than
 * fail: the durable Run outlives the misconfiguration, so an authentication
 * failure parks it in `waiting_external` instead of ending the mission.
 */
class UnconfiguredProvider implements TurnProvider {
  public readonly id = "unconfigured";

  public constructor(private readonly reason: string) {}

  public async complete(): Promise<never> {
    throw new ProviderFailure("authentication", this.reason);
  }
}

function providerKindFromEnvironment(): ProviderKind | undefined {
  const configured = process.env.OTTILI_PROVIDER;
  if (configured === undefined) {
    // A bare endpoint keeps working the way it always has.
    return process.env.OTTILI_PROVIDER_ENDPOINT === undefined
      ? undefined
      : "openai-compatible";
  }
  return PROVIDER_KINDS.find((kind) => kind === configured);
}

function providerConfigFromEnvironment(): ProviderConfig | undefined {
  const kind = providerKindFromEnvironment();
  if (kind === undefined) return undefined;
  return {
    kind,
    ...(process.env.OTTILI_PROVIDER_API_KEY === undefined
      ? {}
      : { apiKey: process.env.OTTILI_PROVIDER_API_KEY }),
    ...(process.env.OTTILI_PROVIDER_ENDPOINT === undefined
      ? {}
      : { endpoint: process.env.OTTILI_PROVIDER_ENDPOINT }),
  };
}

/** Comma-separated fallback kinds, each using its own default credential. */
function fallbackConfigsFromEnvironment(): readonly ProviderConfig[] {
  const configured = process.env.OTTILI_PROVIDER_FALLBACKS;
  if (configured === undefined) return [];
  return configured
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .flatMap((value) => {
      const kind = PROVIDER_KINDS.find((candidate) => candidate === value);
      return kind === undefined ? [] : [{ kind }];
    });
}

/**
 * Supplies the managed Ottili access token from the environment, re-read on
 * every call so a token rotated in the daemon's own process environment takes
 * effect without a restart. Absent when the daemon is a purely local/BYOK
 * installation, which is why this stays optional end to end.
 */
function ottiliAccessTokenSupplier(): (() => Promise<string>) | undefined {
  if (process.env.OTTILI_ACCESS_TOKEN === undefined) return undefined;
  return async () => {
    const token = process.env.OTTILI_ACCESS_TOKEN;
    if (token === undefined || token.length === 0) {
      throw new Error("OTTILI_ACCESS_TOKEN is not set.");
    }
    return token;
  };
}

function resolveProviderRuntime(): {
  readonly model: string;
  readonly provider: TurnProvider;
} {
  const model = process.env.OTTILI_MODEL ?? "default";
  const providerConfig = providerConfigFromEnvironment();
  if (providerConfig === undefined) {
    return {
      model,
      provider: new UnconfiguredProvider(
        "No provider is configured. Set OTTILI_PROVIDER (anthropic, google, openai, openai-compatible, openrouter, ottili) with its credential, then resume the durable Run.",
      ),
    };
  }
  const ottiliAccessToken = ottiliAccessTokenSupplier();
  try {
    return createProviderRuntime(
      {
        fallbacks: fallbackConfigsFromEnvironment(),
        model,
        provider: providerConfig,
      },
      ottiliAccessToken === undefined ? {} : { ottiliAccessToken },
    );
  } catch (error: unknown) {
    if (error instanceof ProviderConfigurationError) {
      return { model, provider: new UnconfiguredProvider(error.message) };
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const url = new URL(process.env.OTTILI_CODER_DAEMON_URL ?? defaultDaemonUrl);
  const configDirectory =
    process.env.OTTILI_CODER_CONFIG_DIR ?? join(homedir(), ".ottili", "coder");
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  const fallbackWorkspace = process.env.OTTILI_CODER_WORKSPACE ?? process.cwd();
  const { model, provider } = resolveProviderRuntime();

  // MCP/LSP are opt-in capability sources composed into every turn's tool
  // registry and (for LSP) the context compiler's diagnostics port, going
  // through the exact same durable policy/approval/resource-lock pipeline as
  // every other tool once RunCoordinator wraps them.
  const mcpServers = mcpServersFromEnvironment();
  const mcpSupervisor =
    mcpServers.length === 0
      ? undefined
      : new McpServerSupervisor(
          new McpServerCatalog(mcpServers),
          new NodeMcpTransportFactory(),
        );
  let mcpReconcileTimer: ReturnType<typeof setInterval> | undefined;
  if (mcpSupervisor !== undefined) {
    await mcpSupervisor.reconcile();
    mcpReconcileTimer = setInterval(() => {
      void mcpSupervisor.reconcile();
    }, 5_000);
    mcpReconcileTimer.unref();
  }
  const lspServers = lspServersFromEnvironment();
  const lspManager =
    lspServers.length === 0 ? undefined : new LspServerManager(lspServers);
  // A delegated Agent gets its own isolated Git worktree so its edits/
  // commands never race the coordinator's own workspace; provisioning is
  // best-effort and falls back to the shared workspace on failure (e.g. the
  // workspace is not a Git repository), so this stays safe to leave enabled.
  const worktrees =
    process.env.OTTILI_DISABLE_AGENT_WORKTREES === "true"
      ? undefined
      : new GitWorktreeProvisioner();
  // A checkpoint (a real Git snapshot ref plus a graph-state manifest) is
  // captured every time a task completes; best-effort, so a workspace that
  // is not a Git repository simply never accumulates any.
  const checkpointOnTaskCompletion =
    process.env.OTTILI_DISABLE_CHECKPOINTS !== "true";

  const daemon = new DurableDaemon({
    allowProtocolShutdown: true,
    databasePath:
      process.env.OTTILI_CODER_DATABASE ?? join(configDirectory, "coder.db"),
    executor: (store) =>
      new RunCoordinator(store, {
        checkpointOnTaskCompletion,
        ...(lspManager === undefined
          ? {}
          : { context: { diagnostics: lspManager } }),
        model,
        provider,
        ...(worktrees === undefined ? {} : { worktrees }),
        tools: async ({ workspaceUri }) => {
          const workspace = workspacePath(workspaceUri, fallbackWorkspace);
          const registries = [
            createWorkspaceTools({
              allowedCommands: allowedCommandsFromEnvironment(),
              workspace,
            }),
            ...(mcpSupervisor === undefined
              ? []
              : [await createMcpTools(mcpSupervisor)]),
            ...(lspManager === undefined
              ? []
              : [lspManager.createTools(workspace)]),
          ];
          return mergeToolRegistries(registries);
        },
      }),
    scheduler: { pollIntervalMs: 500 },
    server: {
      checkpointRestorer: new GitCheckpointRestorer(),
      host: url.hostname,
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
      ...(process.env.OTTILI_CODER_DAEMON_TOKEN === undefined
        ? {}
        : { token: process.env.OTTILI_CODER_DAEMON_TOKEN }),
    },
  });
  await daemon.start();
  let closing: Promise<void> | undefined;
  const shutdown = async (): Promise<void> => {
    closing ??= (async () => {
      if (mcpReconcileTimer !== undefined) clearInterval(mcpReconcileTimer);
      await daemon.close();
      await Promise.all([
        ...(mcpSupervisor === undefined
          ? []
          : mcpSupervisor
              .list()
              .map((status) => mcpSupervisor.disconnect(status.id))),
        lspManager?.close(),
      ]);
    })();
    await closing;
  };
  // POSIX hosts stop daemons with signals. Windows has no graceful signal, so
  // the protocol shutdown request is the portable path; both converge here.
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  await daemon.whenShutdownRequested();
  await shutdown();
}

/** Later registries never silently replace an earlier tool of the same name. */
function mergeToolRegistries(
  registries: readonly ToolRegistry[],
): ToolRegistry {
  const merged = new ToolRegistry();
  for (const registry of registries) {
    for (const definition of registry.list()) {
      if (merged.get(definition.name) === undefined) {
        merged.register(definition);
      }
    }
  }
  return merged;
}

function workspacePath(workspaceUri: string, fallback: string): string {
  if (!workspaceUri.startsWith("file:")) return fallback;
  try {
    return fileURLToPath(workspaceUri);
  } catch {
    return fallback;
  }
}

function allowedCommandsFromEnvironment(): readonly string[] {
  const configured = process.env.OTTILI_ALLOWED_COMMANDS;
  if (configured === undefined) return [];
  return configured
    .split(",")
    .map((command) => command.trim())
    .filter((command) => command.length > 0);
}

/**
 * MCP/LSP servers are opt-in and declarative only: a JSON array of server
 * configs naming an already-installed `command`. Nothing here resolves a
 * package name, downloads a binary, or runs a shell string — the same
 * default-deny posture as `OTTILI_ALLOWED_COMMANDS`.
 */
function mcpServersFromEnvironment(): readonly McpServerConfig[] {
  const configured = process.env.OTTILI_MCP_SERVERS;
  if (configured === undefined || configured.trim().length === 0) return [];
  const parsed: unknown = JSON.parse(configured);
  if (!Array.isArray(parsed)) {
    throw new Error("OTTILI_MCP_SERVERS must be a JSON array.");
  }
  return parsed.map((entry) =>
    parseMcpServerConfig(
      typeof entry === "object" && entry !== null && !("desiredState" in entry)
        ? { ...entry, desiredState: "connected" }
        : entry,
    ),
  );
}

function lspServersFromEnvironment(): readonly LspServerTemplate[] {
  const configured = process.env.OTTILI_LSP_SERVERS;
  if (configured === undefined || configured.trim().length === 0) return [];
  const parsed: unknown = JSON.parse(configured);
  if (!Array.isArray(parsed)) {
    throw new Error("OTTILI_LSP_SERVERS must be a JSON array.");
  }
  // `rootUri` is intentionally never read from configuration: it is filled
  // in per Run workspace by LspServerManager, not declared statically.
  return parsed.map((entry) => parseLspServerConfig(entry));
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
