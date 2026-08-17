# Ottili Coder vNext Rebuild Report

## Scope and stop level

This is the implementation record for the initial from-scratch vNext rebuild.
It records the repository state rather than declaring a release or production
certification. The final engineering stop level and exact validation output
belong in .agents/runtime/coder-vnext/VALIDATION_LOG.md once the full suite
has been run on the completed worktree.

## Architecture

Ottili Coder treats a durable Run as the owner of work:

```text
Mission → Run → Goal / Task graph / Agent graph → Session epoch → LLM turn
```

The daemon-facing control plane stores an append-only event journal alongside
normalized SQLite projections. A scheduler acquires a renewable, monotonic
lease for each Run. Fenced writes, durable command receipts, and scheduled
continuations make an executor replaceable. Clients communicate through
versioned HTTP and sequenced SSE; they do not own the Run.

See [architecture overview](docs/architecture/OVERVIEW.md) and
[persistence](docs/architecture/PERSISTENCE.md).

## Package layout

| Package                 | Delivered role                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| protocol, core          | Public DTOs and executable domain rules.                                                       |
| control-plane           | SQLite migrations, events/projections, leases, scheduling, budgets, locks, and ledger records. |
| runtime                 | Provider/tool turn loop and durable coordinator bridge.                                        |
| agents, validation      | Agent graph/mailbox primitives; requirement/evidence/completion policy.                        |
| recovery, workspace     | Transactional checkpoint flow, tool recovery, Git snapshots, worktrees, and sandbox profiles.  |
| context, context-format | RepoMap, lexical semantic search, memory, planner, OCF/1 and deltas.                           |
| server, sdk, apps/cli   | Typed HTTP/SSE adapter, client, and disposable command-line interface.                         |
| integrations            | Provider, MCP, execution backend, managed-auth boundary, and config import.                    |

## Long-horizon proof surface

The tests in this repository exercise the following behaviors:

| Behavior                                                                              | Evidence location                                                       |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Durable Run creation and automatic continuation scheduling                            | tests/unit/control-plane.test.ts                                        |
| Lease takeover and stale-writer rejection                                             | tests/unit/control-plane.test.ts; tests/recovery/daemon-restart.test.ts |
| Rehydrate state after SQLite/daemon restart                                           | tests/recovery/daemon-restart.test.ts                                   |
| HTTP creation, idempotent command retry, and SSE sequence reconnect                   | tests/integration/daemon-api.test.ts                                    |
| Model/tool turn through the scheduler and gated completion                            | tests/integration/runtime-coordinator.test.ts                           |
| Checkpoint capture including untracked files and transactional rollback               | tests/unit/workspace-recovery.test.ts                                   |
| Requirement proof, deterministic validation, independent verification, and stagnation | tests/unit/validation.test.ts; tests/unit/control-plane.test.ts         |
| OCF round trips and base-checked delta application                                    | tests/unit/context-format.test.ts                                       |

These tests prove focused behavior, not an unconditional guarantee about every
provider, filesystem, operating system, or external tool.

## Donor use and code provenance

All donor pins, licenses, audit roles, and copy boundaries are in
[docs/donors/DONOR_LOCK.md](docs/donors/DONOR_LOCK.md) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The product was independently
implemented after research. No Claude Code snapshot source was copied. Donor
repositories are not embedded in this Git tree.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:recovery
pnpm build
pnpm bench
pnpm doctor
```

VALIDATION_LOG.md is the authoritative place for dated command output and
benchmark measurements. Do not infer a passing result merely because a command
is listed here.

## Feature matrix

| Capability                                              | Initial implementation status                                                     |
| ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Durable Run, event journal, leases, command idempotency | Implemented as control-plane services.                                            |
| Daemon HTTP/SSE and TypeScript client                   | Implemented with a bundled local daemon entrypoint and thin server/SDK libraries. |
| Provider/tool loop and structured retry                 | Implemented through provider and runtime boundaries.                              |
| Requirement/completion gate                             | Implemented; an independent verifier must be configured to complete.              |
| Git/worktree/checkpoint recovery                        | Implemented as composable workspace/recovery services.                            |
| RepoMap, lexical semantic index, memory, planner, OCF   | Implemented and unit tested.                                                      |
| Local backend / remote-hybrid contracts                 | Local command backend plus typed remote/hybrid interfaces.                        |
| MCP and LSP                                             | Declarative configuration and supervised JSON-RPC/LSP stdio transports.           |
| Managed auth and cloud product                          | Integration boundaries or future work; not claimed as completed end-user systems. |

## Known limitations

- The local backend and sandbox profile are not a substitute for host-level
  isolation.
- The bundled local daemon is not a managed installer, multi-user service, or
  cloud control plane.
- Semantic retrieval is lexical/vector-ready; it does not bundle embeddings.
- Managed OAuth is not complete in the current source tree. LSP server
  binaries remain an explicit deployment choice.

## Migration

The legacy config importer is preview-first and non-destructive. It copies
recognized JSON to ~/.ottili/coder/config.json or .ottili/coder.json; it never
deletes the original. See [MIGRATION.md](MIGRATION.md).
