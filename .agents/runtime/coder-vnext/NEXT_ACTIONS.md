# Next Actions

Since the last revision, Task Graph/Agent Graph delegation, live context
composition, provider failover, stagnation response, lease-fencing hardening,
shared multi-agent budgets, the real daemon-kill acceptance test, a partial
`store.ts` decomposition, and four real cross-platform defects (KP-025
through KP-028) were implemented/fixed with direct regressions
(R12/R17/R22/R23/R43/R66). GitHub Actions run 32231877726 (commit `9a5f310`)
confirmed Ubuntu, macOS, and Windows all pass together. Continue in this
order; do not declare `TRUE_COMPLETE` while any item remains open.

1. Compose MCP and LSP into the live runtime capability/permission/approval
   system rather than leaving them isolated demos; keep default-deny and no
   dynamic binary downloads at core startup (`KP-013`, `KP-015`).
2. Compose checkpoints and worktrees into the runtime turn (create a
   checkpoint on durable milestones; use an isolated worktree for delegated
   agents where appropriate) with direct restart evidence (`KP-015`).
3. Complete v2 protocol-entity API/SDK/restart roundtrips beyond approvals
   (R53–R56): full endpoint coverage, SSE reconnect across a dropped/restarted
   daemon, and explicit CLI `resume` lifecycle acceptance coverage.
4. Prove local backend runtime wiring end-to-end, remote/hybrid interface
   contracts, the Ottili AI adapter contract test, and managed-auth flow
   (R45–R49).
5. Audit the legacy Ottili Coder feature matrix (`research/PORT_MATRIX.md`)
   against the current implementation and close R51 (useful features ported).
6. Expand the OCF benchmark with representative datasets and a documented
   tokenizer strategy (R34, `KP-010`).
7. Perform fresh documentation-to-implementation (R61), dependency-license
   (R60), provenance, and security audits on the final worktree.
8. Rerun the full root matrix (`pnpm install --frozen-lockfile`, lint,
   format:check, check:eol, check:boundaries, typecheck, test, test:integration,
   test:recovery, test:e2e, build, test:package, bench) plus a re-confirmed
   green cross-platform GitHub Actions matrix after the final source change,
   then update the ledger only from that evidence before reconsidering
   `TRUE_COMPLETE`.
