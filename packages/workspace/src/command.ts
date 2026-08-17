import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export interface CommandOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Deliberately small command boundary used by the workspace services.  Commands
 * are always passed as an executable plus an argv array; no workspace value is
 * ever interpolated into a shell command.
 */
export interface CommandRunner {
  run(
    executable: string,
    args: readonly string[],
    options: CommandOptions,
  ): Promise<CommandResult>;
}

export class CommandExecutionError extends Error {
  public readonly executable: string;
  public readonly args: readonly string[];
  public readonly cwd: string;
  public readonly exitCode: number | null;
  public readonly stdout: string;
  public readonly stderr: string;

  public constructor(input: {
    executable: string;
    args: readonly string[];
    cwd: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    cause?: unknown;
  }) {
    super(
      `${input.executable} ${input.args.join(" ")} failed${
        input.exitCode === null ? "" : ` with exit code ${input.exitCode}`
      }`,
      input.cause === undefined ? undefined : { cause: input.cause },
    );
    this.name = "CommandExecutionError";
    this.executable = input.executable;
    this.args = [...input.args];
    this.cwd = input.cwd;
    this.exitCode = input.exitCode;
    this.stdout = input.stdout;
    this.stderr = input.stderr;
  }
}

interface ExecFileFailure extends Error {
  readonly code?: number | string;
  readonly stdout?: string | Buffer;
  readonly stderr?: string | Buffer;
}

function asText(value: string | Buffer | undefined): string {
  return value === undefined ? "" : value.toString();
}

/** A production runner with bounded output and no shell execution. */
export class NodeCommandRunner implements CommandRunner {
  public async run(
    executable: string,
    args: readonly string[],
    options: CommandOptions,
  ): Promise<CommandResult> {
    try {
      const result = await execFile(executable, [...args], {
        cwd: options.cwd,
        env: options.env,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: options.timeoutMs,
        shell: false,
        windowsHide: true,
      });
      return { stdout: result.stdout, stderr: result.stderr };
    } catch (error: unknown) {
      const failure = error as ExecFileFailure;
      throw new CommandExecutionError({
        executable,
        args,
        cwd: options.cwd,
        exitCode: typeof failure.code === "number" ? failure.code : null,
        stdout: asText(failure.stdout),
        stderr: asText(failure.stderr),
        cause: error,
      });
    }
  }
}
