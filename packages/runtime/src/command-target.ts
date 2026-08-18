import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { win32 } from "node:path";

export interface ResolvedCommandTarget {
  readonly executable: string;
  readonly args: readonly string[];
  /** Set when the argv is already a fully formed Windows command line. */
  readonly windowsVerbatimArguments?: boolean;
}

export interface ResolveCommandTargetOptions {
  readonly platform?: NodeJS.Platform;
  readonly path?: string;
  readonly pathExtensions?: string;
  readonly comspec?: string;
  /** Injectable so the Windows path can be tested from any host. */
  readonly probe?: (candidate: string) => Promise<boolean>;
  readonly workingDirectory?: string;
}

/**
 * Characters `cmd.exe` interprets rather than passes through. An argument that
 * contains one is rejected instead of escaped: cmd's quoting rules differ per
 * context and `%VAR%` expansion cannot be reliably suppressed on a command
 * line, so escaping would be a guess with an injection as the failure mode.
 */
const CMD_METACHARACTERS = /["&|<>^%!()\r\n]/u;
const BATCH_EXTENSIONS = new Set([".cmd", ".bat"]);

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds the file Windows would execute for a bare command name. Node resolves
 * this itself when spawning, but the caller must know the extension in advance
 * to decide whether an interpreter is required.
 */
export async function resolveWindowsExecutable(
  command: string,
  options: ResolveCommandTargetOptions = {},
): Promise<string | undefined> {
  const probe = options.probe ?? isExecutableFile;
  const extensions = (options.pathExtensions ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim())
    .filter((extension) => extension.length > 0);
  // Windows semantics must apply even when this runs on another host, which
  // is how the resolution rules stay testable outside a Windows CI job.
  const candidateRoots =
    win32.isAbsolute(command) || command.includes("/") || command.includes("\\")
      ? [win32.resolve(options.workingDirectory ?? ".", command)]
      : (options.path ?? "")
          .split(";")
          .filter((entry) => entry.length > 0)
          .map((entry) => win32.resolve(entry, command));

  for (const root of candidateRoots) {
    if (win32.extname(root).length > 0 && (await probe(root))) {
      return root;
    }
    for (const extension of extensions) {
      const candidate = `${root}${extension}`;
      if (await probe(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/** Quotes one token for the MSVCRT command-line parser. */
function quoteWindowsArgument(value: string): string {
  if (value.length > 0 && !/[\s]/u.test(value)) {
    return value;
  }
  // Trailing backslashes would otherwise escape the closing quote.
  const escaped = value.replace(/(\\*)$/u, "$1$1");
  return `"${escaped}"`;
}

/**
 * Maps an allowlisted command onto the executable and argv that actually run
 * it. Everything except Windows batch files is executed directly with no shell
 * at all; `.cmd`/`.bat` targets require `cmd.exe`, which Node refuses to spawn
 * implicitly, so they are routed through it under a strict argument contract.
 */
export async function resolveCommandTarget(
  command: string,
  args: readonly string[],
  options: ResolveCommandTargetOptions = {},
): Promise<ResolvedCommandTarget> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { args: [...args], executable: command };
  }

  const resolved = await resolveWindowsExecutable(command, options);
  if (resolved === undefined) {
    // Let the spawn itself produce the authoritative ENOENT for the caller.
    return { args: [...args], executable: command };
  }
  if (!BATCH_EXTENSIONS.has(win32.extname(resolved).toLowerCase())) {
    return { args: [...args], executable: resolved };
  }

  const rejected = [resolved, ...args].find((value) =>
    CMD_METACHARACTERS.test(value),
  );
  if (rejected !== undefined) {
    throw new Error(
      `Command '${command}' is a Windows batch file, which must run through cmd.exe. ` +
        `The argument ${JSON.stringify(rejected)} contains a cmd.exe metacharacter and cannot be passed safely. ` +
        "Invoke the underlying executable directly instead.",
    );
  }

  const commandLine = [resolved, ...args]
    .map((value) => quoteWindowsArgument(value))
    .join(" ");
  return {
    // `/d` skips AutoRun, `/s` keeps the outer quotes off the parsed line.
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    executable: options.comspec ?? process.env.COMSPEC ?? "cmd.exe",
    windowsVerbatimArguments: true,
  };
}
