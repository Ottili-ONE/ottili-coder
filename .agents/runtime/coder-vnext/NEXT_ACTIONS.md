# Next Actions

Since the last revision, Task Graph/Agent Graph delegation, live context
composition, provider failover, stagnation response, lease-fencing hardening,
shared multi-agent budgets, the real daemon-kill acceptance test, and a
partial `store.ts` decomposition were implemented with direct regressions
(R12/R17/R22/R23/R43/R66). Continue in this order; do not declare
`TRUE_COMPLETE` while any item remains open.

1. Re-confirm a green GitHub Actions matrix on Ubuntu, macOS, and Windows on
   the current HEAD (`KP-023`) — the last confirmed-green run was on an
   earlier commit. Treat CI, not the local matrix, as authoritative platform
   evidence.
2. Compose MCP and LSP into the live runtime capability/permission/approval
   system rather than leaving them isolated demos; keep default-deny and no
   dynamic binary downloads at core startup (`KP-013`, `KP-015`).
3. Compose checkpoints and worktrees into the runtime turn (create a
   checkpoint on durable milestones; use an isolated worktree for delegated
   agents where appropriate) with direct restart evidence (`KP-015`).
4. Complete v2 protocol-entity API/SDK/restart roundtrips beyond approvals
   (R53–R56): full endpoint coverage, SSE reconnect across a dropped/restarted
   daemon, and explicit CLI `resume` lifecycle acceptance coverage.
5. Prove local backend runtime wiring end-to-end, remote/hybrid interface
   contracts, the Ottili AI adapter contract test, and managed-auth flow
   (R45–R49).
6. Audit the legacy Ottili Coder feature matrix (`research/PORT_MATRIX.md`)
   against the current implementation and close R51 (useful features ported).
7. Expand the OCF benchmark with representative datasets and a documented
   tokenizer strategy (R34, `KP-010`).
8. Perform fresh documentation-to-implementation (R61), dependency-license
   (R60), provenance, and security audits on the final worktree.
9. Rerun the full root matrix (`pnpm install --frozen-lockfile`, lint,
   format:check, check:eol, check:boundaries, typecheck, test, test:integration,
   test:recovery, test:e2e, build, test:package, bench) plus the confirmed
   green cross-platform CI matrix after the final source change, then update
   the ledger only from that evidence before reconsidering `TRUE_COMPLETE`.
