import { resolve } from "node:path";

import { GitSnapshotError, type GitService } from "./git.js";

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
    const primaryPath = await this.git.getRepositoryRoot();
    if (targetPath === primaryPath) {
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

    const created = (await this.list()).find(
      (record) => record.path === targetPath,
    );
    if (created === undefined) {
      throw new GitSnapshotError(
        "Git created a worktree but it could not be listed afterward.",
      );
    }
    if (options.lock === true) {
      await this.lock(targetPath, "Managed by Ottili Coder");
      const locked = (await this.list()).find(
        (record) => record.path === targetPath,
      );
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
    const primaryPath = await this.git.getRepositoryRoot();
    if (targetPath === primaryPath) {
      throw new GitSnapshotError("Refusing to remove the primary worktree.");
    }
    const existing = (await this.list()).find(
      (record) => record.path === targetPath,
    );
    if (existing === undefined) {
      throw new GitSnapshotError(
        `No registered worktree exists at ${targetPath}.`,
      );
    }
    const args = ["worktree", "remove"];
    if (options.force === true) {
      args.push("--force");
    }
    args.push(targetPath);
    await this.git.runGitCommand(args);
  }

  public async lock(path: string, reason?: string): Promise<void> {
    assertNonEmpty(path, "Worktree path");
    const args = ["worktree", "lock"];
    if (reason !== undefined) {
      assertNonEmpty(reason, "Worktree lock reason");
      args.push("--reason", reason);
    }
    args.push(resolve(path));
    await this.git.runGitCommand(args);
  }

  public async unlock(path: string): Promise<void> {
    assertNonEmpty(path, "Worktree path");
    await this.git.runGitCommand(["worktree", "unlock", resolve(path)]);
  }

  public async prune(): Promise<void> {
    await this.git.runGitCommand(["worktree", "prune"]);
  }
}
