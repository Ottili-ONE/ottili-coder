# Changelog

This project is in its initial vNext rebuild phase. Until the first tagged
release, changes may evolve quickly; public protocol changes will be recorded
here and in the architecture decision records.

## Unreleased

### Added

- Node.js/pnpm monorepo with a versioned v1 protocol.
- Durable Mission/Run/Goal/Task/Agent model backed by SQLite WAL.
- Event journal, Run leases, command receipts, continuation scheduler, budgets,
  resource locks, requirement ledger, and completion gate.
- Provider/tool turn engine, structured recovery, Git/worktree/checkpoint
  primitives, context services, OCF/1, thin HTTP/SSE server, SDK, and CLI.
- Legacy configuration preview/import that leaves source files untouched.
- Donor provenance, security, migration, architecture, and rebuild
  documentation.

### Compatibility policy

- The v1 wire protocol is the compatibility boundary for clients.
- Additive fields are preferred. A breaking route, event, or required-field
  change requires an ADR, migration note, and a protocol-version decision.
- CLI output is human-oriented unless --json is specified.
- No compatibility is implied with Bun/OpenTUI internals or donor-private APIs.
