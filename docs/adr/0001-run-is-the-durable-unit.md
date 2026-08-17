# ADR 0001: The Run Is the Durable Unit

## Status

Accepted.

## Context

Coding tasks often outlive one terminal, browser connection, model context
window, daemon process, or agent invocation. If a session owns state, a
disconnect can appear to terminate useful work and a restart may lose
accounting, evidence, or knowledge of side effects.

## Decision

Mission and Run are stored durably. Goal, Task, Agent, SessionEpoch, evidence,
validation, event, checkpoint, lease, resource lock, command receipt, and
continuation records are attached to a Run. The CLI, SDK, and SSE connection
are adapters only.

Completion is a control-plane transition gated by requirement proof,
deterministic validations, and an independent verifier. A model response and
an Agent terminal state are insufficient by themselves.

## Consequences

- Daemon restart/reconnect behavior is a core test target.
- In-memory convenience state must be reconstructable or non-authoritative.
- Clients need stable Run IDs, event sequences, and idempotency keys.
- Runtime executors are replaceable but must use a current lease generation.
- Interactive UI cannot be the sole location of durable state.
