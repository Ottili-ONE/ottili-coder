import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { importLegacyConfig, previewLegacyConfig } from "@ottili/integrations";
import type {
  Agent,
  Approval,
  Checkpoint,
  PermissionPolicy,
  Run,
  RunEvent,
  RunId,
} from "@ottili/protocol";
import { OttiliClientError } from "@ottili/sdk";

import {
  DaemonUnavailableError,
  connectDaemon,
  daemonDescriptorPath,
  defaultConfigDirectory,
  inspectDaemon,
  restartDaemon,
  startDaemon,
  stopDaemon,
  type DaemonClientEnvironment,
  type DaemonClientOptions,
  type DaemonStatus,
} from "./daemon-client.js";

export interface CliWriter {
  readonly isTTY?: boolean;
  write(chunk: string): boolean;
}

export interface CliIo {
  readonly cwd?: () => string;
  readonly environment?: DaemonClientEnvironment;
  readonly fetch?: typeof globalThis.fetch;
  readonly stderr?: CliWriter;
  readonly stdout?: CliWriter;
}

export interface CliExecutionContext {
  readonly cwd: () => string;
  readonly environment: DaemonClientEnvironment;
  readonly fetch?: typeof globalThis.fetch;
  readonly stderr: CliWriter;
  readonly stdout: CliWriter;
}

export class CliUsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export interface ParsedOptions {
  readonly flags: ReadonlyMap<string, string | true>;
  readonly positionals: readonly string[];
}

const connectionOptionNames = new Set(["daemon", "token", "config-dir"]);
const commonOutputOptionNames = new Set(["json"]);

/** Run a command without ever making the terminal process the Run owner. */
export async function runCli(
  argv: readonly string[],
  io: CliIo = {},
): Promise<number> {
  const context = createContext(io);
  try {
    await executeCli(argv, context);
    return 0;
  } catch (error: unknown) {
    writeLine(context.stderr, `Error: ${messageOf(error)}`);
    if (error instanceof CliUsageError) {
      writeLine(context.stderr, "Run 'ottili-coder help' for usage.");
      return 2;
    }
    if (
      error instanceof DaemonUnavailableError ||
      error instanceof OttiliClientError ||
      error instanceof TypeError
    ) {
      writeLine(
        context.stderr,
        "The run remains durable in the daemon; retry or use 'ottili-coder daemon status'.",
      );
    }
    return 1;
  }
}

export async function executeCli(
  argv: readonly string[],
  context: CliExecutionContext,
): Promise<void> {
  const [command, ...rest] = argv;
  if (
    command === undefined ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    printHelp(context.stdout);
    return;
  }
  switch (command) {
    case "run":
      await executeRun(rest, context);
      return;
    case "attach":
      await executeAttach(rest, context);
      return;
    case "resume":
      await executeResume(rest, context);
      return;
    case "runs":
      await executeRuns(rest, context);
      return;
    case "daemon":
      await executeDaemon(rest, context);
      return;
    case "agents":
      await executeAgents(rest, context);
      return;
    case "checkpoints":
      await executeCheckpoints(rest, context);
      return;
    case "approvals":
      await executeApprovals(rest, context);
      return;
    case "config":
      await executeConfig(rest, context);
      return;
    case "doctor":
      await executeDoctor(rest, context);
      return;
    case "version":
    case "--version":
    case "-v":
      writeLine(context.stdout, "ottili-coder vNext (protocol v1)");
      return;
    default:
      throw new CliUsageError(`Unknown command '${command}'.`);
  }
}

export function printHelp(writer: CliWriter): void {
  writeLine(
    writer,
    `Ottili Coder — durable coding runs, attached through a disposable terminal client.

Usage:
  ottili-coder run <prompt> [--workspace <path-or-uri>]
                            [--permission-mode <safe|standard|autonomous|unrestricted>]
                            [--json] [--follow]
  ottili-coder attach <run-id> [--after <sequence>] [--once] [--follow] [--json]
  ottili-coder resume <run-id> [--follow] [--json]
  ottili-coder runs list [--status <status>] [--limit <count>] [--json]
  ottili-coder run status <run-id> [--json]
  ottili-coder run pause <run-id> [--reason <text>] [--json]
  ottili-coder run resume <run-id> [--reason <text>] [--json]
  ottili-coder run cancel <run-id> [--reason <text>] [--json]
  ottili-coder daemon <start|status|stop|restart> [--url <url>] [--json]
  ottili-coder agents list <run-id> [--json]
  ottili-coder checkpoints list <run-id> [--json]
  ottili-coder approvals list <run-id> [--json]
  ottili-coder approvals resolve <run-id> <approval-id> <approved|rejected> [--resolver <id>] [--json]
  ottili-coder config <preview|import> [--home <path>] [--project <path>] [--overwrite] [--json]
  ottili-coder doctor [--json]

Connection options:
  --daemon <url>          Override the daemon endpoint for this invocation.
  --token <token>         Supply a daemon bearer token for this invocation.
  --config-dir <path>     Override local endpoint-descriptor storage.

Daemon launcher contract:
  daemon start launches the bundled daemon entrypoint by default. Set
  OTTILI_DAEMON_COMMAND to replace it; either receives OTTILI_CODER_DAEMON_URL,
  OTTILI_CODER_DAEMON_TOKEN (when given), and OTTILI_CODER_DAEMON_DESCRIPTOR.
  The daemon owns Runs; closing this client never stops execution.`,
  );
}

function createContext(io: CliIo): CliExecutionContext {
  return {
    cwd: io.cwd ?? (() => process.cwd()),
    environment: io.environment ?? process.env,
    ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
    stderr: io.stderr ?? process.stderr,
    stdout: io.stdout ?? process.stdout,
  };
}

async function executeRun(
  tokens: readonly string[],
  context: CliExecutionContext,
): Promise<void> {
  const subcommand = tokens[0];
  if (
    subcommand === "status" ||
    subcommand === "pause" ||
    subcommand === "resume" ||
    subcommand === "cancel"
  ) {
    await executeRunSubcommand(subcommand, tokens.slice(1), context);
    return;
  }
  const options = parseOptions(tokens, {
    boolean: new Set([...commonOutputOptionNames, "follow"]),
    values: new Set([...connectionOptionNames, "permission-mode", "workspace"]),
  });
  if (options.positionals.length === 0)
    throw new CliUsageError("run requires a prompt.");
  const prompt = options.positionals.join(" ").trim();
  if (prompt.length === 0)
    throw new CliUsageError("run requires a non-empty prompt.");
  const workspace = workspaceUri(
    optionString(options, "workspace"),
    context.cwd(),
  );
  const permissions = permissionPolicy(
    optionString(options, "permission-mode"),
  );
  const connection = await daemonConnection(options, context);
  const created = await connection.client.createRun({
    mission: {
      prompt,
      title: inferTitle(prompt),
      workspaceUri: workspace,
    },
    ...(permissions === undefined
      ? {}
      : {
          permissions,
          // The sandbox caps the Run policy, so raising one without the other
          // would leave every workspace write denied. The mission's own
          // checkout is the writable root; nothing outside it is granted.
          sandbox: {
            filesystem: { readOnlyRoots: [], writableRoots: [workspace] },
            network: { allowedDestinations: [], enabled: false },
            permissions,
            process: { enabled: true },
          },
        }),
  });
  if (hasFlag(options, "json")) {
    writeJson(context.stdout, created);
  } else {
    writeLine(
      context.stdout,
      `Run ${created.run.id} created (${created.run.status}).`,
    );
    writeLine(context.stdout, `Workspace: ${workspace}`);
    writeLine(
      context.stdout,
      `Attach with: ottili-coder attach ${created.run.id}`,
    );
  }
  if (hasFlag(options, "follow")) {
    await attachRun(
      created.run.id,
      0,
      true,
      hasFlag(options, "json"),
      context,
      options,
    );
  }
}

async function executeRunSubcommand(
  subcommand: "status" | "pause" | "resume" | "cancel",
  tokens: readonly string[],
  context: CliExecutionContext,
): Promise<void> {
  const options = parseOptions(tokens, {
    boolean: commonOutputOptionNames,
    values: new Set([...connectionOptionNames, "reason"]),
  });
  const runId = requiredRunId(options, `run ${subcommand}`);
  const connection = await daemonConnection(options, context);
  if (subcommand === "status") {
    const value = await connection.client.getRun(runId);
    emitRunDetail(
      context.stdout,
      value.run,
      value.agents,
      hasFlag(options, "json"),
    );
    return;
  }
  const reason = optionString(options, "reason");
  const value = await connection.client.command(runId, {
    command: subcommand,
    ...(reason === undefined ? {} : { reason }),
  });
  emitRun(context.stdout, value.run, hasFlag(options, "json"));
}

async function executeAttach(
  tokens: readonly string[],
  context: CliExecutionContext,
): Promise<void> {
  const options = parseOptions(tokens, {
    boolean: new Set([...commonOutputOptionNames, "follow", "once"]),
    values: new Set([...connectionOptionNames, "after"]),
  });
  const runId = requiredRunId(options, "attach");
  const after = parseSequence(optionString(options, "after"));
  const follow =
    hasFlag(options, "follow") ||
    (!hasFlag(options, "once") && context.stdout.isTTY === true);
  await attachRun(
    runId,
    after,
    follow,
    hasFlag(options, "json"),
    context,
    options,
  );
}

async function executeResume(
  tokens: readonly string[],
  context: CliExecutionContext,
): Promise<void> {
  const options = parseOptions(tokens, {
    boolean: new Set([...commonOutputOptionNames, "follow"]),
    values: new Set([...connectionOptionNames, "reason"]),
  });
  const runId = requiredRunId(options, "resume");
  const connection = await daemonConnection(options, context);
  const reason = optionString(options, "reason");
  const value = await connection.client.command(runId, {
    command: "resume",
    ...(reason === undefined ? {} : { reason }),
  });
  emitRun(context.stdout, value.run, hasFlag(options, "json"));
  if (hasFlag(options, "follow"))
    await attachRun(runId, 0, true, hasFlag(options, "json"), context, options);
}

async function executeRuns(
  tokens: readonly string[],
  context: CliExecutionContext,
): Promise<void> {
  if (tokens[0] !== "list")
    throw new CliUsageError("runs supports only 'runs list'.");
  const options = parseOptions(tokens.slice(1), {
    boolean: commonOutputOptionNames,
    values: new Set([...connectionOptionNames, "limit", "status"]),
  });
  if (options.positionals.length > 0)
    throw new CliUsageError("runs list does not accept positional arguments.");
  const connection = await daemonConnection(options, context);
  const limit = parsePositiveInteger(optionString(options, "limit"), "limit");
  const status = optionString(options, "status");
  const result = await connection.client.listRuns({
    ...(limit === undefined ? {} : { limit }),
    ...(status === undefined ? {} : { status }),
  });
  if (hasFlag(options, "json")) {
    writeJson(context.stdout, result);
    return;
  }
  if (result.runs.length === 0) {
    writeLine(context.stdout, "No durable runs found.");
    return;
  }
  for (const run of result.runs) writeLine(context.stdout, formatRun(run));
}

async function executeDaemon(
  tokens: readonly string[],
  context: CliExecutionContext,
): Promise<void> {
  const action = tokens[0] ?? "status";
  const options = parseOptions(tokens.slice(action === undefined ? 0 : 1), {
    boolean: commonOutputOptionNames,
    values: new Set([...connectionOptionNames, "command", "url", "wait-ms"]),
  });
  const configDirectory = optionString(options, "config-dir");
  const connectionOptions: DaemonClientOptions = {
    ...(configDirectory === undefined ? {} : { configDirectory }),
    environment: environmentFor(options, context),
    ...(context.fetch === undefined ? {} : { fetch: context.fetch }),
  };
  switch (action) {
    case "status": {
      const status = await inspectDaemon(connectionOptions);
      emitDaemonStatus(context.stdout, status, hasFlag(options, "json"));
      return;
    }
    case "start": {
      const value = await startDaemon(
        startOptionsFor(options, connectionOptions),
      );
      if (hasFlag(options, "json")) writeJson(context.stdout, value.descriptor);
      else
        writeLine(
          context.stdout,
          value.alreadyRunning
            ? `Daemon already ready at ${value.descriptor.url}.`
            : `Daemon started at ${value.descriptor.url}.`,
        );
      return;
    }
    case "stop": {
      const value = await stopDaemon(connectionOptions);
      if (hasFlag(options, "json")) writeJson(context.stdout, value);
      else
        writeLine(
          context.stdout,
          value.stopped
            ? "Daemon stopped."
            : "No running daemon descriptor was found.",
        );
      return;
    }
    case "restart": {
      const value = await restartDaemon(
        startOptionsFor(options, connectionOptions),
      );
      if (hasFlag(options, "json")) writeJson(context.stdout, value.descriptor);
      else
        writeLine(
          context.stdout,
          `Daemon restarted at ${value.descriptor.url}.`,
        );
      return;
    }
    default:
      throw new CliUsageError(
        "daemon supports start, status, stop, or restart.",
      );
  }
}

async function executeAgents(
  tokens: readonly string[],
  context: CliExecutionContext,
): Promise<void> {
  if (tokens[0] !== "list")
    throw new CliUsageError("agents supports only 'agents list <run-id>'.");
  const options = parseOptions(tokens.slice(1), {
    boolean: commonOutputOptionNames,
    values: connectionOptionNames,
  });
  const runId = requiredRunId(options, "agents list");
  const value = await (
    await daemonConnection(options, context)
  ).client.agents(runId);
  if (hasFlag(options, "json")) {
    writeJson(context.stdout, value);
    return;
  }
  if (value.agents.length === 0) {
    writeLine(context.stdout, "No agents recorded for this run.");
    return;
  }
  for (const agent of value.agents)
    writeLine(context.stdout, formatAgent(agent));
}

async function executeCheckpoints(
  tokens: readonly string[],
  context: CliExecutionContext,
): Promise<void> {
  if (tokens[0] !== "list")
    throw new CliUsageError(
      "checkpoints supports only 'checkpoints list <run-id>'.",
    );
  const options = parseOptions(tokens.slice(1), {
    boolean: commonOutputOptionNames,
    values: connectionOptionNames,
  });
  const runId = requiredRunId(options, "checkpoints list");
  const value = await (
    await daemonConnection(options, context)
  ).client.checkpoints(runId);
  if (hasFlag(options, "json")) {
    writeJson(context.stdout, value);
    return;
  }
  if (value.checkpoints.length === 0) {
    writeLine(context.stdout, "No checkpoints recorded for this run.");
    return;
  }
  for (const checkpoint of value.checkpoints)
    writeLine(context.stdout, formatCheckpoint(checkpoint));
}

async function executeApprovals(
  tokens: readonly string[],
  context: CliExecutionContext,
): Promise<void> {
  const action = tokens[0];
  if (action !== "list" && action !== "resolve") {
    throw new CliUsageError(
      "approvals supports 'approvals list <run-id>' or 'approvals resolve <run-id> <approval-id> <approved|rejected>'.",
    );
  }
  const options = parseOptions(tokens.slice(1), {
    boolean: commonOutputOptionNames,
    values:
      action === "resolve"
        ? new Set([...connectionOptionNames, "resolver"])
        : connectionOptionNames,
  });
  if (action === "list") {
    const runId = requiredRunId(options, "approvals list");
    const value = await (
      await daemonConnection(options, context)
    ).client.approvals(runId);
    if (hasFlag(options, "json")) {
      writeJson(context.stdout, value);
      return;
    }
    if (value.approvals.length === 0) {
      writeLine(context.stdout, "No approvals recorded for this run.");
      return;
    }
    for (const approval of value.approvals)
      writeLine(context.stdout, formatApproval(approval));
    return;
  }

  const [runId, approvalId, status, ...extra] = options.positionals;
  if (
    runId === undefined ||
    approvalId === undefined ||
    status === undefined ||
    extra.length > 0
  ) {
    throw new CliUsageError(
      "approvals resolve requires a run id, approval id, and approved or rejected status.",
    );
  }
  if (status !== "approved" && status !== "rejected") {
    throw new CliUsageError("approval status must be approved or rejected.");
  }
  const value = await (
    await daemonConnection(options, context)
  ).client.resolveApproval(runId as RunId, approvalId, {
    resolverId: optionString(options, "resolver") ?? "local-cli",
    status,
  });
  if (hasFlag(options, "json")) {
    writeJson(context.stdout, value);
    return;
  }
  writeLine(context.stdout, formatApproval(value.approval));
}

async function executeConfig(
  tokens: readonly string[],
  context: CliExecutionContext,
): Promise<void> {
  const action = tokens[0] ?? "preview";
  if (action !== "preview" && action !== "import")
    throw new CliUsageError("config supports preview or import.");
  const options = parseOptions(tokens.slice(1), {
    boolean: new Set([...commonOutputOptionNames, "overwrite"]),
    values: new Set(["home", "project"]),
  });
  if (options.positionals.length > 0)
    throw new CliUsageError(
      `config ${action} does not accept positional arguments.`,
    );
  const homeDirectory = optionString(options, "home");
  const projectDirectory = optionString(options, "project");
  const value =
    action === "import"
      ? await importLegacyConfig({
          ...(homeDirectory === undefined ? {} : { homeDirectory }),
          ...(projectDirectory === undefined ? {} : { projectDirectory }),
          ...(hasFlag(options, "overwrite") ? { overwrite: true } : {}),
        })
      : await previewLegacyConfig({
          ...(homeDirectory === undefined ? {} : { homeDirectory }),
          ...(projectDirectory === undefined ? {} : { projectDirectory }),
        });
  if (hasFlag(options, "json")) {
    writeJson(context.stdout, value);
    return;
  }
  writeLine(
    context.stdout,
    value.importable
      ? "Legacy configuration can be imported."
      : "No importable legacy configuration found.",
  );
  if (value.foundAt !== undefined)
    writeLine(context.stdout, `Source: ${value.foundAt}`);
  writeLine(context.stdout, `Target: ${value.canonicalTarget}`);
  for (const note of value.notes) writeLine(context.stdout, `- ${note}`);
}

async function executeDoctor(
  tokens: readonly string[],
  context: CliExecutionContext,
): Promise<void> {
  const options = parseOptions(tokens, {
    boolean: commonOutputOptionNames,
    values: connectionOptionNames,
  });
  if (options.positionals.length > 0)
    throw new CliUsageError("doctor does not accept positional arguments.");
  const configDirectory =
    optionString(options, "config-dir") ?? defaultConfigDirectory();
  const daemon = await inspectDaemon({
    configDirectory,
    environment: environmentFor(options, context),
    ...(context.fetch === undefined ? {} : { fetch: context.fetch }),
  });
  const report = {
    configDirectory,
    daemon,
    descriptorPath: daemonDescriptorPath(configDirectory),
    node: process.version,
    platform: process.platform,
    workspace: workspaceUri(undefined, context.cwd()),
  };
  if (hasFlag(options, "json")) {
    writeJson(context.stdout, report);
    return;
  }
  writeLine(context.stdout, `Node: ${report.node} (${report.platform})`);
  writeLine(context.stdout, `Workspace: ${report.workspace}`);
  writeLine(context.stdout, `Descriptor: ${report.descriptorPath}`);
  writeLine(
    context.stdout,
    `Config directory: ${report.configDirectory} (${(await pathExists(report.configDirectory)) ? "present" : "not created"})`,
  );
  writeLine(
    context.stdout,
    `Daemon: ${daemon.ready ? "ready" : daemon.reachable ? "reachable but not ready" : "unreachable"} (${daemon.url})`,
  );
  if (daemon.pidAlive !== undefined)
    writeLine(
      context.stdout,
      `Daemon PID: ${daemon.descriptor?.pid ?? "unknown"} (${daemon.pidAlive ? "alive" : "not alive"})`,
    );
  if (daemon.version !== undefined)
    writeLine(context.stdout, `Protocol: ${daemon.version}`);
}

async function attachRun(
  runId: RunId,
  after: number,
  follow: boolean,
  json: boolean,
  context: CliExecutionContext,
  options: ParsedOptions,
): Promise<void> {
  const connection = await daemonConnection(options, context);
  const detail = await connection.client.getRun(runId);
  const history = await connection.client.events(runId, after);
  if (json) {
    writeJson(context.stdout, { ...detail, events: history.events });
  } else {
    emitRunDetail(context.stdout, detail.run, detail.agents, false);
    for (const event of history.events)
      writeLine(context.stdout, formatEvent(event));
  }
  if (!follow) return;

  const next = history.nextSequence;
  const controller = new AbortController();
  const interrupt = (): void => controller.abort();
  process.once("SIGINT", interrupt);
  try {
    for await (const event of connection.client.streamEvents(
      runId,
      next,
      controller.signal,
    )) {
      if (json) writeJson(context.stdout, event);
      else writeLine(context.stdout, formatEvent(event));
    }
  } catch (error: unknown) {
    if (!controller.signal.aborted) throw error;
  } finally {
    process.removeListener("SIGINT", interrupt);
  }
}

async function daemonConnection(
  options: ParsedOptions,
  context: CliExecutionContext,
) {
  const configDirectory = optionString(options, "config-dir");
  return await connectDaemon({
    ...(configDirectory === undefined ? {} : { configDirectory }),
    environment: environmentFor(options, context),
    ...(context.fetch === undefined ? {} : { fetch: context.fetch }),
  });
}

function environmentFor(
  options: ParsedOptions,
  context: CliExecutionContext,
): DaemonClientEnvironment {
  const daemon = optionString(options, "daemon");
  const token = optionString(options, "token");
  return {
    ...context.environment,
    ...(daemon === undefined ? {} : { OTTILI_CODER_DAEMON_URL: daemon }),
    ...(token === undefined ? {} : { OTTILI_CODER_DAEMON_TOKEN: token }),
  };
}

function startOptionsFor(
  options: ParsedOptions,
  connectionOptions: DaemonClientOptions,
) {
  const command = optionString(options, "command");
  const token = optionString(options, "token");
  const url = optionString(options, "url");
  const waitMs = parsePositiveInteger(
    optionString(options, "wait-ms"),
    "wait-ms",
  );
  return {
    ...connectionOptions,
    ...(command === undefined ? {} : { command }),
    ...(token === undefined ? {} : { token }),
    ...(url === undefined ? {} : { url }),
    ...(waitMs === undefined ? {} : { waitMs }),
  };
}

export function parseOptions(
  tokens: readonly string[],
  allowed: {
    readonly boolean: ReadonlySet<string>;
    readonly values: ReadonlySet<string>;
  },
): ParsedOptions {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (token === "--") {
      positionals.push(...tokens.slice(index + 1));
      break;
    }
    if (token === "--help" || token === "-h") {
      throw new CliUsageError("Help is available with 'ottili-coder help'.");
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const [name, inlineValue] = splitOption(token);
    if (allowed.boolean.has(name)) {
      if (inlineValue !== undefined)
        throw new CliUsageError(`Option --${name} does not take a value.`);
      flags.set(name, true);
      continue;
    }
    if (!allowed.values.has(name))
      throw new CliUsageError(`Unknown option --${name}.`);
    const value = inlineValue ?? tokens[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new CliUsageError(`Option --${name} requires a value.`);
    if (inlineValue === undefined) index += 1;
    flags.set(name, value);
  }
  return { flags, positionals };
}

function splitOption(token: string): readonly [string, string | undefined] {
  const equal = token.indexOf("=");
  if (equal === -1) return [token.slice(2), undefined];
  return [token.slice(2, equal), token.slice(equal + 1)];
}

function requiredRunId(options: ParsedOptions, command: string): RunId {
  const [runId, ...extra] = options.positionals;
  if (runId === undefined || runId.length === 0)
    throw new CliUsageError(`${command} requires a run id.`);
  if (extra.length > 0)
    throw new CliUsageError(`${command} accepts exactly one run id.`);
  return runId as RunId;
}

function optionString(
  options: ParsedOptions,
  name: string,
): string | undefined {
  const value = options.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function hasFlag(options: ParsedOptions, name: string): boolean {
  return options.flags.get(name) === true;
}

function parsePositiveInteger(
  value: string | undefined,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new CliUsageError(`--${name} must be a positive integer.`);
  return parsed;
}

function parseSequence(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new CliUsageError("--after must be a non-negative integer.");
  return parsed;
}

function workspaceUri(value: string | undefined, cwd: string): string {
  if (value === undefined) return pathToFileURL(resolve(cwd)).href;
  try {
    const parsed = new URL(value);
    if (parsed.protocol.length > 0) return parsed.toString();
  } catch {
    // Treat non-URLs as paths below.
  }
  return pathToFileURL(resolve(cwd, value)).href;
}

const PERMISSION_MODES = [
  "safe",
  "standard",
  "autonomous",
  "unrestricted",
] as const;

/**
 * Chooses the Run's starting policy. `safe` reads freely and asks before it
 * changes anything; `autonomous` works the checkout on its own but still stops
 * for external and destructive actions.
 */
function permissionPolicy(
  mode: string | undefined,
): PermissionPolicy | undefined {
  if (mode === undefined) return undefined;
  const match = PERMISSION_MODES.find((candidate) => candidate === mode);
  if (match === undefined) {
    throw new CliUsageError(
      `--permission-mode must be one of: ${PERMISSION_MODES.join(", ")}.`,
    );
  }
  return { mode: match };
}

function inferTitle(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.length <= 80 ? compact : `${compact.slice(0, 77)}...`;
}

function emitRun(writer: CliWriter, run: Run, json: boolean): void {
  if (json) writeJson(writer, { run });
  else writeLine(writer, formatRun(run));
}

function emitRunDetail(
  writer: CliWriter,
  run: Run,
  agents: readonly Agent[],
  json: boolean,
): void {
  if (json) {
    writeJson(writer, { agents, run });
    return;
  }
  writeLine(writer, formatRun(run));
  writeLine(writer, `Agents: ${agents.length}`);
}

function emitDaemonStatus(
  writer: CliWriter,
  status: DaemonStatus,
  json: boolean,
): void {
  if (json) {
    writeJson(writer, status);
    return;
  }
  writeLine(
    writer,
    `Daemon: ${status.ready ? "ready" : status.reachable ? "reachable but not ready" : "unreachable"}`,
  );
  writeLine(writer, `URL: ${status.url}`);
  if (status.descriptor?.pid !== undefined)
    writeLine(
      writer,
      `PID: ${status.descriptor.pid} (${status.pidAlive ? "alive" : "not alive"})`,
    );
  if (status.version !== undefined)
    writeLine(writer, `Protocol: ${status.version}`);
}

function formatRun(run: Run): string {
  return `${run.id}\t${run.status}\trev=${run.revision}\t${run.title}`;
}

function formatAgent(agent: Agent): string {
  return `${agent.id}\t${agent.role}\t${agent.status}\t${agent.worktreeUri ?? ""}`.trimEnd();
}

function formatCheckpoint(checkpoint: Checkpoint): string {
  return `${checkpoint.id}\t#${checkpoint.sequence}\t${checkpoint.label}\t${checkpoint.reason}`;
}

function formatApproval(approval: Approval): string {
  return `${approval.id}\t${approval.status}\t${approval.summary}`;
}

function formatEvent(event: RunEvent): string {
  return `#${event.sequence}\t${event.type}\t${event.createdAt}`;
}

function writeJson(writer: CliWriter, value: unknown): void {
  writeLine(writer, JSON.stringify(value));
}

function writeLine(writer: CliWriter, value: string): void {
  writer.write(`${value}\n`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
