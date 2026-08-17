# Donor Decision Matrix

| Product concern                        | Research source                                     | Ottili-native decision                                                                                       |
| -------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Provider/tool turn runtime             | OpenCode, current Ottili Coder, Kilo                | Narrow Node ProviderAdapter and durable tool lifecycle.                                                      |
| Goals, budgets, continuation, topology | OpenAI Codex, current Ottili Coder                  | Lease-fenced Run scheduler and durable graph model.                                                          |
| Event journal, leases, judgment        | OpenHands SDK, OpenCode                             | SQLite events/projections, fencing, evaluator port.                                                          |
| Checkpoint and restore                 | Cline, Aider, OpenCode                              | Private Git refs and transactional restore.                                                                  |
| Git/worktrees                          | Aider, OpenCode, Cline                              | Run-owned Git service and worktree manager.                                                                  |
| Structural RepoMap                     | Aider, Kilo                                         | Independently reimplemented extractor/ranker with lexical fallback.                                          |
| Semantic index, memory, sandbox        | Kilo, OpenAI Codex                                  | Async lexical/vector-ready index, evidence-aware memory, capability profiles.                                |
| MCP/LSP concepts                       | OpenCode, current Ottili Coder                      | Supervised declarative integration behind policy/recovery; LSP servers remain explicit deployment processes. |
| CLI, API, config, Ottili integration   | Current Ottili Coder, OpenCode                      | Thin CLI, typed HTTP/SSE, non-destructive config import, optional managed adapter boundary.                  |
| Coordinator discipline                 | Mission specification; Claude reference unavailable | Independent coordinator/verifier behavior, no Claude source reuse.                                           |

## Design constraints derived from research

- OpenCode's Bun-centric runtime is not carried forward as the product base.
- Codex contributes durable-goal/continuation lessons, not a copied control
  plane.
- Kilo caching/session behavior is not treated as durable state.
- OpenHands-style leases are implemented with database fencing rather than file
  locks.
- Cline-style checkpoints are transactional; a restore failure attempts
  rollback.
- Aider-style repository maps are independently implemented algorithms.
- The legacy Ottili product is a feature and UX reference, not a directory
  transplant.
- The unavailable Claude snapshot is reference-only and excluded from source
  reuse.

The detailed research records are in the repository-level research directory.
