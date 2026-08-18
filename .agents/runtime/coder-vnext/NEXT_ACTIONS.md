# Next Actions

The local root matrix is green and the two reported cross-platform CI failures
are fixed with regressions. Continue in this order; do not declare
`TRUE_COMPLETE` while any item remains open.

0. Push the cross-platform repair and require a green GitHub Actions matrix on
   Ubuntu, macOS, and Windows (`KP-023`). Treat CI, not the local matrix, as
   the authoritative platform evidence.
1. Extend `KP-004` from synthetic heartbeat evidence to delayed real
   provider/tool plus competing-daemon takeover coverage; audit every
   executor-owned lifecycle write for fencing.
2. Add a delayed provider/tool plus live-SSE daemon shutdown regression and
   prove pause/cancel aborts an active side effect (`KP-009`, `KP-014`).
3. Exercise durable completion through all reachable HTTP/runtime paths for
   unproven requirements, failed validation, and verifier-boundary misuse.
4. Complete v2 protocol-entity API/SDK/restart roundtrips, task-graph restart
   reconstruction, resource-lock recovery, and shared multi-agent budget/cost
   attribution.
5. Enforce permission/approval policy for workspace operations; retain default
   command denial, symlink-safe paths, and locks; document or implement host
   isolation.
6. Compose context planner, OCF, checkpoint, worktree, and stagnation through
   runtime/daemon flows, including continuation across restart.
7. Prove CLI resume, local backend runtime wiring, remote/hybrid contracts,
   Ottili adapter/BYOK, managed auth, and legacy feature compatibility.
8. Expand the OCF benchmark with representative datasets and a documented
   tokenizer strategy.
9. Perform fresh documentation, dependency-license, provenance, and security
   audits on the final worktree.
10. Rerun the root matrix and direct daemon/takeover/SSE tests after the final
    source change, then update the ledger only from that evidence.
