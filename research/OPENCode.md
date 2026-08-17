# OpenCode Audit

Pinned donor: `anomalyco/opencode` `v1.18.18` at
`31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d` (MIT).

## Findings

- The donor has useful typed provider, tool, event-projection, retry,
  compaction, MCP, LSP, Git, and worktree patterns, but its main runtime and
  build pipeline are Bun-dependent. Its `packages/opencode/script/build.ts`
  uses Bun APIs and must not become an Ottili runtime dependency.
- `packages/opencode/src/provider/provider.ts`, `src/session/llm.ts`, and
  `src/session/llm/request.ts` provide the right conceptual seams: normalized
  model capabilities, provider limits/costs, tool-filtered requests, and
  streaming events. Ottili will independently define a smaller Node-native
  adapter surface around those concepts.
- `src/tool/{tool,registry}.ts`, `src/session/tools.ts`, and
  `src/permission/index.ts` validate schemas, preserve tool-call identity,
  truncate output, and use allow/ask/deny policies. Ottili will retain those
  principles while adding explicit side-effect, idempotency, resource-lock,
  sandbox, and recovery metadata.
- `packages/core/src/event.ts`, `src/session/input.ts`, and
  `src/session/projector.ts` show the value of append-plus-project and
  idempotent input admission. Their drain/claim mechanisms are process-local;
  Ottili must add renewable leases, fencing generations, and daemon-restart
  continuation rather than treating a donor Session as a durable Run.
- `src/session/retry.ts` and `src/session/compaction.ts` show bounded retry,
  Retry-After handling, jitter, transcript-tail selection, and tool-output
  pruning. Ottili will make retries/compaction durable policy-driven recovery
  actions with event/evidence records.
- `src/mcp/*`, `src/lsp/*`, `src/git/index.ts`, `src/worktree/index.ts`, and
  `src/snapshot/index.ts` are references for adapters and operational safety.
  MCP/LSP/PTY in the donor are in-process and must be supervised/recreated by
  Ottili after restart.

## Decisions

| Area                                    | Decision                     | Important donor paths/tests                                          |
| --------------------------------------- | ---------------------------- | -------------------------------------------------------------------- |
| Node runtime/build                      | DROP                         | `packages/opencode/{package.json,script/build.ts}`                   |
| Provider contract/events                | ADAPT                        | `src/provider/provider.ts`, `src/session/llm*.ts`, `test/provider/*` |
| Tool/permission concepts                | ADAPT                        | `src/tool/*`, `src/permission/*`, `test/tool/*`                      |
| Durable Run layer                       | REWRITE                      | `packages/core/src/{event,session}.ts`                               |
| Retry/compaction policy                 | ADAPT then REWRITE           | `src/session/{retry,compaction,processor}.ts`                        |
| MCP/LSP adapters                        | ADAPT                        | `src/mcp/*`, `src/lsp/*`, related tests                              |
| Git/worktree/snapshot                   | ADAPT then REWRITE lifecycle | `src/{git,worktree,snapshot}/*`                                      |
| OpenCode branding/cloud/plugin autoload | DROP                         | provider/plugin/build/UI paths                                       |

## Provenance boundary

No OpenCode source is copied by this audit. If a later small implementation is
derived from MIT-licensed donor code, the exact file, commit, copyright notice,
and attribution must be recorded in `THIRD_PARTY_NOTICES.md` before release.
