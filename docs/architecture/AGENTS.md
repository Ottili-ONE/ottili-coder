# Agent Graph and Supervision

## Durable topology

An Agent is a durable Run participant, not a transient model invocation. Each
Agent has a role, lifecycle, permissions, sandbox policy, optional parent,
optional Task, worktree reference, and ordered SessionEpoch references.

The control plane persists Agent records and parent-child edges. This makes
coordination inspectable after a CLI or daemon restart:

```text
Coordinator
 ├── Researcher
 ├── Implementer
 │    └── Verifier
 └── Reviewer
```

The topology records delegation; it is not a guarantee that all children run
at once. Capacity and resource policy determine admission.

## Roles

The built-in role vocabulary is coordinator, researcher, implementer, debugger,
reviewer, verifier, and specialist. Role profiles carry permission policy plus
write/deploy/independent-context capabilities.

The coordinator remains accountable for decomposition, integration, synthesis,
and escalation. A child observation is evidence, not automatic completion.
This preserves an independent verifier role and avoids forwarding a worker's
self-assessment as a verdict.

## Lifecycle

Agent states distinguish created, queued, running, waiting, suspended,
recovering, completed, failed, stopped, and closed. Closed is the terminal
graph state. A completed/failed/stopped agent retains a close/recovery edge so
history is not erased.

The agent package enforces:

- parent/child graph integrity;
- no cycle or duplicate-child relation;
- allowed lifecycle transitions;
- deterministic descendant and task-path lookup;
- capacity calculation and admission ordering.

## Mailbox and waits

AgentMailbox stores messages with delivery IDs, sequence ordering, acknowledgement
and requeue mechanics. AgentSupervisor composes the graph and mailbox into a
serializable runtime snapshot. A caller that uses this facade must persist the
snapshot atomically with its event journal; the facade intentionally does not
hide a database transaction.

waitForAgent produces a query-style state containing agent state, queued
message count, and open-child count. It does not keep an LLM call alive. A
daemon can persist the decision and register a wake condition instead.

## Session epochs

SessionEpochs are separate from Agents. A new epoch is created for a new
provider/model session, context compaction, context overflow, provider change,
or recovery. This allows the durable Agent graph to continue after a model
conversation ends or is intentionally summarized.

The runtime records epoch start/end around a coordinator turn. Consumers should
not assume the complete prompt context is stored in the event stream; context
snapshots and checkpoint metadata are separate controlled artifacts.

## Isolation

Role profiles, permission rules, resource scopes, worktrees, and sandbox
profiles are complementary:

- roles determine mission responsibility;
- permissions decide whether an action is allowed/prompted/denied;
- resource scopes prevent conflicting work;
- worktrees provide filesystem separation;
- sandbox profiles express host capability requirements.

None of these alone makes a hostile local process safe. See
[Security](SECURITY.md).
