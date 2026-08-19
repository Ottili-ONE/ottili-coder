# Ottili Coder vNext — Durable Checkpoint

## Mission

Build the independent, Node-based, open-source Ottili Coder vNext CLI, daemon,
and durable long-horizon execution runtime described in the rebuild mission.

## Current stop level

ACTIVE — `TRUE_COMPLETE` is not permitted. The local automated matrix is
green; MCP/LSP, worktree, and checkpoint composition (creation and
workspace-only restore) are all closed with direct evidence (`KP-015`
fully resolved), `KP-031` (sandbox `writableRoots` not widening to a
delegate's worktree) is fixed (ADR-020), R54/R56's specific stated
coverage gaps (SSE reconnect across a dropped/restarted daemon; explicit
CLI `resume` lifecycle) are closed, and R45–R49 (managed-auth wiring,
BYOK/managed provider round trips, dead-code deletion, remote/hybrid
backend contracts) are now proven with direct evidence — all moved
UNPROVEN → PROVEN except R48, which stays UNPROVEN by deliberate,
documented decision (`KP-035`/ADR-022: composing `LocalExecutionBackend`
into `execute_command`'s real dispatch path needs a dependency-graph
change out of proportion to this increment). R51 (legacy feature parity)
gained real, concrete progress this pass — `ottili-coder models`/
`ottili-coder mcp` close its literal missing-CLI-surface gap, Build/Plan/
Debug/Ask is judged satisfied by the existing multi-agent redesign,
`action.yml` is a real working composite GitHub Action self-tested by a
new `action-smoke` CI job (ADR-023), now confirmed green end to end on a
real runner after finding and fixing `KP-036` (a broken
`cache-dependency-path` that the smoke test itself caught) — but stays
UNPROVEN: interactive OAuth login is the one remaining genuine, documented,
open gap. GitHub Actions run 32296536677 (commit `02a9b03`) confirmed
Ubuntu/macOS/Windows and `action-smoke` all pass together on the OCF
benchmark change itself. R34 (OCF token benchmark) is now PROVEN: three
representative dataset shapes plus a real `cl100k_base` tokenizer
comparison close `KP-010`. Investigating OCF's live-composition status for
R34 surfaced `KP-037`: `RunContextCompiler` never uses OCF's codec for its
actual output, deliberately not composed in this pass without live-model
validation (ADR-024). R60 (OSS licensing/notices) is now PROVEN: the
shipped, bundled product (`dist/apps/cli/src/main.js`,
`dist/apps/cli/src/daemon-process.js`) has zero third-party runtime
dependencies (Node built-ins only, confirmed by grepping the actual
bundle, not source), and `pnpm licenses list` against the full 150-package
devDependency tree found no copyleft license. R61 (docs match
implementation) is now PROVEN: a full claim-by-claim audit against current
source found and fixed 6 real discrepancies (README.md's missing
`checkpoints restore`; `RUNTIME.md`'s nonexistent `ProviderAdapter` type;
`RECOVERY.md` describing the uninstantiated `CheckpointService` as the
operative restore mechanism instead of the actually-live
`GitCheckpointRestorer`; `PROTOCOL.md` missing three routes and three SDK
methods) — the other seven architecture docs were checked and found
accurate. `KP-033` (the `Checkpoint` protocol type mismatch) was
reconciled alongside it. GitHub Actions run 32298325087 (commit
`856978f`) confirmed Ubuntu/macOS/Windows/`action-smoke` all pass
together on this change, including the `Checkpoint` type edit. A
provenance/security audit pass ran: `pnpm audit` found and fixed one
real, low-severity, dev-only advisory (`esbuild`, `KP-038` — now zero
vulnerabilities at every severity), and SQL-injection,
credential-logging, file-permission, and command-injection (`shell:
false` at every `spawn()` call site, verified directly) checks were
performed with no findings, fixed by bumping `esbuild` and confirmed
green on a real cross-platform matrix (run 32299228580, commit
`85b6ead`). `KP-032`
(an unexplained `LeaseFencedError` on a doc-only commit) has not
recurred on any run since it was first observed. The Requirement Ledger
still has open `UNPROVEN` entries with direct final
audits remaining — a provenance/security audit pass is next.

## Current milestone

M11: all previously-isolated capability primitives are composed into the
live runtime (MCP/LSP/worktrees/checkpoints, including workspace-only
restore), KP-031 is fixed, R54/R56's specific coverage gaps are closed,
R45–R49 (provider/backend proof) are closed with R48 explicitly and
honestly deferred, and R51's literal CLI-surface gap is closed. Build the
remaining R51 gap (a publishable GitHub Action), decompose `store.ts`
further if warranted, then close documentation, licensing, provenance,
and security gaps.

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
- Fixed KP-031 (R37, ADR-020): a delegate's worktree is granted as writable
  ephemerally, per turn, via `RunCoordinator.sandboxForTurn` — added to a
  _copy_ of the acting Agent's `sandbox.filesystem.writableRoots` used only
  for that turn's authorization checks, never persisted, and never passed to
  `createMissionTools` (so `delegate_task` cannot let the widening leak into
  a grandchild's durable sandbox). `tests/integration/worktree-composition.test.ts`
  was deliberately narrowed to grant only the primary workspace — the same
  shape the CLI's own default produces — and still passes, proving the
  automatic per-turn grant, not a broader pre-configured one, is what lets a
  delegate's write inside its own worktree succeed.
- Current automated root matrix passes: lint, format, check:eol,
  check:boundaries, typecheck, unit (97), integration (41), e2e (7), recovery
  (5), build, benchmark, and package smoke.
- Built a workspace-only `checkpoint restore` CLI/API/SDK flow (R18, ADR-021):
  `POST /v1/runs/:id/checkpoints/:checkpointId/restore` refuses (400) unless
  the Run is `paused`, refuses (404) an unknown checkpoint, refuses (501)
  when the daemon has no restorer configured, and otherwise applies the
  checkpoint's Git snapshot via `GitCheckpointRestorer`
  (`packages/runtime/src/checkpoint-restore.ts`) — always capturing an
  undoable pre-restore snapshot first — reachable through
  `client.restoreCheckpoint` and `ottili-coder checkpoints restore`.
  Deliberately scoped to files only, not a full point-in-time
  reconstruction of the durable Task/Agent Graph (that would need event
  replay and is a materially larger feature). Found and recorded KP-033 (a
  pre-existing, unrelated mismatch between the protocol's `Checkpoint` type
  and `CheckpointRecord`'s actual shape) while cross-checking the route
  against the existing GET endpoint. `tests/integration/checkpoint-restore.test.ts`
  proves refusal-while-not-paused, a real file revert with a resolvable
  pre-restore ref, refusal for an unknown checkpoint, and the 501 case.
- Current automated root matrix passes again after checkpoint restore:
  unit (97), integration (44), e2e (7), recovery (5), plus all remaining
  listed commands.
- Closed R54 and R56's specific stated coverage gaps (a route/SDK-method
  audit across all `tests/` found `ready()`/`version()`/`checkpoints()`
  had zero direct coverage each, so also closed those in passing):
  `tests/integration/sse-reconnect.test.ts` drops an SSE connection,
  restarts the daemon (a genuinely fresh Store and Server against the same
  durable journal) while durable events keep accumulating, and proves a
  reconnecting client with `after` catches up on exactly what it missed —
  no gap, no duplicate. `tests/integration/cli-daemon-lifecycle.test.ts`
  proves the explicit top-level `ottili-coder resume <run-id>` command's
  full lifecycle through a real bundled daemon process: one disposable CLI
  invocation pauses a Run, a separate one resumes it, and the daemon (not
  either client) is shown to carry the Run's state across that gap.
  `tests/integration/daemon-api.test.ts` gained direct `ready()`/
  `version()`/`checkpoints()` coverage. R53/R55 stay UNPROVEN by design —
  "full endpoint/SDK coverage" is not a bounded target the way these two
  specific gaps were.
- Current automated root matrix passes again: unit (97), integration (46),
  e2e (7), recovery (5), plus all remaining listed commands.
- Proved R45–R49 (ADR-022): retargeted R45/R47 off confirmed-dead
  `packages/integrations/src/provider.ts` (deleted, `KP-034` resolved) onto
  the real, live `provider-registry.ts` `"ottili"` mechanism, wired a real
  `ottiliAccessToken` supplier into `apps/cli/src/daemon-process.ts` (read
  fresh from `OTTILI_ACCESS_TOKEN` on every call, only when set — BYOK/local
  installs unaffected), and added full round-trip/rotation/auth-failure
  tests for both the managed and BYOK configuration-driven provider paths.
  Added full lifecycle contract tests for `LocalExecutionBackend`,
  `RemoteExecutionBackend`, and `HybridExecutionBackend` (local-preferred,
  fallback-to-remote for `execute`/`health`) closing R49. R48 stays
  deliberately UNPROVEN — composing `LocalExecutionBackend` into
  `execute_command`'s real dispatch would regress Windows/output-safety
  hardening it lacks, and porting that hardening in is blocked by the
  `integrations`→`runtime` package-boundary rule; recorded as `KP-035`,
  not worked around.
- Current automated root matrix passes again after R45–R49: unit (106),
  integration (46), e2e (7), recovery (5), plus all remaining listed
  commands.
- Audited R51 against `research/PORT_MATRIX.md`'s `PORT`-classified rows by
  direct inspection: added `ottili-coder models`/`ottili-coder mcp` (new,
  purely local, no daemon round trip), closing the literal missing-CLI-surface
  gap; exported `PROVIDER_KINDS`/`DEFAULT_KEY_VARIABLES`/`DEFAULT_ENDPOINTS`
  from `provider-registry.ts` for reuse instead of duplicating them. Judged
  Build/Plan/Debug/Ask satisfied by redesign (`AgentRole` +
  `--permission-mode` already cover the intent through vNext's multi-agent
  design). Left OAuth login genuinely open — a real gap needing a live
  external Ottili Auth service this environment cannot reach.
- Current automated root matrix passes again after `models`/`mcp`: unit
  (111), integration (46), e2e (7), recovery (5), plus all remaining listed
  commands.
- Built `action.yml` (ADR-023): a real composite GitHub Action wrapping
  `daemon start`/`run`/`run status`/`daemon stop` into a headless-Mission
  workflow step. Every `${{ inputs.* }}`/`${{ steps.*.outputs.* }}` value
  goes through `env:` before a `run:` script touches it — direct
  interpolation into shell script text is a known GitHub Actions
  script-injection vector. `.github/workflows/ci.yml` gained a second job,
  `action-smoke`, that invokes the action (`uses: ./`) against this
  repository's own checkout with no provider credentials configured, and
  asserts (via `continue-on-error` plus an outcome check) that it correctly
  reports `waiting_external` rather than hanging or failing silently —
  proving the action's plumbing without spending a real provider key.
  Closes R51's last literal, bounded gap.
- Expanded the OCF benchmark, closing R34/`KP-010` (ADR-024):
  `packages/context-format/bench/ocf-benchmark.ts` now measures three
  dataset shapes mirroring real protocol structures (a task ledger at
  20/100/500 records, a requirement ledger, an event log with a nested
  payload) instead of one synthetic shape, and reports a real
  `cl100k_base` tokenizer count (`tiktoken`, MIT-licensed,
  `packages/context-format`-only dev dependency) alongside the lexical
  `estimateTokens` fallback for every measurement. Measured
  `estimatorErrorRatio` 1.155–1.955 across all 35 comparisons — the
  lexical estimator consistently over-, never under-, counts, the safer
  direction for a budget-enforcement estimator to be wrong in.
  `docs/architecture/OCF.md` documents the strategy and fixes a real bug
  found in passing (it pointed at the wrong benchmark command). Also
  found and recorded `KP-037`: `RunContextCompiler` does not use OCF's
  codec for its actual output at all — deliberately not composed in this
  pass, since this environment has no live model access to validate
  whether a real provider parses OCF's compact/dense syntax as reliably
  as JSON on the highest-consequence payload in the system.
- Found and fixed a pre-existing (not introduced this session) markdown
  table-fragmentation defect in `KNOWN_PROBLEMS.md`: two stray
  blank-line/prose interruptions split what should be one continuous
  37-row table into three fragments, which GFM renders as literal
  pipe-separated text past the first fragment (no repeated header/divider
  row). Relocated the interrupting prose note to after the table; `grep -c
"^| KP-" ` confirms all 37 rows survived intact. `prettier --check` does
  not catch this class of defect (it does not reformat table structure).
- Closed R60 (OSS licensing/notices) with direct evidence: `grep -o 'from
"[^.][^"]*"'` against the actual bundled `dist/apps/cli/src/main.js` and
  `dist/apps/cli/src/daemon-process.js` shows every import is a Node
  built-in — the shipped product has zero third-party runtime
  dependencies (every workspace `package.json`'s `dependencies` field is
  empty). `pnpm licenses list` against the full 150-package devDependency
  tree found no copyleft license. `THIRD_PARTY_NOTICES.md`'s
  "Dependencies" section now states this directly instead of deferring to
  a future audit; RK-001 moved active → mitigated.
- Closed R61 (docs match implementation): a general-purpose agent audited
  README.md and every `docs/architecture/*.md` file against current
  source claim by claim (grep/read citation per claim, not skimmed).
  Found and fixed 6 real discrepancies — README.md's CLI list missing
  `checkpoints restore`; `RUNTIME.md` referencing a nonexistent
  `ProviderAdapter` type (real contract: `TurnProvider`); `RECOVERY.md`
  describing `CheckpointService` (confirmed uninstantiated outside its
  own file/tests) as the operative restore mechanism, rewritten to
  accurately describe both it and the actually-live workspace-only
  `GitCheckpointRestorer`; `PROTOCOL.md` missing the checkpoint-restore
  route, `GET .../agents/:agentId/events`, `POST /v1/daemon/shutdown`,
  and three SDK methods from its own description. AGENTS.md, CONTEXT.md,
  LONG_HORIZON.md, OVERVIEW.md, PERSISTENCE.md, and SECURITY.md were
  checked and found accurate.
- Performed a provenance/security audit pass: `pnpm audit` (found and
  fixed `KP-038`, an `esbuild` dev-only advisory, now zero
  vulnerabilities), a direct read of every SQL template literal with
  `${...}` interpolation in the control plane (one instance, confirmed
  parameterized-values-only, no injection risk), a direct check of every
  `spawn()` call site's `shell` option (all four `shell: false`), and a
  check for credential logging in provider/daemon code plus a direct
  read of the daemon token descriptor's write path (`0o600` inside
  `0o700`, atomic temp-then-rename). No new findings beyond `KP-038`,
  which is resolved.

## Open milestones

- Continue narrowing R53/R55 (full server-API/SDK error-path coverage)
  opportunistically; not a bounded, discrete task the way R54/R56 were.
- Resolve `KP-035` (compose `LocalExecutionBackend` into `execute_command`'s
  real dispatch path) as its own scoped increment, likely alongside
  `KP-024`'s `store.ts` module-boundary cleanup, once a dependency-graph
  decision is made.
- Resolve `KP-037` (compose OCF into `RunContextCompiler`'s live output) —
  needs live-model validation this environment cannot perform, or a
  conservative first step with an explicit before/after comparison; not a
  blind swap.
- Close benchmarking, documentation, licensing, provenance, and security gaps
  (R34, R60, R61, `KP-010`).
- Re-confirm a green Ubuntu/macOS/Windows GitHub Actions matrix on the current
  HEAD (`KP-023`): the last confirmed run was on an earlier commit.

## Active implementation

No specific source edit is active in this checkpoint. The OCF benchmark
expansion (R34) is committed and locally validated (full local matrix
green; benchmark itself re-run twice with identical results). Resume with
the ordered work in `NEXT_ACTIONS.md`, starting with pushing this change
and re-confirming cross-platform CI on the new HEAD.

## Active validation

Current full matrix: unit 111/111, integration 46/46, e2e 7/7, recovery
5/5; lint/format/check:eol/check:boundaries/typecheck/build/bench/package
smoke pass, all re-run after the OCF benchmark expansion (no product source
package changed, so counts are unchanged from the `action.yml` pass).
`pnpm --filter @ottili/context-format run bench` itself was run twice with
identical results (35 measurements, `estimatorErrorRatio` 1.155–1.955, 0
below 1.0) — the actual reproducible evidence R34/`KP-010` needed, not
just passing typecheck. The daemon-kill
acceptance test (`tests/e2e/daemon-kill-mission.test.ts`), the
competing-daemon takeover suite
(`tests/recovery/competing-daemon-takeover.test.ts`),
`tests/integration/mcp-lsp-composition.test.ts`,
`tests/integration/worktree-composition.test.ts`,
`tests/integration/checkpoint-composition.test.ts`,
`tests/integration/checkpoint-restore.test.ts`,
`tests/integration/sse-reconnect.test.ts`,
`tests/integration/cli-daemon-lifecycle.test.ts`,
`tests/unit/providers.test.ts`, and `tests/unit/integrations.test.ts` are
unchanged and still pass. New this pass: `tests/unit/cli.test.ts` gained 7
tests (`models` credential/selection report in both text and JSON forms;
`mcp` configured-server report, empty-configuration case, and a
malformed-JSON usage-error case) — also manually smoke-tested against the
real built binary (`node dist/apps/cli/src/main.js models`/`mcp`). The
daemon-kill mission's first Windows CI run also caught a real
cross-platform defect (KP-026) that no other platform or test could have
found. Historic failures remain recorded in `VALIDATION_LOG.md` as
remediation provenance, not current failures. Cross-platform CI itself is
not yet re-confirmed on this HEAD.

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

- Root lint, typecheck, boundaries, all test suites, build, and package
  smoke passed on 2026-08-19 after bumping `esbuild` `^0.27.0` ->
  `^0.28.2` for `KP-038` (unit 111/111, integration 46/46, e2e 7/7,
  recovery 5/5); `pnpm audit` confirms zero vulnerabilities — not yet
  pushed/re-confirmed on GitHub Actions as of this checkpoint.
- GitHub Actions run 32298325087 (commit `856978f`, 2026-08-19) confirmed
  Ubuntu, macOS, Windows, and `action-smoke` all pass together on the
  R61/`KP-033` change.
- GitHub Actions run 32297161682 (commit `476a027`, 2026-08-19) confirmed
  Ubuntu, macOS, Windows, and `action-smoke` all pass together on the R60
  closure. The R61 documentation fix (README.md,
  `docs/architecture/{RUNTIME,RECOVERY,PROTOCOL}.md`) is doc-only —
  `pnpm run format:check`/`check:eol`/`lint`/`typecheck` all PASS locally;
  not yet pushed/re-confirmed on GitHub Actions as of this checkpoint.
- Root lint, format check, check:eol, typecheck, all test suites, boundaries,
  build, benchmark, and package smoke passed on 2026-08-19 after expanding
  the OCF benchmark for R34/`KP-010` (unit 111/111, integration 46/46, e2e
  7/7, recovery 5/5).
- GitHub Actions run 32294770672 (commit `d44a583`, 2026-08-19) confirmed
  Ubuntu, macOS, Windows, _and_ the new `action-smoke` job all pass
  together. The job log shows `action.yml` ran its full real sequence:
  built the daemon/CLI, started the daemon, created Run
  `run_105rwz9p9mqqd`, polled it, correctly detected and reported
  `waiting_external` (no provider credentials configured), and stopped
  the daemon. The immediately preceding commit (`b7d42bf`, `action.yml`'s
  introduction) failed `action-smoke` on its first real run: fixed as
  `KP-036` (see below).
- GitHub Actions run 32294498714 (commit `b7d42bf`, 2026-08-19): `validate`
  passed on all three platforms, but `action-smoke` failed at the
  `setup-node` step — `cache-dependency-path` resolved to a path with a
  literal `.` segment for the self-referential `uses: ./` case this job
  exercises, which `setup-node` explicitly rejects. Found directly in the
  job log. Fixed in `d44a583` by dropping the pnpm cache from that step
  entirely (`KP-036`).
- Root lint, format check, check:eol, typecheck, all test suites, boundaries,
  build, benchmark, and package smoke passed on 2026-08-19 after adding
  `ottili-coder models`/`ottili-coder mcp` (unit 111/111, integration 46/46,
  e2e 7/7, recovery 5/5).
- GitHub Actions run 32270519687 (commit `d299614`, 2026-08-19) confirmed
  Ubuntu, macOS, and Windows all pass together on the `models`/`mcp` CLI
  addition.
- GitHub Actions run 32269711392 (commit `e9d66c9`, 2026-08-19) confirmed
  Ubuntu, macOS, and Windows all pass together (doc-only CI-confirmation
  commit).
- GitHub Actions run 32269246053 (commit `e5ce78e`, 2026-08-19) confirmed
  Ubuntu, macOS, and Windows all pass together on the R45–R49 change. The
  immediately preceding commit (`205d5da`, the R45–R49 source change itself)
  failed `format:check` on Ubuntu/macOS: three WUID docs edited via a python
  workaround for the Edit tool's whitespace-matching on padded markdown
  tables were never run through Prettier before committing. Fixed with
  `prettier --write` (pure formatting, zero content change) in `e5ce78e`.
- Root lint, format check, check:eol, typecheck, all test suites, boundaries,
  build, benchmark, and package smoke passed on 2026-08-19 after proving
  R45–R49 and deleting confirmed-dead `packages/integrations/src/provider.ts`
  (unit 106/106, integration 46/46, e2e 7/7, recovery 5/5).
- Root lint, format check, check:eol, typecheck, all test suites, boundaries,
  build, benchmark, and package smoke passed on 2026-08-19 after closing
  R54/R56's coverage gaps (unit 97/97, integration 46/46, e2e 7/7,
  recovery 5/5).
- Root lint, format check, check:eol, typecheck, all test suites, boundaries,
  build, benchmark, and package smoke passed on 2026-08-19 after adding
  checkpoint restore (unit 97/97, integration 44/44, e2e 7/7, recovery
  5/5).
- Root lint, format check, check:eol, typecheck, all test suites, boundaries,
  build, benchmark, and package smoke passed on 2026-08-19 after fixing
  KP-031 (unit 97/97, integration 41/41, e2e 7/7, recovery 5/5).
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

Commit and push the security audit's one real finding (the `esbuild`
version bump, `KP-038`), re-confirm cross-platform CI on the new HEAD.
With R34/R45/R46/R47/R49/R51/R60/R61 all closed this session and only
`KP-024`/`KP-032`/`KP-037` (each individually deliberate/monitored, not
neglected) plus R48/R53/R55's intentionally-unbounded scope remaining,
the next step is a genuinely full root-matrix-plus-cross-platform-CI
re-confirmation on the final HEAD before reconsidering `TRUE_COMPLETE` —
not a new feature increment.
