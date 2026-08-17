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

CheckpointService is generic over the durable state and workspace lifecycle:

1. Load checkpoint state and prepare workspace restore.
2. Capture a pre-restore workspace fallback.
3. Restore workspace and durable state.
4. Confirm completion or roll back both pieces.

If a later restore stage fails, it attempts to restore both the workspace
fallback and the original durable state. The result reports whether rollback
succeeded. A rollback failure is surfaced as a severe recovery result, not
silently ignored.

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
