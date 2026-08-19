# Ottili Coder vNext — Durable Checkpoint

## Mission

Build the independent, Node-based, open-source Ottili Coder vNext CLI, daemon,
and durable long-horizon execution runtime described in the rebuild mission.

## Current stop level

ACTIVE — `TRUE_COMPLETE` is not permitted. The local automated matrix is
green; MCP/LSP, worktree, and checkpoint composition are all closed with
direct evidence (`KP-015` fully resolved), and GitHub Actions run
32261784514 (commit `5609b69`) confirmed Ubuntu/macOS/Windows all pass
together on the checkpoint composition change. An intervening doc-only
commit (`9a43323`, zero source changes) failed once on Ubuntu with an
unexplained `LeaseFencedError` in an unrelated pre-existing test
(`multi-agent-graph.test.ts`'s restart test); it did not reproduce on the
very next run and is recorded as `KP-032`, open/monitoring rather than
fixed on a guess. The Requirement Ledger still has open `UNPROVEN` entries
with direct final audits remaining.

## Current milestone

M11: all previously-isolated capability primitives are now composed into the
live runtime (MCP/LSP/worktrees/checkpoints). Close KP-031, build checkpoint
restore orchestration, decompose `store.ts` further if warranted, then close
provider/backend/auth, documentation, licensing, provenance, and security
gaps.

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
  daemon-restart-after-crash risk, not just a test artifact. The first fix
  (retry the open only) failed identically on the next CI run: the IOERR came
  from the WAL-mode pragma immediately _after_ a successful open. The revised
  fix retries the _entire_ initialization sequence — open, pragmas, migration
  — as one unit (ADR-016), unit tested directly against the CI-observed error
  code and against errors that must not be masked.
- Proactively audited every `new URL(...)` call site in the product source for
  the same drive-letter-as-URL-scheme pattern (ADR-015) and fixed KP-028:
  `packages/integrations/src/lsp.ts`'s `assertAbsoluteUri` accepted a Windows
  path as a valid `rootUri`/workspace-folder URI. LSP is not yet composed into
  the live runtime, so this had no current production path, but would have
  broken silently the moment it was wired up on Windows.
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
- Composed MCP and LSP into the live runtime capability/permission/approval
  system rather than leaving them isolated demos (R39/R40, KP-013/KP-015):
  `createMcpTools` (`packages/runtime/src/mcp-tools.ts`) turns each connected
  MCP server's declared tools into durable `ToolDefinition`s carrying MCP's
  conservative default policy and routes every call through the coordinator's
  existing `authorizeTool`/lease/resource-lock pipeline; `LspServerManager`
  (`packages/runtime/src/lsp-tools.ts`) implements the `DiagnosticsProvider`
  context port and exposes read-only, unapproved `lsp_diagnostics`/
  `lsp_document_symbols`/`lsp_definition` tools. Both compose into the daemon
  behind opt-in, declarative-only env config (`OTTILI_MCP_SERVERS`,
  `OTTILI_LSP_SERVERS`) with no dynamic binary download at startup;
  `RunCoordinator`'s `WorkspaceToolResolver` widened to allow an async tool
  factory. `tests/integration/mcp-lsp-composition.test.ts` proves a default
  sandbox denies an MCP call outright (network disabled), an explicit
  network-enabled sandbox gates the same call behind a durable approval that
  then executes and locks under the tool's declared resource scope, and a
  read-only LSP tool executes unapproved with its diagnostics feeding the
  _next_ turn's compiled context (ADR-017).
- Fixed KP-029 (a test-only, not product, Windows `file://` URI defect in the
  new MCP/LSP composition tests — raw string concatenation instead of
  `pathToFileURL`) and KP-030 (a second short-lease-TTL CI flake on Ubuntu,
  same class as KP-025, in `competing-daemon-takeover.test.ts`) surfaced by
  GitHub Actions after the MCP/LSP composition commit; confirmed a fresh
  green Ubuntu/macOS/Windows matrix (run 32256548228) afterward.
- Composed isolated Git worktrees for delegated agents into the live runtime
  turn (R37, ADR-018, narrowing KP-015 to checkpoints only): `RunCoordinator`
  gains an optional `worktrees` port; `ensureAgentWorktree` provisions one
  lazily on a delegate's first turn via `GitWorktreeProvisioner`
  (`packages/runtime/src/worktrees.ts`, a sibling of the primary workspace,
  detached at HEAD), records it durably and settable-once through the new
  lease-fenced `RunStore.setAgentWorktree`, and scopes that turn's tools and
  compiled context to it — the coordinator itself always keeps the shared
  workspace. `tests/integration/worktree-composition.test.ts` proves both
  directions of the isolation, durable restart reuse of the same worktree and
  its prior contents using a genuinely fresh Store/Coordinator/Provisioner
  instance, and that provisioning is opt-in/best-effort. Found and recorded
  KP-031 (a pre-configured sandbox does not automatically widen to cover a
  dynamically-provisioned worktree path) as a real, undecided follow-up
  rather than working around it silently.
- Composed checkpoints into the live runtime turn, closing KP-015 fully
  (R18, ADR-019): `RunCoordinator.createMilestoneCheckpoint` (opt-in via
  `checkpointOnTaskCompletion`, on by default in the daemon) captures a real
  Git snapshot ref plus a durable graph-state manifest every time a
  `complete_task` call succeeds, writing through the existing
  `RunStore.createCheckpoint`/`checkpoints` list API/SDK/CLI surface that
  previously had no callers at all (`ottili-coder checkpoints list` always
  returned empty regardless of Run progress). Best-effort: a non-Git
  workspace or any failure is a durable event, never a blocked Run.
  `tests/integration/checkpoint-composition.test.ts` proves the captured ref
  is a real, resolvable Git object, the manifest carries real task/agent/
  requirement state, and the feature degrades gracefully when off or the
  workspace isn't a Git repository. Restore orchestration (pause/apply/
  resume) was deliberately left out of this increment — `CheckpointService`
  itself already has full create/restore/rollback semantics
  (`packages/recovery`, `tests/unit/workspace-recovery.test.ts`), but no
  CLI/API surface calls it yet.
- Current automated root matrix passes: lint, format, check:eol,
  check:boundaries, typecheck, unit (97), integration (41), e2e (7), recovery
  (5), build, benchmark, and package smoke.

## Open milestones

- Build a `checkpoint restore` CLI/API/SDK flow atop the now-composed
  `CheckpointService`, with direct restart evidence.
- Decide and implement (or explicitly document) a fix for KP-031.
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

No specific source edit is active in this checkpoint. Checkpoint composition
(the top item in the prior `NEXT_ACTIONS.md`) is committed and locally
validated. Resume with the ordered work in `NEXT_ACTIONS.md`, starting with
pushing this change and re-confirming cross-platform CI on the new HEAD.

## Active validation

Current full matrix: unit 97/97, integration 41/41, e2e 7/7, recovery 5/5;
lint/format/check:eol/check:boundaries/typecheck/build/bench/package smoke
pass, all re-run after the checkpoint composition change. The daemon-kill
acceptance test (`tests/e2e/daemon-kill-mission.test.ts`), the competing-daemon
takeover suite (`tests/recovery/competing-daemon-takeover.test.ts`),
`tests/integration/mcp-lsp-composition.test.ts`,
`tests/integration/worktree-composition.test.ts`, and now
`tests/integration/checkpoint-composition.test.ts` (real resolvable Git ref,
real manifest state, graceful degradation off/no-Git-repo) are the
highest-value regressions added this session. The daemon-kill mission's
first Windows CI run also caught a real cross-platform defect (KP-026) that
no other platform or test could have
found. Historic failures remain recorded in `VALIDATION_LOG.md` as
remediation provenance, not current failures. Cross-platform CI itself is not
yet re-confirmed on this HEAD.

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
  build, benchmark, and package smoke passed on 2026-08-19 after composing
  checkpoints into the live runtime (unit 97/97, integration 41/41, e2e 7/7,
  recovery 5/5).
- GitHub Actions run 32261784514 (commit `5609b69`, 2026-08-19) passed
  Ubuntu, macOS, and Windows together on the checkpoint composition change.
  The immediately preceding doc-only commit (`9a43323`) failed once on
  Ubuntu with a `LeaseFencedError` in an unrelated, pre-existing test
  (`multi-agent-graph.test.ts`'s restart test) that did not reproduce on
  this run — recorded as `KP-032`, open/monitoring, not fixed on a guess.
- Root lint, format check, check:eol, typecheck, all test suites, boundaries,
  build, benchmark, and package smoke passed on 2026-08-19 after composing
  isolated worktrees for delegated agents into the live runtime (unit 97/97,
  integration 38/38, e2e 7/7, recovery 5/5).
- GitHub Actions run 32256548228 (commit `afa6ce0`, 2026-08-19) passed
  Ubuntu, macOS, and Windows together after fixing KP-029 (a Windows
  `file://` URI defect in the new MCP/LSP composition tests, not the
  product) and KP-030 (a second short-lease-TTL CI flake on Ubuntu, same
  class as KP-025).
- GitHub Actions run 32260314723 (commit `0157a78`, 2026-08-19) passed
  Ubuntu, macOS, and Windows together on the worktree composition change,
  after KP-031: the worktree test's own `sandbox.writableRoots` was built
  from a raw, uncanonicalized temp path while `GitWorktreeProvisioner`
  always reports Git's canonical path, silently denying the delegate's
  write on macOS/Windows (same class as ADR-009/KP-019/KP-029). One
  speculative fix (explicit `mkdir`) did not address it; root-causing it
  directly via stronger test diagnostics did.
- Root lint, format check, check:eol, typecheck, all test suites, boundaries,
  build, benchmark, and package smoke passed on 2026-08-19 after the
  composition/hardening milestone, the KP-024/025/026 fixes, and the partial
  `store.ts` decomposition.
- GitHub Actions run 32231877726 (commit `9a5f310`, 2026-08-19) passed
  Ubuntu, macOS, and Windows together — the first confirmed full
  cross-platform pass since the composition/hardening milestone began.
  Getting there from run 32132026366 (commit `3f51516`) took five more CI
  round-trips, each surfacing one real, previously-undetected defect
  (KP-025 lease TTL/Windows `EBUSY`, KP-026 a Windows drive-letter path
  misread as a URL scheme, KP-027 a transient SQLite `IOERR` right after a
  killed process released its file handle, KP-028 the same drive-letter
  defect in LSP config validation). `KP-023` is resolved but must be
  re-confirmed on every subsequent substantive change.
- A historic 10 ms TTL duplicate execution and public completion bypass were
  reproduced before remediation; details remain in `VALIDATION_LOG.md`.

## Exact resume action

Checkpoint composition is committed, pushed, and cross-platform CI is
confirmed green (run 32261784514). Work `NEXT_ACTIONS.md` in order starting
with deciding a fix for `KP-031`, and rerun all final validation after the
final source change.
