import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { GitService, recoverySnapshotRefFor } from "@ottili/workspace";

/**
 * Applies a checkpoint's Git snapshot to the Run's primary workspace. Scoped
 * to the workspace only: the durable Task/Agent Graph and history are left
 * untouched, so a restore is "get the files back to how they were" rather
 * than a full point-in-time reconstruction of every table's state — the
 * latter would need to replay the event log and is a materially larger
 * feature than what this closes.
 *
 * A pre-restore snapshot is always captured first, under its own private
 * ref, so the restore itself is undoable — the same primitive
 * `CheckpointService` uses internally, applied directly here since a
 * workspace-only restore does not need its generic per-caller durable-state
 * hooks.
 *
 * Structurally matches `@ottili/server`'s `CheckpointRestorer` port without
 * importing it: `server` cannot depend on `@ottili/workspace`, and `runtime`
 * has no reason to depend on `server` (an outer layer), so the daemon
 * composition root wires this in by shape, not by a shared interface.
 */
export class GitCheckpointRestorer {
  public async restore(input: {
    readonly checkpointId: string;
    readonly runId: string;
    readonly workspaceRef: string;
    readonly workspaceUri: string;
  }): Promise<{
    readonly preRestoreRef: string;
    readonly restoredRef: string;
  }> {
    const workspacePath = fileURLToPath(input.workspaceUri);
    const git = new GitService(workspacePath);
    const preRestore = await git.captureWorkspaceSnapshot({
      message: `Pre-restore backup before checkpoint ${input.checkpointId}`,
      ref: recoverySnapshotRefFor(input.runId, randomUUID()),
    });
    await git.restoreWorkspaceSnapshot(input.workspaceRef);
    return { preRestoreRef: preRestore.ref, restoredRef: input.workspaceRef };
  }
}
