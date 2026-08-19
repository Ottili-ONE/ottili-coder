# Next Actions

Since the last revision, Task Graph/Agent Graph delegation, live context
composition, provider failover, stagnation response, lease-fencing hardening,
shared multi-agent budgets, the real daemon-kill acceptance test, a partial
`store.ts` decomposition, six real cross-platform/CI defects (KP-025 through
KP-030), and MCP/LSP plus worktree composition into the live capability
system were implemented/fixed with direct regressions
(R12/R17/R22/R23/R37/R39/R40/R43/R66). GitHub Actions run 32256548228 (commit
`afa6ce0`) confirmed Ubuntu, macOS, and Windows all pass together, though that
was before the worktree composition change below — CI must be re-confirmed on
the new HEAD. Continue in this order; do not declare `TRUE_COMPLETE` while any
item remains open.

1. Compose checkpoints into the runtime turn (create a checkpoint on durable
   milestones, using the real `CheckpointService`/Git-snapshot path, not just
   the lightweight `RunStore.createCheckpoint` metadata row) with direct
   restart evidence (`KP-015`, now narrowed to checkpoints only — MCP/LSP and
   worktree composition are both done).
2. Decide and implement a fix for `KP-031` (a sandbox's `writableRoots` does
   not automatically widen to a dynamically-provisioned Agent worktree)
   alongside the backend/config work below, or document it explicitly as an
   operator requirement.
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
