# Ottili Coder vNext — Durable Checkpoint

## Mission

Build the independent, Node-based, open-source Ottili Coder vNext CLI, daemon,
and durable long-horizon execution runtime described in the rebuild mission.

## Current stop level

ACTIVE — `TRUE_COMPLETE` is not permitted. The automated root matrix is green,
but the Requirement Ledger has open `UNPROVEN` entries and direct final audits
remain.

## Current milestone

M9: extend hardened control-plane evidence through real daemon boundaries and
close remaining integration/completeness requirements.

## Completed milestones

- Created a clean Git workspace independent of donor repositories; recorded
  donor boundaries, research, and port decisions.
- Established Node 24/pnpm TypeScript workspace, package boundaries, CI,
  licensing/provenance documentation, and core durable architecture.
- Implemented protocol/core state machines, SQLite control plane, scheduler,
  runtime/provider/tools, recovery/context/OCF, agents, MCP/LSP, daemon/server,
  SDK, and thin CLI boundaries.
- Remediated historic duplicate-turn and direct completion-bypass failures with
  in-flight heartbeat, durable Store revalidation, lease-aware coordinator
  writes, and focused regressions.
- Added durable history/steering replay, overflow snapshot handoff, default
  deterministic verifier, workspace-scoped locks, default-deny commands,
  symlink-safe paths, scheduler drain, approval API/SDK/CLI resolution, and v2
  entity projections/migration coverage.
- Current automated root matrix passes: lint, format, typecheck, unit,
  integration, e2e, recovery, boundaries, build, benchmark, and package smoke.

## Open milestones

- Prove lease fencing and shutdown/cancel behavior through delayed real
  provider/tool, competing-daemon, and live-SSE daemon scenarios.
- Complete durable entity/task-graph/multi-agent API and restart evidence.
- Enforce workspace permission/approval policy and settle host-isolation
  contract.
- Compose all remaining long-horizon services and close provider/backend/auth,
  benchmarking, documentation, licensing, provenance, and security gaps.

## Active implementation

No specific source edit is active in this checkpoint. Resume with the ordered
direct-validation and integration work in `NEXT_ACTIONS.md`.

## Active validation

Current focused evidence: control-plane 10/10; coordinator 4/4; daemon API and
bundled CLI lifecycle 3/3. Current full matrix: unit 67/67, integration 7/7,
e2e 6/6, recovery 1/1; lint/format/typecheck/boundaries/build/bench/package
smoke pass. Historic failures remain recorded in `VALIDATION_LOG.md` as
remediation provenance, not current failures.

## Current blockers

None. Provider credentials, managed-auth access, Claude Code source access,
and Ottili ONE platform access are not blockers: local interfaces, mocks, and
deterministic tests are viable.

## Current assumptions

- Product source is this repository, not any donor tree.
- Node 24.19.0 at `/opt/node24/bin/node` is the supported local runtime.
- SQLite is the initial persistence adapter; future adapters preserve
  event/lease/receipt semantics.
- A local or mocked provider is sufficient for implementation validation; no
  real API key belongs in repository state or logs.

## Latest important commands/results

- Root lint, format check, typecheck, all test suites, boundaries, build,
  benchmark, and package smoke passed on 2026-08-17.
- Real bundled daemon lifecycle, typed approval resolution, scheduler heartbeat
  and drain, Store completion defense, v1→v2 migration, entity projections,
  lock conflict, transcript replay, overflow handoff, and default verification
  have direct passing regressions.
- A historic 10 ms TTL duplicate execution and public completion bypass were
  reproduced before remediation; details remain in `VALIDATION_LOG.md`.

## Exact resume action

Read `REQUIREMENTS.md`, `KNOWN_PROBLEMS.md`, `NEXT_ACTIONS.md`, and
`VALIDATION_LOG.md`; first add delayed real provider/tool competing-daemon and
live-SSE shutdown/cancellation regressions, then close the remaining ledger
requirements and rerun all final validation after the final source change.
