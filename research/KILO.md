# Kilo Code Audit

Pinned donor: `Kilo-Org/kilocode` at
`91a337e31cd7675d680aeb13c92870b8f81bdf36` (MIT).

## Findings

- `packages/kilo-indexing/src/indexing/{manager,service-factory,orchestrator}.ts`
  establishes useful service boundaries. `processors/parser.ts` supports
  Tree-sitter parsing with deterministic fallback chunks, and
  `cache-manager.ts` uses a hash cache with atomic replacement. The vector
  search itself is cache-oriented and lacks hybrid retrieval, freshness, ACL,
  provenance, and durable job state, so it is not authoritative run state.
- `worktree-overlay.ts` and `search-service.ts` demonstrate a useful primary
  index plus worktree-delta overlay model. Ottili will adapt that shape while
  retaining a project-index job/event record and lexical fallback.
- `packages/kilo-memory` offers bounded memory injection, project identity over
  linked worktrees, atomic writes, tool permission hooks, and secret redaction
  (`capture/redact.ts`). Its Markdown/session-digest store and term-overlap
  recall are not a durable evidence model; Ottili will use structured memory
  records with provenance, retention, promotion, and redaction.
- `packages/kilo-sandbox/src/{context,path,filesystem,backend,bubblewrap}.ts`
  contains valuable capability/profile, canonical path, and platform adapter
  concepts. The authenticated local proxy and destination validation in
  `proxy.ts` / `destination.ts` are useful network-defense references.
  Platform support is intentionally incomplete, therefore Ottili must expose
  precise capability detection and never advertise unsupported isolation.
- Kilo's provider error/stream normalization and daemon startup discipline are
  valuable references. `packages/opencode/src/kilocode/daemon/{daemon,client}.ts`
  uses locks, restrictive state files, password, health/version checks, stale
  cleanup, and controlled shutdown. It does not implement transactional Run
  recovery/lease fencing and must not be used as that architecture.

## Decisions

| Area                            | Decision                                     | Important donor paths/tests                                         |
| ------------------------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| Incremental semantic indexing   | ADAPT then REWRITE search/job persistence    | `packages/kilo-indexing/src/indexing/*`, `test/kilocode/indexing/*` |
| Worktree index overlay          | ADAPT                                        | `worktree-overlay.ts`, `search-service.ts`                          |
| Project memory safety           | ADAPT capture/redaction; REWRITE persistence | `packages/kilo-memory/{storage,recall,capture}/*`                   |
| Sandbox profiles/path/network   | ADAPT                                        | `packages/kilo-sandbox/src/*`, sandbox tests                        |
| Provider error/compaction cases | ADAPT test cases                             | `packages/opencode/src/{provider,error,session/retry}.ts`           |
| Daemon file/health hygiene      | ADAPT                                        | `packages/opencode/src/kilocode/daemon/*`                           |
| VS Code Agent Manager           | DROP                                         | extension-owned async state                                         |

## Provenance boundary

No Kilo source is copied by this audit. Kilo's caches, extension/UI state, and
session-local recovery are expressly not durable Ottili Run truth.
