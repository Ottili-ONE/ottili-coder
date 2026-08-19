# Ottili Coder vNext — Durable Checkpoint

## Mission

Build the independent, Node-based, open-source Ottili Coder vNext CLI, daemon,
and durable long-horizon execution runtime described in the rebuild mission.

## Current stop level

ACTIVE — `TRUE_COMPLETE` is not permitted. The local automated matrix is
green and the composition/hardening milestone below is closed, but the
Requirement Ledger still has open `UNPROVEN` entries and direct final audits
remain.

## Current milestone

M10: compose remaining isolated services (MCP/LSP, checkpoints/worktrees) into
the live runtime, decompose `store.ts`, then close provider/backend/auth,
documentation, licensing, provenance, and security gaps.

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
- Fixed the first GitHub Actions cross-platform matrix's real failures: macOS
  worktree path canonicalization through symlinked roots, Windows CRLF/
  Prettier policy, argv-only daemon spawn plus a protocol shutdown endpoint
  (Windows has no graceful signal), and Windows batch-command execution
  through a metacharacter-refusal `cmd.exe` contract (KP-019–KP-022).
- Made the durable Task Graph and Agent Graph real: schema migration 3 adds
  lease-generation/attempt/last-error and a durable agent mailbox; the
  coordinator selects its acting Agent from durable state (a delegate with
  pending work or an owned task takes the turn); `createMissionTools` gives
  the model `plan_tasks`/`complete_task`/`delegate_task`/`message_agent`/
  `add_requirement`/`record_evidence`/`record_validation`/`prove_requirement`,
  all lease-fenced (R12; `tests/integration/multi-agent-graph.test.ts`).
- Built `RunContextCompiler`: mission/goal/task/requirement state, task graph,
  agent inbox, failing validations, checkpoint summary, memory, open problems,
  Git status/diff, LSP diagnostics (injectable port), semantic search, and the
  repo map compete for one token budget through the context planner; omissions
  are a durable `context.compacted` event (KP-012;
  `tests/integration/context-composition.test.ts`).
- Wired `assessStagnation` into `RunCoordinator.reactToStagnation`: progress is
  derived from durable events only, escalation is replan → fresh agent with a
  different role → a recorded durable blocker, never automatic termination
  (R23; `tests/integration/stagnation-response.test.ts`).
- Built a real multi-provider layer: Anthropic Messages and Google Gemini
  adapters alongside OpenAI-compatible, `FailoverTurnProvider` for per-turn
  candidate failover, `createProviderRuntime`/`createTurnProvider` for
  config-driven selection (every kind but `ottili` needs only a local key),
  and jittered consecutive-failure backoff that parks the Run in
  `waiting_external` with a recorded problem instead of ending the mission
  (R22; `tests/unit/providers.test.ts`, `tests/integration/provider-recovery.test.ts`).
- Audited all 81 public `RunStore` mutators for lease fencing; fixed 11
  unfenced executor-owned writes and added generation-scoped resource locks
  (migration 4). `tests/recovery/competing-daemon-takeover.test.ts` proves 18
  writes reject a superseded lease and that a daemon killed mid-provider-call
  cannot commit stale state on wakeup (R17/KP-004).
- Made shared multi-agent Run budgets idempotent and attributable: migration 5
  adds a session-epoch-keyed `usage_entries` ledger and a partial-unique
  `cost_records.entry_key`, so a replayed turn cannot double-charge the shared
  budget (R43; `tests/integration/shared-budget.test.ts`).
- Fixed KP-025 (a 40 ms `RunScheduler` lease TTL could expire mid-turn on a
  loaded Windows CI runner even with its heartbeat running) and added
  `tests/support/fs-cleanup.ts` (`removeTempDirectory`, `maxRetries: 10`) for
  a Windows-only SQLite temp-directory `EBUSY` teardown race, applied across
  every test file with the same fragile cleanup pattern.
- Fixed KP-027: opening a fresh `SqliteDatabase` immediately after a
  `SIGKILL`ed process held the same file could fail on Windows with a
  transient `disk I/O error` (`SQLITE_IOERR_TRUNCATE`) — a real production
  daemon-restart-after-crash risk, not just a test artifact. Fixed with a
  bounded, synchronous retry in the constructor for the whole
  IOERR/BUSY/LOCKED/CANTOPEN family (ADR-016), unit tested directly against
  the CI-observed error code.
- Fixed KP-026, a real cross-platform defect the daemon-kill mission's first
  Windows CI run caught: `new URL("C:\\Users\\x")` succeeds with `protocol`
  `"c:"` (a single letter followed by `:` is syntactically a valid URL
  scheme), so a Windows absolute `--workspace` path was silently treated as an
  already-formed URI and every downstream `startsWith("file:")` check made the
  daemon fall back to its own working directory — a Run that reported success
  while acting on the wrong checkout entirely (ADR-015).
- Partially decomposed `packages/control-plane/src/store.ts` (KP-024,
  ADR-014): extracted `store/errors.ts`, `store/types.ts`,
  `store/row-helpers.ts`, and `store/mappers.ts` (18 row mappers as free
  functions of `(database, row)`). `RunStore` itself stays one class in one
  file — SQLite's `transaction()` is not reentrant and most public methods
  orchestrate several domains inside one transaction, so a further split
  risked the very fencing invariants this session proved. 3698 → 3002 lines
  in the main file, 889 lines in four focused modules; verified with zero
  behavior change by the full test matrix.
- Built the real long-horizon daemon-kill acceptance test: a bundled daemon
  against a real broken repository fixture and a deterministic BYOK-shaped
  HTTP provider plans a durable Task Graph, reproduces a failing test, is
  `SIGKILL`ed mid-mission, is resumed by a second daemon process against the
  same SQLite journal, repairs the source file on disk, re-verifies with a
  real `node --test` run, and completes only once the requirement carries
  strong evidence and an independent verifier audit (R66;
  `tests/e2e/daemon-kill-mission.test.ts`). Building it surfaced and fixed two
  real defects: a resource-scope namespacing bug that made every sandbox
  `writableRoots` entry unmatchable (every workspace write silently required
  approval), and `execute_command` swallowing stdout on failure so an agent
  could not see why a test runner failed.
- Current automated root matrix passes: lint, format, check:eol,
  check:boundaries, typecheck, unit (92), integration (33), e2e (7), recovery
  (5), build, benchmark, and package smoke.

## Open milestones

- Compose MCP/LSP and checkpoints/worktrees into the live runtime turn with
  direct evidence (KP-013/KP-015).
- Complete v2 protocol-entity API/SDK/restart roundtrips beyond approvals,
  SSE reconnect across a dropped/restarted daemon, and CLI `resume` lifecycle
  coverage (R53–R56).
- Prove local backend, remote/hybrid, Ottili adapter/BYOK, and managed-auth
  flows (R45–R49); audit legacy feature parity (R51).
- Close benchmarking, documentation, licensing, provenance, and security gaps
  (R34, R60, R61, `KP-010`).
- Re-confirm a green Ubuntu/macOS/Windows GitHub Actions matrix on the current
  HEAD (`KP-023`): the last confirmed run was on an earlier commit.

## Active implementation

No specific source edit is active in this checkpoint. Resume with the ordered
work in `NEXT_ACTIONS.md`, starting with re-confirming cross-platform CI on
HEAD.

## Active validation

Current full matrix: unit 92/92, integration 33/33, e2e 7/7, recovery 5/5;
lint/format/check:eol/check:boundaries/typecheck/build/bench/package smoke
pass. The daemon-kill acceptance test (`tests/e2e/daemon-kill-mission.test.ts`)
and the competing-daemon takeover suite
(`tests/recovery/competing-daemon-takeover.test.ts`) are the two highest-value
regressions added this session; the daemon-kill mission's first Windows CI run
also caught a real cross-platform defect (KP-026) that no other platform or
test could have found. Historic failures remain recorded in `VALIDATION_LOG.md`
as remediation provenance, not current failures.

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

- Root lint, format check, check:eol, typecheck, all test suites, boundaries,
  build, benchmark, and package smoke passed on 2026-08-19 after the
  composition/hardening milestone, the KP-024/025/026 fixes, and the partial
  `store.ts` decomposition.
- GitHub Actions run 32132026366 (commit `3f51516`) passed Ubuntu, macOS, and
  Windows; two later runs failed on real defects now fixed (KP-025, KP-026).
  Re-verification on CI for the current HEAD is still required (`KP-023`).
- A historic 10 ms TTL duplicate execution and public completion bypass were
  reproduced before remediation; details remain in `VALIDATION_LOG.md`.

## Exact resume action

Read `REQUIREMENTS.md`, `KNOWN_PROBLEMS.md`, `NEXT_ACTIONS.md`, and
`VALIDATION_LOG.md`; push and re-confirm the cross-platform CI matrix on HEAD,
then work `NEXT_ACTIONS.md` in order starting with the `store.ts`
decomposition, and rerun all final validation after the final source change.
