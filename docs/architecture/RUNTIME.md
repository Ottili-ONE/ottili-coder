# Runtime Architecture

## Turn execution

The runtime turns a scheduled action into an LLM/tool turn. It deliberately
does not hold durable truth in a JavaScript promise or chat transcript:

1. The scheduler obtains a current Run lease.
2. The runtime reads the Mission, Run, Goal, and coordinator Agent from the
   control plane.
3. It creates a durable SessionEpoch and records turn-started.
4. It invokes a TurnProvider through AgentTurnEngine.
5. Before every tool invocation it records a durable tool intent. It records a
   success or failure result after execution.
6. It records usage and assistant output through fenced events.
7. It closes the SessionEpoch and asks the completion gate to evaluate any
   completion proposal.
8. It returns a durable requeue decision to the scheduler.

An executor may be restarted at any boundary. It is safe only because each
side effect has a durable envelope and every executor-owned write carries the
lease generation.

## Providers

The runtime uses a narrow provider contract rather than binding a model SDK to
the domain model. The OpenAI-compatible adapter sends non-streaming chat
completion requests and normalizes response text, request ID, and optional
usage. Provider failures are classified into structured categories with
retryability and optional retry-after data.

The Ottili AI adapter is an OpenAI-compatible managed-provider adapter. It is
separate from local BYOK adapters. An account login is not required for BYOK
use.

Provider implementation notes:

- transport errors and retryable HTTP responses schedule a durable wake;
- a non-retryable provider failure moves a Run to waiting_external rather than
  silently treating it as complete;
- context-overflow handling ends the current SessionEpoch, records compaction
  metadata, and schedules a new continuation;
- provider credentials are constructor inputs and must not be serialized into
  event payloads or checkpoints.

## Tools

Tool definitions are serializable metadata plus an in-process executor. Each
definition declares side-effect class, idempotency, recovery strategy,
resource scopes, background support, and required permissions.

```text
intent persisted → tool runs → terminal outcome persisted
                     │
                     └─ crash: mark unknown and reconcile/retry/manual by policy
```

The recovery policy refuses a blind replay of unsafe or external work.
Resource scopes allow the control plane to identify conflicting writers. A tool
that requests completion is only a proposal mechanism; it does not bypass
validation.

## Scheduling boundary

AgentTurnEngine owns one bounded turn. RunScheduler owns durable polling,
lease acquisition, wake processing, and continuation claim/settlement. The
runtime coordinator is replaceable and does not retain an in-memory queue.

The scheduler invokes its executor with an AbortSignal. Stopping a scheduler
aborts active local execution but does not cancel a durable Run. A replacement
scheduler must acquire a later lease generation before it can continue.

## Completion

The runtime detects a successful completion-capable tool, then passes the
current requirement ledger and deterministic validation records to
CompletionGate. CompletionGate rejects a proposal when any required
requirement is unproven or contradicted, a deterministic validation failed, or
no independent verifier is configured. Only a successful gate decision is
passed to the control plane for a Run transition to completed.

This separates ordinary assistant text from proof. A useful implementation
should continue working after an ordinary response rather than conflating
silence with success.

## Failure classification

Failure classification is intentionally policy-oriented:

| Condition                      | Durable response                                                       |
| ------------------------------ | ---------------------------------------------------------------------- |
| Retryable provider failure     | Record failure, schedule wake, defer action.                           |
| Context overflow               | End epoch, record compaction, continue in fresh epoch.                 |
| Non-retryable provider failure | Move Run to waiting_external.                                          |
| Tool crash after intent        | Recover by tool metadata; possibly reconcile or require manual action. |
| Stale lease                    | Reject mutation; successor is authoritative.                           |

See [Recovery](RECOVERY.md) and [Persistence](PERSISTENCE.md) for the
durability details.
