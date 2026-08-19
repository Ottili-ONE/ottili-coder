# Next Actions

Since the last revision, Task Graph/Agent Graph delegation, live context
composition, provider failover, stagnation response, lease-fencing hardening,
shared multi-agent budgets, the real daemon-kill acceptance test, a partial
`store.ts` decomposition, seven real cross-platform/CI defects (KP-025
through KP-031, all resolved), MCP/LSP, worktree, and checkpoint composition
into the live capability system, a workspace-only checkpoint restore flow
(CLI/API/SDK), closing R54/R56's stated coverage gaps (SSE reconnect across a
dropped/restarted daemon; explicit CLI `resume` lifecycle), proving R45–R49
(managed-auth token wiring, BYOK/managed provider round trips, deleting
confirmed-dead `packages/integrations/src/provider.ts`, and deterministic
remote/hybrid execution-backend contract tests), and auditing R51 (adding the
literal missing `ottili-coder models`/`ottili-coder mcp` CLI surface; judging
Build/Plan/Debug/Ask satisfied by the existing `AgentRole`/`--permission-mode`
redesign; building `action.yml`, a real composite GitHub Action wrapping the
headless Run API, self-tested by a new `action-smoke` CI job — including
finding and fixing `KP-036`, a real defect the smoke test's own first run
caught; recording OAuth login as the one genuinely open R51 gap; and
expanding the OCF benchmark to three representative dataset shapes plus a
real `cl100k_base` tokenizer comparison, closing R34/`KP-010` and finding
`KP-037` (OCF is not composed into `RunContextCompiler`'s live output,
deliberately not attempted without live-model validation) — were
implemented/fixed with direct regressions
(R12/R17/R18/R22/R23/R34/R37/R39/R40/R43/R45/R46/R47/R49/R54/R56/R66).
GitHub Actions run 32294770672 (commit `d44a583`) confirmed Ubuntu, macOS,
Windows, and the new `action-smoke` job all pass together, though that
predates the OCF benchmark change below — CI must be re-confirmed on the
new HEAD. Continue in this order; do not declare `TRUE_COMPLETE` while any
item remains open.

1. Perform fresh documentation-to-implementation (R61), dependency-license
   (R60), provenance, and security audits on the final worktree. Reconcile
   `KP-033` (the `Checkpoint`/`CheckpointListResponse` protocol types do not
   match `CheckpointRecord`'s actual shape) alongside R61. R61 should also
   check that the `docs/architecture/*.md` files `README.md` links to
   actually match current implementation — `docs/architecture/OCF.md` was
   found to reference the wrong benchmark command while closing R34, a
   small but real instance of exactly the drift R61 exists to catch.
2. Rerun the full root matrix (`pnpm install --frozen-lockfile`, lint,
   format:check, check:eol, check:boundaries, typecheck, test, test:integration,
   test:recovery, test:e2e, build, test:package, bench) plus a re-confirmed
   green cross-platform GitHub Actions matrix (including `action-smoke`)
   after the final source change, then update the ledger only from that
   evidence before reconsidering `TRUE_COMPLETE`.

`KP-037` (OCF not composed into `RunContextCompiler`'s live output) needs
either live-model access to validate whether a real provider parses OCF's
compact/dense syntax as reliably as JSON on the highest-consequence payload
in the system, or a conservative first step (the `readable` profile only,
on one low-stakes context section) with an explicit before/after
mission-outcome comparison — not a blind swap. Not a scheduled action item
until one of those is possible.

R51's one remaining gap — interactive Ottili-Auth OAuth login — needs a live
external Ottili Auth service this environment cannot reach; leave it
explicitly open rather than attempting a fake/local stand-in. Not a
scheduled action item until that access exists.

R48 stays deliberately UNPROVEN (see `KP-035`/ADR-022): composing
`LocalExecutionBackend` into `execute_command`'s real dispatch path needs a
dependency-graph decision (a shared low-level process-exec package so
`packages/integrations` can reach the same Windows/output-safety hardening
`packages/runtime/src/command-target.ts` already has) that is disproportionate
to bolt onto R45–R49's closure. Pick this up as its own scoped increment,
ideally alongside `KP-024`'s `store.ts` module-boundary cleanup rather than
in isolation.

R53/R55 remain UNPROVEN by design: "full endpoint/error coverage across
every route" and "full SDK surface coverage" are not bounded targets the
way a specific gap (R54/R56, now closed) is. Keep narrowing them
opportunistically rather than treating either as a discrete task to finish.

Also watch `KP-032` (an unreproduced one-off `LeaseFencedError` in
`multi-agent-graph.test.ts`'s restart test on an unrelated commit): if it
recurs, capture full evidence before attempting a fix rather than guessing.

A future increment could extend checkpoint restore beyond workspace-only
(full point-in-time Task/Agent Graph reconstruction via event replay), but
that is a materially larger feature deliberately left out of ADR-021's
scope.
