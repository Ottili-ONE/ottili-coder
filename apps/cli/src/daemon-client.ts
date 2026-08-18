import { spawn, type ChildProcess } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { OttiliClient } from "@ottili/sdk";

export const DEFAULT_DAEMON_URL = "http://127.0.0.1:7411";
export const DAEMON_DESCRIPTOR_FILE = "daemon.json";

/**
 * This small record is endpoint discovery only. It deliberately contains no
 * Run, agent, or scheduler state; that data belongs to the daemon database.
 */
export interface DaemonDescriptor {
  readonly instanceId?: string;
  readonly schemaVersion: 1;
  readonly url: string;
  readonly token?: string;
  readonly pid?: number;
  readonly startedAt: string;
  readonly version?: string;
}

export interface DaemonClientEnvironment {
  readonly OTTILI_CODER_CONFIG_DIR?: string;
  readonly OTTILI_CODER_DAEMON_TOKEN?: string;
  readonly OTTILI_CODER_DAEMON_URL?: string;
  readonly OTTILI_DAEMON_COMMAND?: string;
}

export interface DaemonClientOptions {
  readonly configDirectory?: string;
  readonly environment?: DaemonClientEnvironment;
  readonly fetch?: typeof globalThis.fetch;
}

export interface DaemonConnection {
  readonly client: OttiliClient;
  readonly descriptor?: DaemonDescriptor;
  readonly token?: string;
  readonly url: string;
}

export interface DaemonStatus {
  readonly descriptor?: DaemonDescriptor;
  readonly pidAlive: boolean | undefined;
  readonly reachable: boolean;
  readonly ready: boolean;
  readonly url: string;
  readonly version?: string;
}

export interface StartDaemonOptions extends DaemonClientOptions {
  readonly command?: string;
  readonly token?: string;
  readonly url?: string;
  readonly waitMs?: number;
}

export interface StartDaemonResult {
  readonly descriptor: DaemonDescriptor;
  readonly alreadyRunning: boolean;
  readonly process?: ChildProcess;
}

export interface StopDaemonResult {
  readonly descriptor?: DaemonDescriptor;
  readonly stopped: boolean;
}

export class DaemonUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DaemonUnavailableError";
  }
}

export function defaultConfigDirectory(homeDirectory = homedir()): string {
  return join(homeDirectory, ".ottili", "coder");
}

export function daemonDescriptorPath(
  configDirectory = defaultConfigDirectory(),
): string {
  return join(configDirectory, DAEMON_DESCRIPTOR_FILE);
}

export async function readDaemonDescriptor(
  configDirectory = defaultConfigDirectory(),
): Promise<DaemonDescriptor | undefined> {
  const path = daemonDescriptorPath(configDirectory);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error: unknown) {
    if (isMissingFile(error)) return undefined;
    throw new DaemonUnavailableError(
      `Could not read daemon descriptor '${path}': ${messageOf(error)}`,
    );
  }
  if (!isDaemonDescriptor(value)) {
    throw new DaemonUnavailableError(
      `Daemon descriptor '${path}' is malformed.`,
    );
  }
  return value;
}

export async function writeDaemonDescriptor(
  descriptor: DaemonDescriptor,
  configDirectory = defaultConfigDirectory(),
): Promise<void> {
  if (!isDaemonDescriptor(descriptor))
    throw new Error("Cannot write a malformed daemon descriptor.");
  const path = daemonDescriptorPath(configDirectory);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(descriptor, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

export async function removeDaemonDescriptor(
  configDirectory = defaultConfigDirectory(),
): Promise<void> {
  await rm(daemonDescriptorPath(configDirectory), { force: true });
}

export async function connectDaemon(
  options: DaemonClientOptions = {},
): Promise<DaemonConnection> {
  const environment = options.environment ?? process.env;
  const descriptor = await readDaemonDescriptor(options.configDirectory);
  const url = normalizeUrl(
    environment.OTTILI_CODER_DAEMON_URL ??
      descriptor?.url ??
      DEFAULT_DAEMON_URL,
  );
  const token = environment.OTTILI_CODER_DAEMON_TOKEN ?? descriptor?.token;
  return {
    client: new OttiliClient({
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(token === undefined ? {} : { token }),
      baseUrl: url,
    }),
    ...(descriptor === undefined ? {} : { descriptor }),
    ...(token === undefined ? {} : { token }),
    url,
  };
}

export async function inspectDaemon(
  options: DaemonClientOptions = {},
): Promise<DaemonStatus> {
  const connection = await connectDaemon(options);
  const pidAlive =
    connection.descriptor?.pid === undefined
      ? undefined
      : isProcessAlive(connection.descriptor.pid);
  try {
    const [health, ready] = await Promise.all([
      connection.client.health(),
      connection.client.ready(),
    ]);
    return {
      ...(connection.descriptor === undefined
        ? {}
        : { descriptor: connection.descriptor }),
      pidAlive,
      reachable: health.status === "ok",
      ready: ready.ready,
      url: connection.url,
      ...(health.version === undefined ? {} : { version: health.version }),
    };
  } catch {
    return {
      ...(connection.descriptor === undefined
        ? {}
        : { descriptor: connection.descriptor }),
      pidAlive,
      reachable: false,
      ready: false,
      url: connection.url,
    };
  }
}

/**
 * Spawn a separately packaged daemon. The command receives discovery inputs
 * through its environment and is responsible only for serving the requested
 * URL; the CLI writes an atomic descriptor after readiness is observed.
 */
export async function startDaemon(
  options: StartDaemonOptions = {},
): Promise<StartDaemonResult> {
  const environment = options.environment ?? process.env;
  const url = normalizeUrl(
    options.url ?? environment.OTTILI_CODER_DAEMON_URL ?? DEFAULT_DAEMON_URL,
  );
  const token = options.token ?? environment.OTTILI_CODER_DAEMON_TOKEN;
  const configDirectory = options.configDirectory ?? defaultConfigDirectory();
  const probeEnvironment: DaemonClientEnvironment = {
    ...environment,
    OTTILI_CODER_DAEMON_URL: url,
    ...(token === undefined ? {} : { OTTILI_CODER_DAEMON_TOKEN: token }),
  };
  const status = await inspectDaemon({
    configDirectory,
    environment: probeEnvironment,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  if (status.reachable && status.ready) {
    const descriptor =
      status.descriptor?.url === url
        ? status.descriptor
        : {
            schemaVersion: 1 as const,
            startedAt: new Date().toISOString(),
            ...(token === undefined ? {} : { token }),
            url,
            ...(status.version === undefined
              ? {}
              : { version: status.version }),
          };
    if (status.descriptor?.url !== url) {
      await writeDaemonDescriptor(descriptor, configDirectory);
    }
    return { alreadyRunning: true, descriptor };
  }

  const command = options.command ?? environment.OTTILI_DAEMON_COMMAND;
  const childEnvironment = {
    ...process.env,
    ...environment,
    OTTILI_CODER_CONFIG_DIR: configDirectory,
    OTTILI_CODER_DAEMON_DESCRIPTOR: daemonDescriptorPath(configDirectory),
    OTTILI_CODER_DAEMON_URL: url,
    ...(token === undefined ? {} : { OTTILI_CODER_DAEMON_TOKEN: token }),
  };
  const child =
    command === undefined
      ? spawnBundledDaemon(childEnvironment)
      : spawnDaemonCommand(command, childEnvironment);
  child.unref();

  const startedAt = new Date().toISOString();
  const waitMs = options.waitMs ?? 10_000;
  const connection = await waitForReady({
    configDirectory,
    environment: {
      OTTILI_CODER_DAEMON_URL: url,
      ...(token === undefined ? {} : { OTTILI_CODER_DAEMON_TOKEN: token }),
    },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    waitMs,
  });
  const version = await connection.client
    .version()
    .then((value) => value.serverVersion)
    .catch(() => undefined);
  const health = await connection.client.health();
  const descriptor: DaemonDescriptor = {
    schemaVersion: 1,
    startedAt,
    ...(token === undefined ? {} : { token }),
    url,
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    ...(health.instanceId === undefined
      ? {}
      : { instanceId: health.instanceId }),
    ...(version === undefined ? {} : { version }),
  };
  await writeDaemonDescriptor(descriptor, configDirectory);
  return { alreadyRunning: false, descriptor, process: child };
}

/**
 * Spawns the bundled daemon with an explicit argv and no shell. The spawned
 * process is the daemon itself, so the descriptor PID always identifies the
 * process that owns the server — on Windows as well, where the POSIX `exec`
 * builtin that a shell would need does not exist.
 */
function spawnBundledDaemon(
  environment: NodeJS.ProcessEnv,
): ReturnType<typeof spawn> {
  const currentModule = fileURLToPath(import.meta.url);
  const sourceExtension = extname(currentModule);
  const daemonEntry = join(
    dirname(currentModule),
    sourceExtension === ".ts" ? "daemon-process.ts" : "daemon-process.js",
  );
  // Development is deliberately explicit about the TS loader. Built packages
  // use plain Node against the sibling compiled daemon entrypoint.
  const args =
    sourceExtension === ".ts"
      ? ["--import", "tsx", daemonEntry]
      : [daemonEntry];
  return spawn(process.execPath, args, {
    cwd: process.cwd(),
    detached: true,
    env: environment,
    stdio: "ignore",
    windowsHide: true,
  });
}

/**
 * Runs an operator-supplied daemon command string. A shell is unavoidable
 * here because the value is free-form. On POSIX, `exec` replaces the shell so
 * the recorded PID still owns the server; `cmd.exe` has no equivalent, so a
 * Windows override is stopped through the protocol rather than by PID.
 */
function spawnDaemonCommand(
  command: string,
  environment: NodeJS.ProcessEnv,
): ReturnType<typeof spawn> {
  return spawn(process.platform === "win32" ? command : `exec ${command}`, {
    cwd: process.cwd(),
    detached: true,
    env: environment,
    shell: true,
    stdio: "ignore",
    windowsHide: true,
  });
}

export async function stopDaemon(
  options: DaemonClientOptions = {},
): Promise<StopDaemonResult> {
  const descriptor = await readDaemonDescriptor(options.configDirectory);
  if (descriptor === undefined) return { stopped: false };
  if (descriptor.pid === undefined || !isProcessAlive(descriptor.pid)) {
    await removeDaemonDescriptor(options.configDirectory);
    return { descriptor, stopped: false };
  }
  if (descriptor.instanceId === undefined) {
    throw new DaemonUnavailableError(
      `Refusing to stop daemon PID ${descriptor.pid}: descriptor has no immutable daemon identity. Remove the stale descriptor after verifying the process manually.`,
    );
  }
  const connection = await connectDaemon(options);
  let actualInstanceId: string | undefined;
  try {
    actualInstanceId = (await connection.client.health()).instanceId;
  } catch (error: unknown) {
    throw new DaemonUnavailableError(
      `Refusing to stop daemon PID ${descriptor.pid}: endpoint identity could not be verified (${messageOf(error)}).`,
    );
  }
  if (actualInstanceId !== descriptor.instanceId) {
    throw new DaemonUnavailableError(
      `Refusing to stop daemon PID ${descriptor.pid}: descriptor instance identity does not match the endpoint.`,
    );
  }

  // Ask over the protocol first. The daemon then closes the scheduler, HTTP
  // server, and database in order on every platform. A signal is the fallback
  // for daemons that predate the endpoint or refuse the request; on Windows a
  // signal cannot be graceful at all, so there it is a last resort.
  const shutdownRequested = await requestProtocolShutdown(
    connection,
    descriptor.instanceId,
  );
  if (shutdownRequested && (await hasStopped(descriptor.pid, 5_000))) {
    await removeDaemonDescriptor(options.configDirectory);
    return { descriptor, stopped: true };
  }

  try {
    process.kill(descriptor.pid, "SIGTERM");
  } catch (error: unknown) {
    if (isMissingProcess(error)) {
      await removeDaemonDescriptor(options.configDirectory);
      return { descriptor, stopped: shutdownRequested };
    }
    throw new DaemonUnavailableError(
      `Could not stop daemon process ${descriptor.pid}: ${messageOf(error)}`,
    );
  }
  await waitForStopped(descriptor.pid, 5_000);
  await removeDaemonDescriptor(options.configDirectory);
  return { descriptor, stopped: true };
}

async function requestProtocolShutdown(
  connection: DaemonConnection,
  instanceId: string,
): Promise<boolean> {
  try {
    await connection.client.shutdown(instanceId, "ottili-coder daemon stop");
    return true;
  } catch {
    // An older daemon answers 501 and a racing shutdown can drop the socket.
    // Either way the signal path below is still available.
    return false;
  }
}

export async function restartDaemon(
  options: StartDaemonOptions = {},
): Promise<StartDaemonResult> {
  await stopDaemon(options);
  return await startDaemon(options);
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !isMissingProcess(error);
  }
}

async function waitForReady(
  options: DaemonClientOptions & { readonly waitMs: number },
): Promise<DaemonConnection> {
  const timeoutAt = Date.now() + Math.max(0, options.waitMs);
  let lastError: unknown;
  do {
    const connection = await connectDaemon(options);
    try {
      const ready = await connection.client.ready();
      if (ready.ready) return connection;
    } catch (error: unknown) {
      lastError = error;
    }
    if (Date.now() >= timeoutAt) break;
    await delay(Math.min(100, Math.max(1, timeoutAt - Date.now())));
  } while (Date.now() < timeoutAt);
  throw new DaemonUnavailableError(
    `Daemon did not become ready within ${options.waitMs} ms.${lastError === undefined ? "" : ` Last error: ${messageOf(lastError)}`}`,
  );
}

/** Waits for process exit without failing when it is still running. */
async function hasStopped(pid: number, waitMs: number): Promise<boolean> {
  const timeoutAt = Date.now() + waitMs;
  while (isProcessAlive(pid) && Date.now() < timeoutAt) {
    await delay(25);
  }
  return !isProcessAlive(pid);
}

async function waitForStopped(pid: number, waitMs: number): Promise<void> {
  const timeoutAt = Date.now() + waitMs;
  while (isProcessAlive(pid) && Date.now() < timeoutAt) {
    await delay(50);
  }
  if (isProcessAlive(pid)) {
    throw new DaemonUnavailableError(
      `Daemon process ${pid} did not stop within ${waitMs} ms.`,
    );
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new DaemonUnavailableError(
      `Daemon URL '${value}' is not a valid URL.`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new DaemonUnavailableError("Daemon URL must use http or https.");
  }
  return parsed.toString().replace(/\/$/, "");
}

function isDaemonDescriptor(value: unknown): value is DaemonDescriptor {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === 1 &&
    typeof value.url === "string" &&
    typeof value.startedAt === "string" &&
    (value.token === undefined || typeof value.token === "string") &&
    (value.pid === undefined ||
      (typeof value.pid === "number" &&
        Number.isSafeInteger(value.pid) &&
        value.pid > 0)) &&
    (value.instanceId === undefined || typeof value.instanceId === "string") &&
    (value.version === undefined || typeof value.version === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isNodeError(error, "ENOENT");
}

function isMissingProcess(error: unknown): boolean {
  return isNodeError(error, "ESRCH");
}

function isNodeError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Useful to make callers distinguish a missing descriptor from a bad path. */
export async function daemonDescriptorExists(
  configDirectory = defaultConfigDirectory(),
): Promise<boolean> {
  try {
    await access(daemonDescriptorPath(configDirectory));
    return true;
  } catch {
    return false;
  }
}
