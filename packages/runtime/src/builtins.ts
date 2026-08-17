import { spawn } from "node:child_process";
import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { ToolRegistry, type ToolDefinition, type ToolResult } from "./tools.js";

export interface WorkspaceToolOptions {
  readonly allowedCommands?: readonly string[];
  readonly maxOutputBytes?: number;
  readonly workspace: string;
}

const defaultOutputLimit = 256 * 1024;

/**
 * Minimal Node-native tool set for a checked-out workspace. Every path is
 * canonicalized below the root, `.git` is protected, and commands are execve
 * style (never shell-interpolated). Stronger OS sandboxing wraps this boundary.
 */
export function createWorkspaceTools(
  options: WorkspaceToolOptions,
): ToolRegistry {
  const workspace = resolve(options.workspace);
  const maxOutputBytes = options.maxOutputBytes ?? defaultOutputLimit;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new Error("maxOutputBytes must be a positive safe integer.");
  }
  // Process execution is opt-in. A model must never gain arbitrary host
  // command access merely because a workspace tool registry was constructed.
  const allowedCommands = new Set(options.allowedCommands ?? []);
  const registry = new ToolRegistry();
  registry.register(readFileTool(workspace, maxOutputBytes));
  registry.register(writeFileTool(workspace));
  registry.register(
    executeCommandTool(workspace, maxOutputBytes, allowedCommands),
  );
  registry.register(completionTool());
  return registry;
}

function readFileTool(
  workspace: string,
  maxOutputBytes: number,
): ToolDefinition {
  return {
    description:
      "Read a UTF-8 workspace file. Paths must be relative to the workspace and cannot enter .git.",
    idempotency: "safe",
    name: "read_file",
    permissions: { required: ["read"] },
    recovery: "retry",
    resourceScopes: (input) => [`file:${String(input.path ?? "")}`],
    sideEffect: "none",
    supportsBackground: false,
    async execute(input): Promise<ToolResult> {
      const path = await safeWorkspacePath(
        workspace,
        requiredInputString(input, "path"),
      );
      const content = await readFile(path, "utf8");
      return { output: truncate(content, maxOutputBytes) };
    },
  };
}

function writeFileTool(workspace: string): ToolDefinition {
  return {
    description:
      "Atomically write UTF-8 content to an existing workspace directory. .git is never writable.",
    idempotency: "safe",
    name: "write_file",
    permissions: { required: ["write"] },
    recovery: "retry",
    resourceScopes: (input) => [`file:${String(input.path ?? "")}`],
    sideEffect: "workspace",
    supportsBackground: false,
    async execute(input): Promise<ToolResult> {
      const path = await safeWorkspacePath(
        workspace,
        requiredInputString(input, "path"),
      );
      const content = requiredInputString(input, "content");
      const temporary = `${path}.ottili-${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, content, "utf8");
      await rename(temporary, path);
      return {
        output: `Wrote ${Buffer.byteLength(content)} bytes to ${relative(workspace, path)}.`,
      };
    },
  };
}

function executeCommandTool(
  workspace: string,
  maxOutputBytes: number,
  allowedCommands: ReadonlySet<string>,
): ToolDefinition {
  return {
    description:
      "Run one explicitly named executable with argv in the workspace. Shell syntax is not supported.",
    idempotency: "conditional",
    name: "execute_command",
    permissions: { required: ["execute"] },
    recovery: "reconcile",
    resourceScopes: () => ["process:workspace"],
    sideEffect: "workspace",
    supportsBackground: false,
    async execute(input, signal): Promise<ToolResult> {
      const command = requiredInputString(input, "command");
      if (!allowedCommands.has(command)) {
        throw new Error(
          `Command '${command}' is not in the sandbox allowlist.`,
        );
      }
      const args =
        input.args === undefined ? [] : stringArray(input.args, "args");
      const result = await execute(
        command,
        args,
        workspace,
        signal,
        maxOutputBytes,
      );
      if (result.code !== 0) {
        throw new Error(
          `Command '${command}' exited ${result.code}: ${result.stderr}`,
        );
      }
      return {
        output: [result.stdout, result.stderr]
          .filter((part) => part.length > 0)
          .join("\n"),
      };
    },
  };
}

function completionTool(): ToolDefinition {
  return {
    completesRun: true,
    description:
      "Request completion. The independent completion gate decides whether the durable Run may finish.",
    idempotency: "safe",
    name: "request_completion",
    permissions: { required: ["read"] },
    recovery: "retry",
    resourceScopes: () => [],
    sideEffect: "none",
    supportsBackground: false,
    async execute(): Promise<ToolResult> {
      return {
        output:
          "Completion requested; awaiting requirement and independent verification gate.",
      };
    },
  };
}

async function safeWorkspacePath(
  workspace: string,
  supplied: string,
): Promise<string> {
  if (supplied.length === 0) throw new Error("path must not be empty.");
  const root = await realpath(workspace);
  const absolute = resolve(root, supplied);
  // Resolve the target when it exists, otherwise resolve its parent. This
  // prevents a symlink inside the workspace from silently escaping it.
  let canonical: string;
  try {
    canonical = await realpath(absolute);
  } catch (error: unknown) {
    if (!isMissingPath(error)) throw error;
    canonical = resolve(
      await realpath(dirname(absolute)),
      absolute.split(sep).at(-1) ?? "",
    );
  }
  const local = relative(root, canonical);
  if (
    local === ".." ||
    local.startsWith(`..${sep}`) ||
    (local.length === 0 && supplied !== ".")
  ) {
    throw new Error("Path escapes the workspace root.");
  }
  const segments = local.split(/[\\/]/u);
  if (segments.includes(".git"))
    throw new Error("Tools may not access .git directly.");
  return canonical;
}

function isMissingPath(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function requiredInputString(
  input: Record<string, unknown>,
  key: string,
): string {
  const value = input[key];
  if (typeof value !== "string") throw new Error(`${key} must be a string.`);
  return value;
}

function stringArray(value: unknown, key: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new Error(`${key} must be an array of strings.`);
  }
  return value;
}

async function execute(
  command: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal | undefined,
  maxOutputBytes: number,
): Promise<{
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}> {
  if (signal?.aborted) throw abortError(signal);
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const append = (current: string, chunk: string): string =>
      truncate(`${current}${chunk}`, maxOutputBytes);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = append(stderr, chunk);
    });
    const abort = (): void => {
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", abort, { once: true });
    // An abort can race process creation. Check once after registering the
    // listener so an already-aborted scheduler turn cannot dispatch a command.
    if (signal?.aborted) abort();
    child.once("error", (error) => {
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) {
        reject(abortError(signal));
        return;
      }
      resolvePromise({ code: code ?? 1, stderr, stdout });
    });
  });
}

function abortError(signal: AbortSignal): DOMException | Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException(
    typeof reason === "string" ? reason : "Command execution was aborted.",
    "AbortError",
  );
}

function truncate(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return value;
  return `${bytes.subarray(0, maximumBytes).toString("utf8")}\n[output truncated]`;
}
