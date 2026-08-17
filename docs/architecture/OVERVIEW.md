# Architecture Overview

## Governing invariant

The durable entity hierarchy is:

```text
Mission → Run → Goal / Task graph / Agent graph → SessionEpoch → LLM turn
```

A Mission expresses a user objective and workspace. A Run is an attempt to
complete that Mission under one shared budget and policy. Goals, tasks, agents,
and turns are subordinate operational state. A CLI session, SSE connection,
provider request, or daemon process is never the identity or ownership record
for a Run.

## Layers

```text
Clients (CLI, SDK, future UI)
             │
      HTTP + SSE / protocol v1
             │
       Daemon server adapter
             │
 Control plane and scheduler
             │
 Runtime coordinator, provider, tools
             │
 Workspace / recovery / context / validation / integrations
             │
       SQLite WAL event log and projections
```

The protocol package contains serializable wire contracts. The core package
contains executable domain rules. The control plane owns mutation and durable
scheduling. Runtime code is an executor bridge; it must write through the
control plane before and after side effects. Server, SDK, and CLI are adapters.

## Ownership

| Concern                                                  | Owner                                   | Why                                                         |
| -------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------- |
| Mission, Run, goals, tasks, agents, events, requirements | SQLite control plane                    | Must survive clients and executor replacement.              |
| Run execution right                                      | Renewable lease with a generation fence | Only one current executor may perform fenced mutations.     |
| Scheduling                                               | Durable continuation and wake records   | An in-memory queue cannot survive restart.                  |
| Provider/model turn                                      | Runtime coordinator                     | Replaceable execution worker.                               |
| Workspace changes                                        | Git/worktree and checkpoint services    | Requires explicit capture and restore boundaries.           |
| Context selection                                        | Context planner                         | Keeps critical state separate from opportunistic retrieval. |
| Completion decision                                      | Validation gate and control plane       | A model response alone is never proof of completion.        |
| Terminal display                                         | CLI                                     | The client can exit without changing a Run.                 |

## State and events

The control plane keeps an append-only, per-Run event sequence alongside
materialized tables. Events are an audit/reconnect stream; projections provide
efficient current-state reads. Mutating operations use a SQLite transaction so
the projection, event, command receipt, or continuation update succeeds or
fails together.

The event stream has increasing sequence numbers scoped to a Run. A client
records the last observed sequence, requests history after it, then reconnects
to SSE. Duplicate display is preferable to silently losing history, while
idempotency keys protect state-changing client commands.

## Package responsibilities

| Layer                       | Packages                        |
| --------------------------- | ------------------------------- |
| Contracts and rules         | protocol, core                  |
| Persistence and scheduling  | control-plane                   |
| Agent/provider execution    | runtime, agents                 |
| Safety and evidence         | validation, recovery, workspace |
| Context                     | context, context-format         |
| Integration boundaries      | integrations                    |
| Network and client adapters | server, sdk, apps/cli           |

The boundary checker at scripts/check-boundaries.mjs captures the most
important directionality rules. It supplements, rather than replaces, code
review for indirect dependencies and runtime coupling.

## Explicit non-goals

- The initial source tree does not claim a managed cloud control plane.
- A sandbox profile is not an OS-level isolation guarantee.
- A typed remote/hybrid backend interface is not evidence of a hosted
  execution fleet.
- An optional managed-auth interface is not a credential vault.
- A model-generated declaration is not Run completion.

For lifecycle mechanics, continue with
[Runtime](RUNTIME.md), [Long Horizon](LONG_HORIZON.md), and
[Persistence](PERSISTENCE.md).
