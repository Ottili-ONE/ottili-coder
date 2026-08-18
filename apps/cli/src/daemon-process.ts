#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DurableDaemon } from "@ottili/server";
import {
  OpenAiCompatibleTurnProvider,
  ProviderFailure,
  RunCoordinator,
  createWorkspaceTools,
  type TurnProvider,
} from "@ottili/runtime";

const defaultDaemonUrl = "http://127.0.0.1:7411";

class UnconfiguredProvider implements TurnProvider {
  public readonly id = "unconfigured";

  public async complete(): Promise<never> {
    throw new ProviderFailure(
      "authentication",
      "No provider is configured. Set OTTILI_PROVIDER_ENDPOINT and OTTILI_PROVIDER_API_KEY, then resume the durable Run.",
    );
  }
}

async function main(): Promise<void> {
  const url = new URL(process.env.OTTILI_CODER_DAEMON_URL ?? defaultDaemonUrl);
  const configDirectory =
    process.env.OTTILI_CODER_CONFIG_DIR ?? join(homedir(), ".ottili", "coder");
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  const fallbackWorkspace = process.env.OTTILI_CODER_WORKSPACE ?? process.cwd();
  const endpoint = process.env.OTTILI_PROVIDER_ENDPOINT;
  const provider: TurnProvider =
    endpoint === undefined
      ? new UnconfiguredProvider()
      : new OpenAiCompatibleTurnProvider({
          ...(process.env.OTTILI_PROVIDER_API_KEY === undefined
            ? {}
            : { apiKey: process.env.OTTILI_PROVIDER_API_KEY }),
          endpoint,
          id: "configured-openai-compatible",
        });
  const daemon = new DurableDaemon({
    allowProtocolShutdown: true,
    databasePath:
      process.env.OTTILI_CODER_DATABASE ?? join(configDirectory, "coder.db"),
    executor: (store) =>
      new RunCoordinator(store, {
        model: process.env.OTTILI_MODEL ?? "default",
        provider,
        tools: ({ workspaceUri }) =>
          createWorkspaceTools({
            allowedCommands: allowedCommandsFromEnvironment(),
            workspace: workspacePath(workspaceUri, fallbackWorkspace),
          }),
      }),
    scheduler: { pollIntervalMs: 500 },
    server: {
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
    closing ??= daemon.close();
    await closing;
  };
  // POSIX hosts stop daemons with signals. Windows has no graceful signal, so
  // the protocol shutdown request is the portable path; both converge here.
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  await daemon.whenShutdownRequested();
  await shutdown();
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

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
