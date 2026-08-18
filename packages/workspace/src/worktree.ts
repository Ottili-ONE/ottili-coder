import { resolve } from "node:path";

import { GitSnapshotError, type GitService } from "./git.js";
import { canonicalizePath, canonicalPathsEqual } from "./paths.js";

export interface WorktreeRecord {
  readonly path: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly isBare: boolean;
  readonly isDetached: boolean;
  readonly lockedReason: string | null;
  readonly prunableReason: string | null;
}

export interface CreateWorktreeOptions {
  readonly path: string;
  readonly ref?: string;
  /** Create a new branch in the worktree. Mutually exclusive with detach. */
  readonly branch?: string;
  readonly detach?: boolean;
  readonly force?: boolean;
  readonly lock?: boolean;
}

export interface RemoveWorktreeOptions {
  /** Git otherwise refuses to remove a dirty linked worktree. */
  readonly force?: boolean;
}

function parseWorktreeList(raw: string): readonly WorktreeRecord[] {
  const blocks = raw.split(/\r?\n\r?\n/u).filter((block) => block.length > 0);
  const records: WorktreeRecord[] = [];

  for (const block of blocks) {
    let path: string | undefined;
    let head: string | null = null;
    let branch: string | null = null;
    let isBare = false;
    let isDetached = false;
    let lockedReason: string | null = null;
    let prunableReason: string | null = null;

    for (const line of block.split(/\r?\n/u)) {
      if (line === "bare") {
        isBare = true;
        continue;
      }
      if (line === "detached") {
        isDetached = true;
        continue;
      }
      if (line.startsWith("worktree ")) {
        path = line.slice("worktree ".length);
        continue;
      }
      if (line.startsWith("HEAD ")) {
        head = line.slice("HEAD ".length);
        continue;
      }
      if (line.startsWith("branch ")) {
        const ref = line.slice("branch ".length);
        branch = ref.startsWith("refs/heads/")
          ? ref.slice("refs/heads/".length)
          : ref;
        continue;
      }
      if (line === "locked") {
        lockedReason = "";
        continue;
      }
      if (line.startsWith("locked ")) {
        lockedReason = line.slice("locked ".length);
        continue;
      }
      if (line === "prunable") {
        prunableReason = "";
        continue;
      }
      if (line.startsWith("prunable ")) {
        prunableReason = line.slice("prunable ".length);
      }
    }

    if (path === undefined) {
      throw new GitSnapshotError(
        "Malformed `git worktree list --porcelain` output.",
      );
    }
    records.push({
      path: resolve(path),
      head,
      branch,
      isBare,
      isDetached,
      lockedReason,
      prunableReason,
    });
  }

  return records;
}

function assertNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0 || value.includes("\0")) {
    throw new GitSnapshotError(
      `${name} cannot be empty or contain a NUL byte.`,
    );
  }
}

/** Safe lifecycle manager for Git linked worktrees. */
export class WorktreeManager {
  public constructor(private readonly git: GitService) {}

  public async list(): Promise<readonly WorktreeRecord[]> {
    return parseWorktreeList(
      await this.git.runGitCommand(["worktree", "list", "--porcelain"]),
    );
  }

  /**
   * Finds a registered worktree by location rather than by string equality.
   * Git prints the filesystem-canonical path, which differs from a caller's
   * `path.resolve` form whenever the workspace sits behind a symbolic link —
   * the default on macOS, where `os.tmpdir()` lives under `/var` but resolves
   * to `/private/var`.
   */
  public async find(path: string): Promise<WorktreeRecord | undefined> {
    const [records, canonicalTarget] = await Promise.all([
      this.list(),
      canonicalizePath(path),
    ]);
    const canonicalRecords = await Promise.all(
      records.map(async (record) => ({
        record,
        canonical: await canonicalizePath(record.path),
      })),
    );
    return canonicalRecords.find((entry) =>
      canonicalPathsEqual(entry.canonical, canonicalTarget),
    )?.record;
  }

  public async create(options: CreateWorktreeOptions): Promise<WorktreeRecord> {
    assertNonEmpty(options.path, "Worktree path");
    if (options.branch !== undefined) {
      assertNonEmpty(options.branch, "Worktree branch");
    }
    if (options.ref !== undefined) {
      assertNonEmpty(options.ref, "Worktree ref");
    }
    if (options.detach === true && options.branch !== undefined) {
      throw new GitSnapshotError(
        "A detached worktree cannot also create a branch.",
      );
    }

    const targetPath = resolve(options.path);
    if (await this.isPrimaryWorktree(targetPath)) {
      throw new GitSnapshotError(
        "Refusing to create a worktree over the primary worktree.",
      );
    }

    const args = ["worktree", "add"];
    if (options.force === true) {
      args.push("--force");
    }
    if (options.detach === true) {
      args.push("--detach");
    }
    if (options.branch !== undefined) {
      args.push("-b", options.branch);
    }
    // targetPath is absolute; it cannot be mistaken for an option. Arguments
    // are still passed through execFile rather than a shell.
    args.push(targetPath);
    if (options.ref !== undefined) {
      args.push(options.ref);
    }
    await this.git.runGitCommand(args);

    const created = await this.find(targetPath);
    if (created === undefined) {
      throw new GitSnapshotError(
        "Git created a worktree but it could not be listed afterward.",
      );
    }
    if (options.lock === true) {
      await this.lock(created.path, "Managed by Ottili Coder");
      const locked = await this.find(created.path);
      if (locked === undefined) {
        throw new GitSnapshotError(
          "Git worktree disappeared while applying its lock.",
        );
      }
      return locked;
    }
    return created;
  }

  public async remove(
    path: string,
    options: RemoveWorktreeOptions = {},
  ): Promise<void> {
    assertNonEmpty(path, "Worktree path");
    const targetPath = resolve(path);
    if (await this.isPrimaryWorktree(targetPath)) {
      throw new GitSnapshotError("Refusing to remove the primary worktree.");
    }
    const existing = await this.find(targetPath);
    if (existing === undefined) {
      throw new GitSnapshotError(
        `No registered worktree exists at ${targetPath}.`,
      );
    }
    const args = ["worktree", "remove"];
    if (options.force === true) {
      args.push("--force");
    }
    // Pass Git its own registered spelling rather than the caller's, which may
    // travel through a symbolic link Git never recorded.
    args.push(existing.path);
    await this.git.runGitCommand(args);
  }

  public async lock(path: string, reason?: string): Promise<void> {
    assertNonEmpty(path, "Worktree path");
    const args = ["worktree", "lock"];
    if (reason !== undefined) {
      assertNonEmpty(reason, "Worktree lock reason");
      args.push("--reason", reason);
    }
    args.push(await this.registeredPathFor(path));
    await this.git.runGitCommand(args);
  }

  public async unlock(path: string): Promise<void> {
    assertNonEmpty(path, "Worktree path");
    await this.git.runGitCommand([
      "worktree",
      "unlock",
      await this.registeredPathFor(path),
    ]);
  }

  public async prune(): Promise<void> {
    await this.git.runGitCommand(["worktree", "prune"]);
  }

  /** Prefers Git's registered spelling, falling back to the caller's path. */
  private async registeredPathFor(path: string): Promise<string> {
    return (await this.find(path))?.path ?? resolve(path);
  }

  private async isPrimaryWorktree(targetPath: string): Promise<boolean> {
    const [canonicalTarget, canonicalPrimary] = await Promise.all([
      canonicalizePath(targetPath),
      canonicalizePath(await this.git.getRepositoryRoot()),
    ]);
    return canonicalPathsEqual(canonicalTarget, canonicalPrimary);
  }
}
