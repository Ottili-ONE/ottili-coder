# ADR 0003: Node and SQLite WAL for the Initial Control Plane

## Status

Accepted.

## Context

The target requires a portable local daemon that survives client disconnects
and restarts without mandatory Bun, OpenTUI, or an external database service.
The control plane needs transactions, leases, receipts, events, and
materialized projections.

## Decision

Use Node.js 24+ with its built-in SQLite API. Enable WAL, foreign keys, and a
busy timeout. Store durable state in normalized tables plus a per-Run
append-only event journal. Use immediate transactions for control-plane
mutations.

## Consequences

- Node 24 is a supported runtime requirement.
- A local SQLite file is operationally simple but must be placed on suitable
  storage and backed up by the deployment.
- Higher-scale/multi-region execution can use a future control-plane adapter,
  but it must preserve the same lease, event, receipt, and completion
  invariants.
- A daemon process may be restarted without throwing away Run identity.
