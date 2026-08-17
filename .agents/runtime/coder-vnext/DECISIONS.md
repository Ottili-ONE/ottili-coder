# Architecture Decisions

## ADR-001 — Durable Run is the primary execution unit

**Decision:** The hierarchy is Mission → Run → Goal / Task Graph / Agent Graph
→ Agent → SessionEpoch → LLM turn. The daemon, not any client or model turn,
owns durable Run state.

**Why:** It permits disconnect, restart, compaction, recovery, and executor
takeover without confusing a conversation with the actual engineering mission.

## ADR-002 — Node 24 plus pnpm, strict TypeScript

**Decision:** Build an ESM TypeScript pnpm workspace targeting Node 24.19.0.

**Why:** The product must eliminate Bun/OpenTUI coupling. Node 24 supplies a
supported SQLite API locally without assuming native build tooling.

## ADR-003 — SQLite event log with normalized projections

**Decision:** The control plane will use SQLite WAL, migrations, transactional
event append, and typed materialized tables rather than a single JSON state
document.

**Why:** Append-only events make recovery/audit possible while projections keep
normal read paths fast and typed.

## ADR-004 — Loopback HTTP + SSE protocol

**Decision:** The daemon exposes a versioned local HTTP API and persisted SSE
stream. CLI and SDK consume that protocol only.

**Why:** It cleanly separates clients from execution and supports reconnect via
persisted event sequence IDs. Non-loopback operation will require auth.

## ADR-005 — Donor provenance is selective and explicit

**Decision:** Donors are research material; no donor repository or Git history
will be embedded. The Claude Code archive is concept-only and source reuse is
forbidden.

**Why:** Ottili Coder must be an independent Apache-2.0 product with accurate
attribution and maintainable architecture.
