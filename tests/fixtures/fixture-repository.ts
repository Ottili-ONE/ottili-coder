import { cp, mkdtemp, readFile } from "node:fs/promises";
import { removeTempDirectory } from "../support/fs-cleanup.js";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";

const execFile = promisify(execFileCallback);

export const realisticRepositorySource = fileURLToPath(
  new URL("./realistic-repo", import.meta.url),
);

export interface RealisticRepositoryFixture {
  readonly root: string;
  cleanup(): Promise<void>;
  git(args: readonly string[]): Promise<string>;
  read(relativePath: string): Promise<string>;
}

/**
 * Copies the static fixture to a fresh temporary Git repository. The source
 * fixture itself stays inert; only `UNTRACKED.md` is intentionally omitted
 * from the first commit so every caller starts from a known porcelain state.
 */
export async function createRealisticRepositoryFixture(): Promise<RealisticRepositoryFixture> {
  const root = await mkdtemp(join(tmpdir(), "ottili-acceptance-fixture-"));
  await cp(realisticRepositorySource, root, { recursive: true });
  await runGit(root, ["init", "--initial-branch=main"]);
  await runGit(root, ["config", "user.email", "fixture@ottili.test"]);
  await runGit(root, ["config", "user.name", "Ottili Fixture"]);
  await runGit(root, ["add", "."]);
  await runGit(root, ["rm", "--cached", "--ignore-unmatch", "UNTRACKED.md"]);
  await runGit(root, ["commit", "--quiet", "-m", "fixture: baseline"]);

  return {
    root,
    cleanup: async () => await removeTempDirectory(root),
    git: async (args) => await runGit(root, args),
    read: async (relativePath) =>
      await readFile(join(root, relativePath), "utf8"),
  };
}

async function runGit(root: string, args: readonly string[]): Promise<string> {
  const result = await execFile("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1_000_000,
  });
  return result.stdout;
}

/** Ensure tests importing the helper can locate files relative to its source. */
export function fixtureRelativePath(relativePath: string): string {
  return join(
    dirname(realisticRepositorySource),
    "realistic-repo",
    relativePath,
  );
}
