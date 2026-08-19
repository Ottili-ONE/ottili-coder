import { execFile as execFileCallback } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { removeTempDirectory } from "../support/fs-cleanup.js";

import type { ToolDefinition } from "@ottili/protocol";
import {
  CheckpointService,
  FailureClassifier,
  InMemoryCheckpointStore,
  planToolRecovery,
} from "@ottili/recovery";
import {
  assessSandboxEnforcement,
  canonicalizePath,
  canonicalPathsEqual,
  createSandboxProfile,
  detectSandboxCapabilities,
  GitService,
  inheritSandboxProfile,
  rebindSandboxProfile,
  WorktreeManager,
} from "@ottili/workspace";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFile("git", [...args], { cwd, encoding: "utf8" });
  return result.stdout;
}

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ottili-workspace-test-"));
  temporaryDirectories.push(directory);
  await git(directory, ["init", "--initial-branch=main"]);
  await git(directory, ["config", "user.email", "tests@ottili.local"]);
  await git(directory, ["config", "user.name", "Ottili Tests"]);
  await writeFile(join(directory, "tracked.txt"), "base\n");
  await git(directory, ["add", "tracked.txt"]);
  await git(directory, ["commit", "-m", "initial"]);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => removeTempDirectory(directory)),
  );
});

describe("GitService checkpoints", () => {
  it("captures staged, unstaged, and untracked state under a private ref", async () => {
    const directory = await createRepository();
    const workspace = new GitService(directory);
    await writeFile(
      join(directory, "tracked.txt"),
      "unstaged checkpoint content\n",
    );
    await writeFile(
      join(directory, "staged.txt"),
      "staged checkpoint content\n",
    );
    await git(directory, ["add", "staged.txt"]);
    await writeFile(
      join(directory, "untracked.txt"),
      "untracked checkpoint content\n",
    );

    const snapshot = await workspace.captureCheckpoint({
      runId: "run-42",
      sequence: 7,
    });
    expect(snapshot.ref).toBe("refs/ottili/coder/run-42/checkpoint/7");
    expect(
      await git(directory, ["rev-parse", "--verify", snapshot.ref]),
    ).toContain(snapshot.commit);

    await git(directory, ["reset", "--hard", "HEAD"]);
    await rm(join(directory, "untracked.txt"));
    await writeFile(
      join(directory, "stale.txt"),
      "must disappear after restore\n",
    );
    await writeFile(join(directory, "tracked.txt"), "later content\n");

    await workspace.restoreWorkspaceSnapshot(snapshot);

    await expect(
      readFile(join(directory, "tracked.txt"), "utf8"),
    ).resolves.toBe("unstaged checkpoint content\n");
    await expect(readFile(join(directory, "staged.txt"), "utf8")).resolves.toBe(
      "staged checkpoint content\n",
    );
    await expect(
      readFile(join(directory, "untracked.txt"), "utf8"),
    ).resolves.toBe("untracked checkpoint content\n");
    await expect(
      readFile(join(directory, "stale.txt"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });

    const status = await workspace.getStatus();
    expect(status.hasStagedChanges).toBe(true);
    expect(status.hasUnstagedChanges).toBe(true);
    expect(status.hasUntrackedFiles).toBe(true);
    expect(status.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          indexStatus: " ",
          path: "tracked.txt",
          worktreeStatus: "M",
        }),
        expect.objectContaining({
          indexStatus: "A",
          path: "staged.txt",
          worktreeStatus: " ",
        }),
        expect.objectContaining({ kind: "untracked", path: "untracked.txt" }),
      ]),
    );
  });

  it("manages linked worktrees without permitting removal of the primary worktree", async () => {
    const directory = await createRepository();
    const workspace = new GitService(directory);
    const manager = new WorktreeManager(workspace);
    const linkedPath = join(
      tmpdir(),
      `ottili-linked-${Date.now()}-${Math.random()}`,
    );

    const created = await manager.create({
      branch: "agent-work",
      path: linkedPath,
    });
    expect(
      canonicalPathsEqual(
        await canonicalizePath(created.path),
        await canonicalizePath(linkedPath),
      ),
    ).toBe(true);
    expect(await manager.find(linkedPath)).toBeDefined();
    await expect(manager.remove(directory)).rejects.toThrow("primary worktree");
    await manager.remove(linkedPath);
    expect(await manager.find(linkedPath)).toBeUndefined();
  });

  // macOS CI failed here: `os.tmpdir()` is `/var/folders/...`, a symlink to
  // `/private/var/folders/...`. Git prints the resolved location, so comparing
  // it against `path.resolve` made a freshly created worktree look missing.
  it("manages worktrees when the workspace is reached through a symbolic link", async () => {
    // `os.tmpdir()` is not canonical on either CI platform that matters here:
    // macOS returns `/var/folders/...` for `/private/var/folders/...`, and
    // Windows returns the 8.3 short name `C:\Users\RUNNER~1\...`.
    const realRoot = await canonicalizePath(
      await mkdtemp(join(tmpdir(), "ottili-worktree-real-")),
    );
    temporaryDirectories.push(realRoot);
    const linkRoot = join(
      tmpdir(),
      `ottili-worktree-link-${Date.now()}-${Math.random()}`,
    );
    await symlink(realRoot, linkRoot, "dir");
    temporaryDirectories.push(linkRoot);

    const realRepository = join(realRoot, "repository");
    await mkdir(realRepository);
    await git(realRepository, ["init", "--initial-branch=main"]);
    await git(realRepository, ["config", "user.email", "tests@ottili.local"]);
    await git(realRepository, ["config", "user.name", "Ottili Tests"]);
    await git(realRepository, ["commit", "--allow-empty", "-m", "initial"]);

    const linkedRepository = join(linkRoot, "repository");
    const manager = new WorktreeManager(new GitService(linkedRepository));
    const linkedWorktree = join(linkRoot, "agent-worktree");

    const created = await manager.create({
      branch: "agent-work",
      path: linkedWorktree,
    });
    // Git reports the resolved location; the caller still addresses the link.
    expect(created.path).toBe(join(realRoot, "agent-worktree"));
    expect(await manager.find(linkedWorktree)).toBeDefined();
    await expect(manager.create({ path: linkedRepository })).rejects.toThrow(
      "primary worktree",
    );
    await expect(manager.remove(linkedRepository)).rejects.toThrow(
      "primary worktree",
    );

    await manager.lock(linkedWorktree, "held by a test");
    expect((await manager.find(linkedWorktree))?.lockedReason).toBe(
      "held by a test",
    );
    await manager.unlock(linkedWorktree);
    await manager.remove(linkedWorktree);
    expect(await manager.find(linkedWorktree)).toBeUndefined();
  });

  it("canonicalizes paths that do not exist yet", async () => {
    const realRoot = await canonicalizePath(
      await mkdtemp(join(tmpdir(), "ottili-canonical-real-")),
    );
    temporaryDirectories.push(realRoot);
    const linkRoot = join(
      tmpdir(),
      `ottili-canonical-link-${Date.now()}-${Math.random()}`,
    );
    await symlink(realRoot, linkRoot, "dir");
    temporaryDirectories.push(linkRoot);

    expect(await canonicalizePath(join(linkRoot, "missing", "child"))).toBe(
      join(realRoot, "missing", "child"),
    );
    expect(canonicalPathsEqual("/a/B", "/a/b", "linux")).toBe(false);
    expect(canonicalPathsEqual("/a/B", "/a/b", "darwin")).toBe(true);
    expect(canonicalPathsEqual("C:\\Temp", "c:\\temp", "win32")).toBe(true);
  });

  it("parses porcelain-v2 rename records without losing the original path", async () => {
    const directory = await createRepository();
    const workspace = new GitService(directory);
    await git(directory, ["mv", "tracked.txt", "renamed.txt"]);
    const status = await workspace.getStatus();

    expect(status.entries).toContainEqual({
      indexStatus: "R",
      kind: "renamed_or_copied",
      originalPath: "tracked.txt",
      path: "renamed.txt",
      worktreeStatus: " ",
    });
  });

  it("refuses a restore that would overwrite ignored data it cannot roll back", async () => {
    const directory = await createRepository();
    const workspace = new GitService(directory);
    await writeFile(join(directory, "artifact.txt"), "checkpoint artifact\n");
    await git(directory, ["add", "artifact.txt"]);
    const snapshot = await workspace.captureCheckpoint({
      runId: "run-ignored",
      sequence: 1,
    });
    await git(directory, ["reset", "--hard", "HEAD"]);
    await writeFile(join(directory, ".gitignore"), "artifact.txt\n");
    await writeFile(join(directory, "artifact.txt"), "ignored local data\n");

    await expect(workspace.restoreWorkspaceSnapshot(snapshot)).rejects.toThrow(
      "would overwrite ignored path",
    );
    expect(await readFile(join(directory, "artifact.txt"), "utf8")).toBe(
      "ignored local data\n",
    );
  });
});

describe("transactional checkpoint restore", () => {
  it("rolls the workspace and durable state back when restoring state fails", async () => {
    const directory = await createRepository();
    const workspace = new GitService(directory);
    const checkpoints = new CheckpointService<{ phase: string }>(
      workspace,
      new InMemoryCheckpointStore<{ phase: string }>(),
    );
    const checkpoint = await checkpoints.create({
      runId: "run-restore",
      sequence: 1,
      state: { phase: "checkpoint" },
    });

    await writeFile(join(directory, "tracked.txt"), "pre-restore workspace\n");
    await writeFile(
      join(directory, "pre-restore-untracked.txt"),
      "preserve me\n",
    );
    let durableState: { phase: string } = { phase: "before-restore" };

    const result = await checkpoints.restore(checkpoint.id, {
      capturePreRestoreState: () => durableState,
      restorePreRestoreState: (state) => {
        if (
          typeof state !== "object" ||
          state === null ||
          !("phase" in state) ||
          typeof state.phase !== "string"
        ) {
          throw new Error("invalid durable state");
        }
        durableState = { phase: state.phase };
      },
      restoreRunState: (state) => {
        durableState = state;
        throw new Error("intentional state restore failure");
      },
    });

    if (result.outcome !== "rolled_back") {
      throw new Error(`Expected rollback, got ${result.outcome}`);
    }
    expect(result.rollback.workspaceRestored).toBe(true);
    expect(result.rollback.runStateRestored).toBe(true);
    expect(await readFile(join(directory, "tracked.txt"), "utf8")).toBe(
      "pre-restore workspace\n",
    );
    expect(
      await readFile(join(directory, "pre-restore-untracked.txt"), "utf8"),
    ).toBe("preserve me\n");
    expect(durableState).toEqual({ phase: "before-restore" });
  });
});

describe("sandbox inheritance", () => {
  it("detects native capability and prevents child profiles from broadening permissions", async () => {
    const parent = createSandboxProfile("standard", "/tmp/ottili-parent");
    const child = createSandboxProfile("safe", "/tmp/ottili-parent");
    expect(inheritSandboxProfile(parent, child).mode).toBe("safe");
    expect(() =>
      inheritSandboxProfile(
        parent,
        createSandboxProfile("autonomous", "/tmp/ottili-parent"),
      ),
    ).toThrow("broaden");
    // Sandbox roots are normalized to native absolute paths, which on Windows
    // means a drive-qualified path rather than the POSIX spelling.
    expect(
      rebindSandboxProfile(parent, "/tmp/ottili-worktree").filesystem
        .writableRoots,
    ).toEqual([resolve("/tmp/ottili-worktree")]);

    const capabilities = await detectSandboxCapabilities({
      architecture: "x64",
      executableProbe: async (name) =>
        name === "bwrap" ? "/usr/bin/bwrap" : null,
      platform: "linux",
    });
    expect(assessSandboxEnforcement(parent, capabilities)).toMatchObject({
      backend: "bubblewrap",
      enforcement: "native",
    });
  });
});

describe("failure and tool recovery semantics", () => {
  it("selects observable recovery actions and never blindly retries external work", () => {
    const classifier = new FailureClassifier();
    expect(
      classifier.classify({ source: "provider", statusCode: 429 }),
    ).toMatchObject({
      actions: ["wait", "alternate_provider"],
      kind: "rate_limited",
      retryable: true,
    });
    expect(
      classifier.classify({
        source: "provider",
        error: new Error("maximum context window exceeded"),
      }),
    ).toMatchObject({
      actions: ["compact_context", "new_session_epoch"],
      kind: "context_exhausted",
    });
    expect(
      classifier.classify({ source: "tool", identicalFailureCount: 3 }),
    ).toMatchObject({ kind: "repeated_failure" });

    const safeWorkspaceTool: ToolDefinition = {
      idempotency: "safe",
      name: "test",
      permissions: { required: ["write"] },
      recovery: "retry",
      resourceScopes: [],
      sideEffectClass: "workspace",
      supportsBackground: false,
    };
    const externalTool: ToolDefinition = {
      ...safeWorkspaceTool,
      idempotency: "conditional",
      recovery: "reconcile",
      sideEffectClass: "external",
    };
    const timeout = classifier.classify({
      source: "provider",
      error: new Error("timeout"),
    });
    expect(planToolRecovery(safeWorkspaceTool, timeout)).toMatchObject({
      mayRetryNow: true,
    });
    expect(
      planToolRecovery(
        safeWorkspaceTool,
        classifier.classify({ statusCode: 429 }),
      ),
    ).toMatchObject({ mayRetryNow: false });
    expect(planToolRecovery(externalTool, timeout)).toMatchObject({
      mayRetryNow: false,
    });
    expect(
      planToolRecovery({ ...externalTool, recovery: "retry" }, timeout),
    ).toMatchObject({
      decision: { action: "reconcile" },
      mayRetryNow: false,
    });
  });
});
