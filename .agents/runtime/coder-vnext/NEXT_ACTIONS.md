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
redesign; recording OAuth login and a publishable GitHub Action as genuinely
open, not fake-closed) were implemented/fixed with direct regressions
(R12/R17/R18/R22/R23/R37/R39/R40/R43/R45/R46/R47/R49/R54/R56/R66). GitHub
Actions run 32269711392 (commit `e9d66c9`) confirmed Ubuntu, macOS, and
Windows all pass together, though that predates the `models`/`mcp` CLI
addition below — CI must be re-confirmed on the new HEAD. Continue in this
order; do not declare `TRUE_COMPLETE` while any item remains open.

1. Build a publishable GitHub Action wrapping the headless Run API (R51's
   remaining concrete gap) — a real, bounded increment, not started.
   Interactive Ottili-Auth OAuth login is a separate, larger gap that needs a
   live external Ottili Auth service this environment cannot reach; leave it
   explicitly open rather than attempting a fake/local stand-in.
2. Expand the OCF benchmark with representative datasets and a documented
   tokenizer strategy (R34, `KP-010`).
3. Perform fresh documentation-to-implementation (R61), dependency-license
   (R60), provenance, and security audits on the final worktree. Reconcile
   `KP-033` (the `Checkpoint`/`CheckpointListResponse` protocol types do not
   match `CheckpointRecord`'s actual shape) alongside R61.
4. Rerun the full root matrix (`pnpm install --frozen-lockfile`, lint,
   format:check, check:eol, check:boundaries, typecheck, test, test:integration,
   test:recovery, test:e2e, build, test:package, bench) plus a re-confirmed
   green cross-platform GitHub Actions matrix after the final source change,
   then update the ledger only from that evidence before reconsidering
   `TRUE_COMPLETE`.

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
