# Architecture Decision Records

ADRs record durable decisions that affect compatibility, safety, or source
provenance. New records use a zero-padded sequence and should state context,
decision, consequences, and migration impact.

| ADR                                                | Decision                                                             |
| -------------------------------------------------- | -------------------------------------------------------------------- |
| [0001](0001-run-is-the-durable-unit.md)            | The Run, not a session/client, owns execution.                       |
| [0002](0002-independent-rebuild-and-provenance.md) | Research donors inform design; copying is explicit and attributable. |
| [0003](0003-node-sqlite-control-plane.md)          | Use Node and SQLite WAL for the initial durable control plane.       |
