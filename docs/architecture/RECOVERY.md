# Recovery and Checkpoints

## Recovery principle

After a crash, the system must distinguish what it knows from what it merely
started. It may rehydrate projections and retry safe work, but it must not
blindly repeat an external or destructive action whose outcome is unknown.

```text
intent recorded
  ├── terminal result recorded: resume normally
  └── process died: unknown_after_crash
           ├── retry if explicitly safe
           ├── reconcile when state can be observed
           └── wait for manual intervention when unsafe
```

Tool metadata declares side-effect class, idempotency, and recovery strategy.
The recovery package classifies failures and produces a policy decision instead
of embedding retry behavior in each caller.

## Git workspace snapshots

GitService captures a workspace snapshot through private Ottili refs. It
captures tracked state and can include untracked files using a temporary Git
index. Snapshot/ref names are Run-scoped, allowing checkpoints and recovery
records to be distinguished from a user's ordinary branch history.

The service reports staged, unstaged, and untracked status explicitly. It does
not assume a clean worktree.

## Transactional restore

Two restore mechanisms exist at different layers; only one is reachable
through the daemon API and CLI today.

`GitCheckpointRestorer` (`packages/runtime/src/checkpoint-restore.ts`) is the
live path behind `POST /v1/runs/:id/checkpoints/:checkpointId/restore` and
`ottili-coder checkpoints restore <run-id> <checkpoint-id>`. It is
deliberately scoped to the workspace only: it captures its own undoable
pre-restore Git snapshot, then applies the checkpoint's snapshot via
`GitService.restoreWorkspaceSnapshot`. The durable Task/Agent Graph and event
history are left untouched — restoring reverts files, not the mission's
recorded progress. The route refuses (400) unless the Run is `paused`,
refuses (404) an unknown checkpoint, and refuses (501) if the daemon has no
restorer configured.

`CheckpointService` (`packages/recovery/src/checkpoint.ts`) is a richer,
independently tested primitive generic over both durable state and workspace
lifecycle — capture, pre-restore fallback, restore both pieces, confirm or
roll back both on failure, with rollback failure surfaced as a severe
recovery result rather than silently ignored. It is not currently
instantiated by the daemon composition root; nothing in the reachable
HTTP/CLI surface calls it. Extending checkpoint restore to full
point-in-time Task/Agent Graph reconstruction (not just files) would be the
natural use for it, but that is a materially larger feature than the current
workspace-only restore and has not been built.

## Daemon restart

Restart recovery begins with a successor lease. The scheduler reads durable
scheduled actions, reclaims only expired/replaceable work under its new
generation, evaluates unknown tool calls, and resumes a continuation where
policy permits. The former executor is fenced from subsequent writes.

The recovery tests cover database rehydration, successor generations, stale
lease rejection, Git untracked capture, transactional rollback, sandbox
inheritance, and failure/tool recovery semantics.

## Operator guidance

- Keep the SQLite database and Git repository on storage with appropriate
  durability properties.
- Do not delete private checkpoint refs until their retention policy permits it.
- Test restore in a disposable worktree before relying on a new tool/backend.
- Treat a recovery result requiring manual intervention as a safety event, not
  a prompt to force rerun a command.

See [Persistence](PERSISTENCE.md) for leases, events, and durable scheduling.
