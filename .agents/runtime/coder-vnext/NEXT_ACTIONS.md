# Next Actions

Since the last revision, Task Graph/Agent Graph delegation, live context
composition, provider failover, stagnation response, lease-fencing hardening,
shared multi-agent budgets, the real daemon-kill acceptance test, a partial
`store.ts` decomposition, seven real cross-platform/CI defects (KP-025
through KP-031, all resolved), MCP/LSP, worktree, and checkpoint composition
into the live capability system, and a workspace-only checkpoint restore
flow (CLI/API/SDK) were implemented/fixed with direct regressions
(R12/R17/R18/R22/R23/R37/R39/R40/R43/R66). GitHub Actions run 32263162700
(commit `916a081`) confirmed Ubuntu, macOS, and Windows all pass together,
though that was before the checkpoint-restore change below — CI must be
re-confirmed on the new HEAD. Continue in this order; do not declare
`TRUE_COMPLETE` while any item remains open.

1. Complete v2 protocol-entity API/SDK/restart roundtrips beyond approvals
   (R53–R56): full endpoint coverage, SSE reconnect across a dropped/restarted
   daemon, and explicit CLI `resume` lifecycle acceptance coverage. Reconcile
   `KP-033` (the `Checkpoint`/`CheckpointListResponse` protocol types do not
   match `CheckpointRecord`'s actual shape) alongside this.
2. Prove local backend runtime wiring end-to-end, remote/hybrid interface
   contracts, the Ottili AI adapter contract test, and managed-auth flow
   (R45–R49).
3. Audit the legacy Ottili Coder feature matrix (`research/PORT_MATRIX.md`)
   against the current implementation and close R51 (useful features ported).
   Preliminary research this session found real gaps worth confirming: no
   CLI `models`/`mcp` subcommands, no Build/Plan/Debug/Ask role flags, no
   OAuth support, no GitHub Action file.
4. Expand the OCF benchmark with representative datasets and a documented
   tokenizer strategy (R34, `KP-010`).
5. Perform fresh documentation-to-implementation (R61), dependency-license
   (R60), provenance, and security audits on the final worktree.
6. Rerun the full root matrix (`pnpm install --frozen-lockfile`, lint,
   format:check, check:eol, check:boundaries, typecheck, test, test:integration,
   test:recovery, test:e2e, build, test:package, bench) plus a re-confirmed
   green cross-platform GitHub Actions matrix after the final source change,
   then update the ledger only from that evidence before reconsidering
   `TRUE_COMPLETE`.

Also watch `KP-032` (an unreproduced one-off `LeaseFencedError` in
`multi-agent-graph.test.ts`'s restart test on an unrelated commit): if it
recurs, capture full evidence before attempting a fix rather than guessing.

A future increment could extend restore beyond workspace-only (full
point-in-time Task/Agent Graph reconstruction via event replay), but that is
a materially larger feature deliberately left out of ADR-021's scope.
