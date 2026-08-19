import { dirname, join } from "node:path";

import { GitService, WorktreeManager } from "@ottili/workspace";

import type { WorktreeProvisioner } from "./coordinator.js";

/**
 * Provisions a detached, isolated Git worktree for each delegated Agent, as
 * a sibling of the primary workspace: `<parent>/.ottili-worktrees/<runId>/<agentId>`.
 * Detached at HEAD, never a new branch, so provisioning never collides with
 * an existing branch name or leaves one behind to clean up on failure.
 *
 * `provision` is idempotent by path: if a prior attempt created the worktree
 * on disk but the process crashed before the coordinator durably recorded
 * `worktreeUri`, the retry finds and reuses the existing registered worktree
 * instead of failing on Git's refusal to recreate one at a non-empty path.
 */
export class GitWorktreeProvisioner implements WorktreeProvisioner {
  public async provision(input: {
    readonly agentId: string;
    readonly runId: string;
    readonly workspacePath: string;
  }): Promise<string> {
    const manager = new WorktreeManager(new GitService(input.workspacePath));
    const path = join(
      dirname(input.workspacePath),
      ".ottili-worktrees",
      input.runId,
      input.agentId,
    );
    const existing = await manager.find(path);
    if (existing !== undefined) return existing.path;
    const created = await manager.create({ detach: true, path });
    return created.path;
  }
}
