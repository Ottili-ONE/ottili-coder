# Next Actions

Since the last revision, Task Graph/Agent Graph delegation, live context
composition, provider failover, stagnation response, lease-fencing hardening,
shared multi-agent budgets, the real daemon-kill acceptance test, a partial
`store.ts` decomposition, four real cross-platform defects (KP-025 through
KP-028), and MCP/LSP composition into the live capability/permission/approval
system were implemented/fixed with direct regressions
(R12/R17/R22/R23/R39/R40/R43/R66). GitHub Actions run 32231877726 (commit
`9a5f310`) confirmed Ubuntu, macOS, and Windows all pass together, though that
was before the MCP/LSP composition change below — CI must be re-confirmed on
the new HEAD. Continue in this order; do not declare `TRUE_COMPLETE` while any
item remains open.

1. Compose checkpoints and worktrees into the runtime turn (create a
   checkpoint on durable milestones; use an isolated worktree for delegated
   agents where appropriate) with direct restart evidence (`KP-015`, now
   narrowed to checkpoints/worktrees only — MCP/LSP composition is done).
2. Complete v2 protocol-entity API/SDK/restart roundtrips beyond approvals
   (R53–R56): full endpoint coverage, SSE reconnect across a dropped/restarted
   daemon, and explicit CLI `resume` lifecycle acceptance coverage.
3. Prove local backend runtime wiring end-to-end, remote/hybrid interface
   contracts, the Ottili AI adapter contract test, and managed-auth flow
   (R45–R49).
4. Audit the legacy Ottili Coder feature matrix (`research/PORT_MATRIX.md`)
   against the current implementation and close R51 (useful features ported).
5. Expand the OCF benchmark with representative datasets and a documented
   tokenizer strategy (R34, `KP-010`).
6. Perform fresh documentation-to-implementation (R61), dependency-license
   (R60), provenance, and security audits on the final worktree.
7. Rerun the full root matrix (`pnpm install --frozen-lockfile`, lint,
   format:check, check:eol, check:boundaries, typecheck, test, test:integration,
   test:recovery, test:e2e, build, test:package, bench) plus a re-confirmed
   green cross-platform GitHub Actions matrix after the final source change,
   then update the ledger only from that evidence before reconsidering
   `TRUE_COMPLETE`.
