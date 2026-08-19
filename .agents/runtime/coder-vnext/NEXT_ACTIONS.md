# Next Actions

Since the last revision, Task Graph/Agent Graph delegation, live context
composition, provider failover, stagnation response, lease-fencing hardening,
shared multi-agent budgets, the real daemon-kill acceptance test, a partial
`store.ts` decomposition, seven real cross-platform/CI defects (KP-025
through KP-031), and MCP/LSP, worktree, and checkpoint composition into the
live capability system were implemented/fixed with direct regressions
(R12/R17/R18/R22/R23/R37/R39/R40/R43/R66). GitHub Actions run 32260314723
(commit `0157a78`) confirmed Ubuntu, macOS, and Windows all pass together,
though that was before the checkpoint composition change below — CI must be
re-confirmed on the new HEAD. Continue in this order; do not declare
`TRUE_COMPLETE` while any item remains open.

1. Decide and implement a fix for `KP-031` (a sandbox's `writableRoots` does
   not automatically widen to a dynamically-provisioned Agent worktree, and
   even a grant of the parent directory can mismatch on canonicalization) or
   document it explicitly as an operator requirement, alongside the
   backend/config work below.
2. Build a `checkpoint restore` CLI/API/SDK flow on top of the now-composed
   `CheckpointService` (pause the Run, apply the Git snapshot, restore
   durable state consistently, resume) with direct restart evidence — the
   creation half (`KP-015`) is done; restore orchestration was deliberately
   left out of that increment (ADR-019).
3. Complete v2 protocol-entity API/SDK/restart roundtrips beyond approvals
   (R53–R56): full endpoint coverage, SSE reconnect across a dropped/restarted
   daemon, and explicit CLI `resume` lifecycle acceptance coverage.
4. Prove local backend runtime wiring end-to-end, remote/hybrid interface
   contracts, the Ottili AI adapter contract test, and managed-auth flow
   (R45–R49).
5. Audit the legacy Ottili Coder feature matrix (`research/PORT_MATRIX.md`)
   against the current implementation and close R51 (useful features ported).
   Preliminary research this session found real gaps worth confirming: no
   CLI `models`/`mcp` subcommands, no Build/Plan/Debug/Ask role flags, no
   OAuth support, no GitHub Action file.
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
