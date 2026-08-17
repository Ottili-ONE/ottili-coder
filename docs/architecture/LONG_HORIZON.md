# Long-Horizon Execution

## A Run outlives a session

Long-horizon work is not a very long chat. It is an explicit state machine
whose data is stored independently of the client:

```text
Mission
  └── Run
       ├── active Goal(s)
       ├── dependency-aware Tasks
       ├── coordinator and child Agents
       ├── SessionEpoch history
       ├── requirements, evidence, validations
       ├── checkpoints and recovery records
       └── scheduled continuations and wake conditions
```

An attach client reads event history and may subscribe to the current stream,
but it cannot become the Run owner. The client may detach, lose a network
connection, or be restarted without cancelling execution.

## Goal continuation

An active Goal is eligible for automatic continuation. The control plane
creates a durable scheduled action for a running Run and claims it only under
a valid lease. When the executor returns requeue true, the scheduler settles
the action and leaves a later continuation available.

No automatic continuation is inferred for a waiting, paused, budget-limited,
blocked, complete, or cancelled Goal. Those are intentional control states,
not missing work.

## State-machine discipline

Run, Goal, Task, and Agent transitions are enumerated in the core package.
Terminal states have no outbound edge. This prevents a caller from casually
reviving completed or cancelled work with a random database update.

Important distinctions:

| State                          | Meaning                                                          |
| ------------------------------ | ---------------------------------------------------------------- |
| paused                         | A user/policy pause; resumption is explicit.                     |
| waiting_external               | Work waits for a provider, approval, resource, or human action.  |
| recovering                     | A replacement executor is reconciling durable state.             |
| blocked                        | No meaningful alternate action remains after repeated diagnosis. |
| budget_limited / usage_limited | Shared Run capacity stopped further ordinary execution.          |
| completed                      | Only the completion gate may reach this state.                   |

Blocked status is deliberately stricter than a failed tool call. The blocker
rules require the same blocker fingerprint across meaningful attempts and
avoid treating an easily available alternate action as a terminal block.

## Shared budgets

Run budgets cover input/output/cached tokens, cost, wall time, tool calls, and
child agents. Usage belongs to the Run, not an individual SessionEpoch, so
multi-agent work cannot hide cost by restarting a worker. Budget evaluation
also reserves capacity for recovery and validation where configured.

When a ceiling is exhausted, the control plane moves to a limit state rather
than allowing a worker to keep spending. Resume is a policy decision; it is
not automatic budget bypass.

## Task and Agent topology

Tasks store dependencies, owner Agent references, requirement links, resource
scopes, result/evidence metadata, and a lifecycle. The scheduler can select
ready work without relying on the order of model messages.

Agents form a durable parent-child graph. Roles include coordinator,
researcher, implementer, debugger, reviewer, verifier, and specialist.
Role profiles constrain write/deploy/context behavior. Session epochs are
separate from Agent identities, allowing compaction, provider changes, or
crash recovery without pretending an old chat is still alive.

## Restart and handoff

On restart, a new scheduler instance opens the same SQLite database and
attempts to acquire a successor lease. It rehydrates projections, examines
claimed work, marks uncertain tool calls for recovery, and resumes only under
the new fence. The previous executor cannot commit after lease takeover.

The restart test suite covers the state/lease portion of this path. Production
operators should additionally test their provider, filesystem, daemon launcher,
and service manager in a non-production workspace.
