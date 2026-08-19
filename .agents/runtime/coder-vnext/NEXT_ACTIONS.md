# Next Actions

Since the last revision, Task Graph/Agent Graph delegation, live context
composition, provider failover, stagnation response, lease-fencing hardening,
shared multi-agent budgets, the real daemon-kill acceptance test, a partial
`store.ts` decomposition, seven real cross-platform/CI defects (KP-025
through KP-031, all resolved), MCP/LSP, worktree, and checkpoint composition
into the live capability system, a workspace-only checkpoint restore flow
(CLI/API/SDK), closing R54/R56's stated coverage gaps (SSE reconnect across a
dropped/restarted daemon; explicit CLI `resume` lifecycle), and proving
R45–R49 (managed-auth token wiring, BYOK/managed provider round trips,
deleting confirmed-dead `packages/integrations/src/provider.ts`, and
deterministic remote/hybrid execution-backend contract tests) were
implemented/fixed with direct regressions
(R12/R17/R18/R22/R23/R37/R39/R40/R43/R45/R46/R47/R49/R54/R56/R66). GitHub
Actions run 32265182592 (commit `ded0e49`) confirmed Ubuntu, macOS, and
Windows all pass together, though that was before the v2 API coverage and
R45–R49 changes below — CI must be re-confirmed on the new HEAD. Continue in
this order; do not declare `TRUE_COMPLETE` while any item remains open.

1. Audit the legacy Ottili Coder feature matrix (`research/PORT_MATRIX.md`)
   against the current implementation and close R51 (useful features ported).
   Preliminary research this session found real gaps worth confirming: no
   CLI `models`/`mcp` subcommands, no Build/Plan/Debug/Ask role flags, no
   OAuth support, no GitHub Action file.
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
