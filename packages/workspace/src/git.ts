import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import {
  CommandExecutionError,
  type CommandRunner,
  NodeCommandRunner,
} from "./command.js";

export type GitStatusEntryKind =
  "ordinary" | "renamed_or_copied" | "unmerged" | "untracked" | "ignored";

export interface GitStatusEntry {
  readonly kind: GitStatusEntryKind;
  readonly path: string;
  readonly originalPath?: string;
  /** The index half of Git's porcelain XY status, if applicable. */
  readonly indexStatus: string;
  /** The worktree half of Git's porcelain XY status, if applicable. */
  readonly worktreeStatus: string;
}

export interface GitStatus {
  readonly repositoryRoot: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly entries: readonly GitStatusEntry[];
  readonly isDirty: boolean;
  readonly hasStagedChanges: boolean;
  readonly hasUnstagedChanges: boolean;
  readonly hasUntrackedFiles: boolean;
  readonly hasConflicts: boolean;
}

export interface GitBranch {
  readonly name: string;
  readonly commit: string;
  readonly isCurrent: boolean;
}

export interface RepositoryIdentity {
  readonly root: string;
  readonly gitDirectory: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly remotes: Readonly<Record<string, string>>;
}

export interface GitCheckpointSnapshot {
  /** A private Ottili ref, never refs/stash. */
  readonly ref: string;
  /** Commit whose tree represents the complete working tree at capture time. */
  readonly commit: string;
  /** HEAD at capture time. */
  readonly baseCommit: string;
  /** Commit whose tree represents the index at capture time. */
  readonly indexCommit: string;
  readonly capturedAt: string;
}

export interface CaptureWorkspaceSnapshotOptions {
  readonly ref: string;
  readonly message?: string;
}

export interface CaptureCheckpointOptions {
  readonly runId: string;
  readonly sequence: number;
  readonly message?: string;
}

export interface GitDiffOptions {
  readonly staged?: boolean;
  readonly pathspec?: readonly string[];
}

export interface GitServiceOptions {
  readonly runner?: CommandRunner;
  readonly gitExecutable?: string;
  readonly commandTimeoutMs?: number;
}

export class GitOperationError extends Error {
  public readonly args: readonly string[];
  public readonly workspacePath: string;
  public readonly stdout: string;
  public readonly stderr: string;
  public readonly exitCode: number | null;

  public constructor(
    workspacePath: string,
    args: readonly string[],
    cause: CommandExecutionError,
  ) {
    super(`Git operation failed: git ${args.join(" ")}`, { cause });
    this.name = "GitOperationError";
    this.args = [...args];
    this.workspacePath = workspacePath;
    this.stdout = cause.stdout;
    this.stderr = cause.stderr;
    this.exitCode = cause.exitCode;
  }
}

export class GitSnapshotError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitSnapshotError";
  }
}

interface GitCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
}

const PRIVATE_REF_PREFIX = "refs/ottili/coder/";
const SNAPSHOT_AUTHOR_NAME = "Ottili Coder";
const SNAPSHOT_AUTHOR_EMAIL = "checkpoint@ottili.local";

function trimOutput(value: string): string {
  return value.replace(/[\r\n]+$/u, "");
}

function commandExitCode(error: unknown): number | null {
  if (error instanceof GitOperationError) {
    return error.exitCode;
  }
  return null;
}

function requireField(
  fields: readonly string[],
  index: number,
  context: string,
): string {
  const value = fields[index];
  if (value === undefined || value.length === 0) {
    throw new GitSnapshotError(
      `Malformed Git output while parsing ${context}.`,
    );
  }
  return value;
}

// Porcelain v2 represents an unchanged XY slot with `.` while the familiar
// short-status format uses a space. Expose the latter consistently to callers.
function normalizeStatusCharacter(value: string): string {
  return value === "." ? " " : value;
}

/** Returns the first `fieldCount` space-delimited fields and the untouched tail. */
function splitFieldsAndTail(
  record: string,
  fieldCount: number,
  context: string,
): { readonly fields: readonly string[]; readonly tail: string } {
  const fields: string[] = [];
  let cursor = 0;
  for (let index = 0; index < fieldCount; index += 1) {
    const separator = record.indexOf(" ", cursor);
    if (separator === -1) {
      throw new GitSnapshotError(
        `Malformed Git output while parsing ${context}.`,
      );
    }
    fields.push(record.slice(cursor, separator));
    cursor = separator + 1;
  }
  const tail = record.slice(cursor);
  if (tail.length === 0) {
    throw new GitSnapshotError(
      `Malformed Git output while parsing ${context}.`,
    );
  }
  return { fields, tail };
}

function parsePorcelainV2(raw: string): readonly GitStatusEntry[] {
  const records = raw.split("\0");
  const entries: GitStatusEntry[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length === 0) {
      continue;
    }

    if (record.startsWith("1 ")) {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const parsed = splitFieldsAndTail(record, 8, "ordinary status");
      const xy = requireField(parsed.fields, 1, "ordinary status");
      entries.push({
        kind: "ordinary",
        path: parsed.tail,
        indexStatus: normalizeStatusCharacter(xy.charAt(0)),
        worktreeStatus: normalizeStatusCharacter(xy.charAt(1)),
      });
      continue;
    }

    if (record.startsWith("2 ")) {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>\0<origPath>
      const parsed = splitFieldsAndTail(record, 9, "rename/copy status");
      const xy = requireField(parsed.fields, 1, "rename/copy status");
      const originalPath = records[index + 1];
      if (originalPath === undefined || originalPath.length === 0) {
        throw new GitSnapshotError(
          "Malformed Git output: rename/copy source path is missing.",
        );
      }
      entries.push({
        kind: "renamed_or_copied",
        path: parsed.tail,
        originalPath,
        indexStatus: normalizeStatusCharacter(xy.charAt(0)),
        worktreeStatus: normalizeStatusCharacter(xy.charAt(1)),
      });
      index += 1;
      continue;
    }

    if (record.startsWith("u ")) {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const parsed = splitFieldsAndTail(record, 10, "unmerged status");
      const xy = requireField(parsed.fields, 1, "unmerged status");
      entries.push({
        kind: "unmerged",
        path: parsed.tail,
        indexStatus: normalizeStatusCharacter(xy.charAt(0)),
        worktreeStatus: normalizeStatusCharacter(xy.charAt(1)),
      });
      continue;
    }

    if (record.startsWith("? ")) {
      entries.push({
        kind: "untracked",
        path: record.slice(2),
        indexStatus: "?",
        worktreeStatus: "?",
      });
      continue;
    }

    if (record.startsWith("! ")) {
      entries.push({
        kind: "ignored",
        path: record.slice(2),
        indexStatus: "!",
        worktreeStatus: "!",
      });
      continue;
    }

    throw new GitSnapshotError(
      `Unsupported Git porcelain v2 record: ${record.slice(0, 24)}`,
    );
  }

  return entries;
}

function assertRefComponent(value: string, name: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) ||
    value.includes("..") ||
    value.endsWith(".")
  ) {
    throw new GitSnapshotError(
      `${name} must be a safe, non-empty Git ref component.`,
    );
  }
}

function assertPrivateRef(ref: string): void {
  if (!ref.startsWith(PRIVATE_REF_PREFIX)) {
    throw new GitSnapshotError(
      `Checkpoint refs must be below ${PRIVATE_REF_PREFIX}.`,
    );
  }

  const components = ref.split("/");
  if (
    components.length < 5 ||
    components[0] !== "refs" ||
    components[1] !== "ottili"
  ) {
    throw new GitSnapshotError("Checkpoint ref has an invalid shape.");
  }
  for (const component of components.slice(2)) {
    assertRefComponent(component, "Checkpoint ref");
  }
}

function gitEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  // These variables can redirect an otherwise argv-safe Git command to a
  // different repository, worktree, ref namespace, or index. The service is
  // anchored to `workspacePath`; only its own temporary index override is kept.
  delete environment.GIT_DIR;
  delete environment.GIT_WORK_TREE;
  delete environment.GIT_COMMON_DIR;
  delete environment.GIT_INDEX_FILE;
  delete environment.GIT_NAMESPACE;
  return { ...environment, ...overrides };
}

function snapshotEnvironment(indexPath?: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...gitEnvironment(),
    GIT_AUTHOR_NAME: SNAPSHOT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: SNAPSHOT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: SNAPSHOT_AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: SNAPSHOT_AUTHOR_EMAIL,
  };
  if (indexPath !== undefined) {
    environment.GIT_INDEX_FILE = indexPath;
  }
  return environment;
}

/** Build a private ref for a durable run checkpoint. */
export function checkpointRefFor(runId: string, sequence: number): string {
  assertRefComponent(runId, "runId");
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new GitSnapshotError(
      "Checkpoint sequence must be a non-negative safe integer.",
    );
  }
  return `${PRIVATE_REF_PREFIX}${runId}/checkpoint/${sequence}`;
}

/** Build a private ref reserved for a transactional pre-restore backup. */
export function recoverySnapshotRefFor(
  runId: string,
  restoreId: string,
): string {
  assertRefComponent(runId, "runId");
  assertRefComponent(restoreId, "restoreId");
  return `${PRIVATE_REF_PREFIX}${runId}/recovery/${restoreId}`;
}

/**
 * A Git service that only executes Git through an argv-based process boundary.
 * It intentionally never uses Git's stash ref: checkpoint objects live under
 * refs/ottili/coder/ and are therefore invisible to ordinary stash workflows.
 */
export class GitService {
  private readonly runner: CommandRunner;
  private readonly gitExecutable: string;
  private readonly commandTimeoutMs: number | undefined;
  private repositoryRoot: string | undefined;

  public constructor(workspacePath: string, options: GitServiceOptions = {}) {
    this.workspacePath = resolve(workspacePath);
    this.runner = options.runner ?? new NodeCommandRunner();
    this.gitExecutable = options.gitExecutable ?? "git";
    this.commandTimeoutMs = options.commandTimeoutMs;
  }

  public readonly workspacePath: string;

  public async isRepository(): Promise<boolean> {
    try {
      const output = await this.runGit(["rev-parse", "--is-inside-work-tree"]);
      return trimOutput(output) === "true";
    } catch (error: unknown) {
      if (commandExitCode(error) !== null) {
        return false;
      }
      throw error;
    }
  }

  public async getRepositoryRoot(): Promise<string> {
    if (this.repositoryRoot !== undefined) {
      return this.repositoryRoot;
    }
    const output = await this.runGit(["rev-parse", "--show-toplevel"]);
    this.repositoryRoot = resolve(trimOutput(output));
    return this.repositoryRoot;
  }

  public async getGitDirectory(): Promise<string> {
    const output = trimOutput(await this.runGit(["rev-parse", "--git-dir"]));
    return isAbsolute(output)
      ? resolve(output)
      : resolve(this.workspacePath, output);
  }

  public async getHeadCommit(): Promise<string | null> {
    try {
      return trimOutput(
        await this.runGit(["rev-parse", "--verify", "--quiet", "HEAD"]),
      );
    } catch (error: unknown) {
      if (commandExitCode(error) === 1) {
        return null;
      }
      throw error;
    }
  }

  public async getCurrentBranch(): Promise<string | null> {
    try {
      return trimOutput(
        await this.runGit(["symbolic-ref", "--quiet", "--short", "HEAD"]),
      );
    } catch (error: unknown) {
      if (commandExitCode(error) === 1) {
        return null;
      }
      throw error;
    }
  }

  public async getStatus(): Promise<GitStatus> {
    const [repositoryRoot, head, branch, rawStatus] = await Promise.all([
      this.getRepositoryRoot(),
      this.getHeadCommit(),
      this.getCurrentBranch(),
      this.runGit(["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
    ]);
    const entries = parsePorcelainV2(rawStatus);
    const hasStagedChanges = entries.some(
      (entry) =>
        entry.indexStatus !== " " &&
        entry.indexStatus !== "?" &&
        entry.indexStatus !== "!",
    );
    const hasUnstagedChanges = entries.some(
      (entry) =>
        entry.worktreeStatus !== " " &&
        entry.worktreeStatus !== "?" &&
        entry.worktreeStatus !== "!",
    );

    return {
      repositoryRoot,
      head,
      branch,
      entries,
      isDirty: entries.some((entry) => entry.kind !== "ignored"),
      hasStagedChanges,
      hasUnstagedChanges,
      hasUntrackedFiles: entries.some((entry) => entry.kind === "untracked"),
      hasConflicts: entries.some((entry) => entry.kind === "unmerged"),
    };
  }

  public async listBranches(): Promise<readonly GitBranch[]> {
    const raw = await this.runGit([
      "for-each-ref",
      "--format=%(refname:short)%00%(objectname)%00%(HEAD)%00",
      "refs/heads",
    ]);
    const values = raw.split("\0");
    const branches: GitBranch[] = [];
    for (let index = 0; index + 2 < values.length; index += 3) {
      const name = values[index]?.replace(/^\r?\n/u, "");
      const commit = values[index + 1];
      const marker = values[index + 2];
      if (
        name === undefined ||
        name.length === 0 ||
        commit === undefined ||
        marker === undefined
      ) {
        continue;
      }
      branches.push({ name, commit, isCurrent: marker.trim() === "*" });
    }
    return branches;
  }

  public async getRepositoryIdentity(): Promise<RepositoryIdentity> {
    const [root, gitDirectory, head, branch, rawRemotes] = await Promise.all([
      this.getRepositoryRoot(),
      this.getGitDirectory(),
      this.getHeadCommit(),
      this.getCurrentBranch(),
      this.runGit(["remote"]),
    ]);
    const remotes: Record<string, string> = {};
    const names = rawRemotes
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    for (const name of names) {
      try {
        remotes[name] =
          trimOutput(
            await this.runGit(["remote", "get-url", "--all", name]),
          ).split(/\r?\n/u)[0] ?? "";
      } catch (error: unknown) {
        if (commandExitCode(error) === null) {
          throw error;
        }
      }
    }
    return { root, gitDirectory, head, branch, remotes };
  }

  public async getDiff(options: GitDiffOptions = {}): Promise<string> {
    const args = ["diff", "--no-ext-diff", "--binary"];
    if (options.staged === true) {
      args.push("--cached");
    }
    if (options.pathspec !== undefined && options.pathspec.length > 0) {
      args.push("--", ...options.pathspec);
    }
    return this.runGit(args);
  }

  public async stage(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) {
      return;
    }
    await this.runGit(["add", "--", ...paths]);
  }

  public async unstage(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) {
      return;
    }
    await this.runGit(["restore", "--staged", "--", ...paths]);
  }

  public async commit(message: string): Promise<string> {
    if (message.trim().length === 0) {
      throw new GitSnapshotError("Commit message cannot be empty.");
    }
    await this.runGit(["commit", "-m", message]);
    const head = await this.getHeadCommit();
    if (head === null) {
      throw new GitSnapshotError(
        "Git reported a successful commit without a HEAD commit.",
      );
    }
    return head;
  }

  public async revert(commit: string): Promise<void> {
    if (commit.trim().length === 0) {
      throw new GitSnapshotError("Commit to revert cannot be empty.");
    }
    await this.runGit(["revert", "--no-edit", commit]);
  }

  /** Captures the current workspace under refs/ottili/coder/<run>/checkpoint/<n>. */
  public async captureCheckpoint(
    options: CaptureCheckpointOptions,
  ): Promise<GitCheckpointSnapshot> {
    return this.captureWorkspaceSnapshot({
      ref: checkpointRefFor(options.runId, options.sequence),
      ...(options.message === undefined ? {} : { message: options.message }),
    });
  }

  /**
   * Captures both the full working tree and the current index without modifying
   * either. The resulting commit has the captured HEAD and index snapshot as
   * parents, mirroring the useful parts of stash internals without using stash.
   */
  public async captureWorkspaceSnapshot(
    options: CaptureWorkspaceSnapshotOptions,
  ): Promise<GitCheckpointSnapshot> {
    assertPrivateRef(options.ref);
    const [head, indexPath] = await Promise.all([
      this.requireHeadCommit(),
      this.getIndexPath(),
    ]);
    const indexTree = trimOutput(await this.runGit(["write-tree"]));
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "ottili-checkpoint-index-"),
    );
    const temporaryIndexPath = join(temporaryDirectory, "index");
    const temporaryEnvironment = snapshotEnvironment(temporaryIndexPath);

    try {
      try {
        await copyFile(indexPath, temporaryIndexPath);
      } catch (error: unknown) {
        if (!isMissingFileError(error)) {
          throw error;
        }
        await this.runGit(["read-tree", head], { env: temporaryEnvironment });
      }

      // -A includes ordinary untracked files while respecting .gitignore. The
      // temporary index keeps staged state in the real index untouched.
      await this.runGit(["add", "-A"], { env: temporaryEnvironment });
      const workspaceTree = trimOutput(
        await this.runGit(["write-tree"], { env: temporaryEnvironment }),
      );
      const indexCommit = await this.createSnapshotCommit(
        indexTree,
        [head],
        "Ottili checkpoint index snapshot",
      );
      const commit = await this.createSnapshotCommit(
        workspaceTree,
        [head, indexCommit],
        options.message ?? "Ottili workspace checkpoint",
      );
      // A checkpoint sequence is immutable. Requiring a missing old value
      // avoids silently replacing a recoverable snapshot on a duplicate call.
      await this.runGit([
        "update-ref",
        options.ref,
        commit,
        await this.missingObjectId(),
      ]);

      return {
        ref: options.ref,
        commit,
        baseCommit: head,
        indexCommit,
        capturedAt: new Date().toISOString(),
      };
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  public async readCheckpointSnapshot(
    ref: string,
  ): Promise<GitCheckpointSnapshot> {
    assertPrivateRef(ref);
    const commit = trimOutput(
      await this.runGit(["rev-parse", "--verify", `${ref}^{commit}`]),
    );
    const parentsOutput = trimOutput(
      await this.runGit(["show", "-s", "--format=%P", commit]),
    );
    const parents = parentsOutput
      .split(/\s+/u)
      .filter((value) => value.length > 0);
    const baseCommit = parents[0];
    const indexCommit = parents[1];
    if (baseCommit === undefined || indexCommit === undefined) {
      throw new GitSnapshotError(
        `Private ref ${ref} does not point to an Ottili workspace snapshot.`,
      );
    }

    return {
      ref,
      commit,
      baseCommit,
      indexCommit,
      capturedAt: trimOutput(
        await this.runGit(["show", "-s", "--format=%cI", commit]),
      ),
    };
  }

  public async listCheckpoints(
    runId: string,
  ): Promise<readonly GitCheckpointSnapshot[]> {
    assertRefComponent(runId, "runId");
    const prefix = `${PRIVATE_REF_PREFIX}${runId}/checkpoint`;
    const raw = await this.runGit([
      "for-each-ref",
      "--format=%(refname)",
      prefix,
    ]);
    const refs = raw
      .split(/\r?\n/u)
      .map((ref) => ref.trim())
      .filter((ref) => ref.length > 0)
      .sort((left, right) => {
        const leftSequence = Number(left.slice(left.lastIndexOf("/") + 1));
        const rightSequence = Number(right.slice(right.lastIndexOf("/") + 1));
        return leftSequence - rightSequence;
      });
    return Promise.all(
      refs.map(async (ref) => this.readCheckpointSnapshot(ref)),
    );
  }

  public async deletePrivateRef(ref: string): Promise<void> {
    assertPrivateRef(ref);
    await this.runGit(["update-ref", "-d", ref]);
  }

  /**
   * Restores a captured workspace tree and then its captured index. Callers that
   * need failure atomicity should use TransactionalCheckpointService, which
   * captures a recoverable pre-restore state before invoking this method.
   */
  public async restoreWorkspaceSnapshot(
    snapshotOrRef: GitCheckpointSnapshot | string,
  ): Promise<GitCheckpointSnapshot> {
    // Treat the private ref as the source of truth instead of trusting a
    // caller-supplied commit/index pair that could have become stale or been
    // fabricated after it crossed a persistence boundary.
    const snapshot = await this.readCheckpointSnapshot(
      typeof snapshotOrRef === "string" ? snapshotOrRef : snapshotOrRef.ref,
    );
    await this.assertNoIgnoredPathCollision(snapshot.commit);

    // First make the snapshot tree the index, so clean knows which files belong
    // to the destination. `clean -f -d` intentionally leaves ignored files
    // alone: checkpoints promise ordinary untracked files, not user caches.
    await this.runGit(["read-tree", snapshot.commit]);
    await this.runGit(["clean", "-f", "-d", "--"]);
    await this.runGit(["checkout-index", "--all", "--force"]);
    // Re-install the separately captured index after materialising the full
    // worktree. This preserves staged-vs-unstaged state at the checkpoint.
    await this.runGit(["read-tree", snapshot.indexCommit]);
    return snapshot;
  }

  /**
   * Internal-facing argv command hook for the worktree manager. It remains safe
   * because it has no shell layer and is not exposed through a text command API.
   */
  public async runGitCommand(args: readonly string[]): Promise<string> {
    return this.runGit(args);
  }

  private async requireHeadCommit(): Promise<string> {
    const head = await this.getHeadCommit();
    if (head === null) {
      throw new GitSnapshotError(
        "Cannot create a workspace checkpoint before the repository has an initial commit.",
      );
    }
    return head;
  }

  private async getIndexPath(): Promise<string> {
    const output = trimOutput(
      await this.runGit(["rev-parse", "--git-path", "index"]),
    );
    return isAbsolute(output)
      ? resolve(output)
      : resolve(this.workspacePath, output);
  }

  private async missingObjectId(): Promise<string> {
    const objectFormat = trimOutput(
      await this.runGit(["rev-parse", "--show-object-format"]),
    );
    switch (objectFormat) {
      case "sha1":
        return "0".repeat(40);
      case "sha256":
        return "0".repeat(64);
      default:
        throw new GitSnapshotError(
          `Unsupported Git object format '${objectFormat}' for checkpoint refs.`,
        );
    }
  }

  private async assertNoIgnoredPathCollision(
    snapshotCommit: string,
  ): Promise<void> {
    // Ignored files are intentionally not part of normal checkpoints. Refuse a
    // restore that would overwrite one, rather than claiming a transactional
    // rollback can recover data it never captured.
    const [ignoredOutput, targetOutput] = await Promise.all([
      this.runGit([
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "-z",
      ]),
      this.runGit(["ls-tree", "-r", "-z", "--name-only", snapshotCommit]),
    ]);
    const ignoredPaths = ignoredOutput
      .split("\0")
      .filter((path) => path.length > 0)
      .map((path) => path.replace(/\/$/u, ""));
    if (ignoredPaths.length === 0) {
      return;
    }
    const targetPaths = targetOutput
      .split("\0")
      .filter((path) => path.length > 0);
    const collision = targetPaths.find((targetPath) =>
      ignoredPaths.some(
        (ignoredPath) =>
          targetPath === ignoredPath ||
          targetPath.startsWith(`${ignoredPath}/`) ||
          ignoredPath.startsWith(`${targetPath}/`),
      ),
    );
    if (collision !== undefined) {
      throw new GitSnapshotError(
        `Checkpoint restore would overwrite ignored path '${collision}'. Move or remove it before restoring.`,
      );
    }
  }

  private async createSnapshotCommit(
    tree: string,
    parents: readonly string[],
    message: string,
  ): Promise<string> {
    const args = ["commit-tree", tree];
    for (const parent of parents) {
      args.push("-p", parent);
    }
    args.push("-m", message);
    return trimOutput(await this.runGit(args, { env: snapshotEnvironment() }));
  }

  private async runGit(
    args: readonly string[],
    options: GitCommandOptions = {},
  ): Promise<string> {
    const commandOptions = {
      cwd: this.workspacePath,
      env: gitEnvironment(options.env),
      ...(this.commandTimeoutMs === undefined
        ? {}
        : { timeoutMs: this.commandTimeoutMs }),
    };
    try {
      const result = await this.runner.run(
        this.gitExecutable,
        args,
        commandOptions,
      );
      return result.stdout;
    } catch (error: unknown) {
      if (error instanceof CommandExecutionError) {
        throw new GitOperationError(this.workspacePath, args, error);
      }
      throw error;
    }
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
