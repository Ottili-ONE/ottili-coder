# Persistence and Recovery Model

## SQLite control plane

The control plane uses the Node built-in SQLite API with:

- WAL journal mode;
- foreign keys enabled;
- a busy timeout;
- schema migrations;
- immediate transactions for mutating operations.

The database contains normalized projections for missions, runs, goals, tasks,
dependencies, resource scopes, agents, agent edges, session epochs,
requirements, evidence, validations, checkpoints, tool calls, leases,
scheduled actions, wake conditions, resource locks, and command receipts.

It also contains a per-Run append-only event journal. Projections are the
efficient current view; the event stream is the audit and reconnect record.

## Atomic mutation

A durable mutation generally performs this sequence in one transaction:

```text
read current projection
  → verify state transition / revision / lease fence
  → update projection
  → append next Run event
  → update continuation, receipt, or related record
commit
```

If any part fails, the transaction rolls back. Event sequence numbers are
allocated per Run. An event cannot be successfully committed without its
corresponding projection update for operations that use the control-plane
write path.

## Leases and fencing

Each Run has at most one current lease record. A lease contains an executor
identifier, monotonically increasing generation, expiry, heartbeat, host, and
process metadata.

When an executor acquires an expired or replaced lease, the generation
increases. Fenced APIs compare run ID, executor ID, and generation before
mutating state. A stale executor that still has a process or promise running
therefore receives a lease-fenced error instead of committing a late result.

Lease fencing is an application-level consistency mechanism. It does not make
an already-issued external request disappear; uncertain side effects are
handled by the tool-recovery path.

## Commands and client retries

Pause, resume, and cancel commands carry an idempotency key. The control plane
stores the command receipt and the resulting Run in the same transaction. If a
client retries after a timeout, it receives the original result rather than
applying the action to a later revision.

Steering input is recorded as a durable Run event. Event consumers use the
last sequence to reconnect through history plus SSE.

## Scheduled actions and wakes

Scheduled continuations reside in SQLite. The scheduler queries runnable Runs,
claims a continuation under a current lease, and settles it to either requeue
or defer. Wakes are explicit durable rows rather than setTimeout-only work.

This design accepts that a daemon can crash at any boundary. Recovery is based
on what is durably known, not on what an in-memory promise thought it had done.

## What persistence does not imply

Persistence of intent and state cannot undo an external side effect. A command
may have reached a remote service just before a process crash. Tool metadata
records whether a retry is safe, conditional, or unsafe and whether the next
step is retry, reconciliation, or manual intervention. See
[Recovery](RECOVERY.md).
