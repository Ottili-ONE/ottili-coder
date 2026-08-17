# Donor Matrix

| Product concern | Primary source | Secondary source | Ottili-native implementation | Decision |
| --- | --- | --- | --- | --- |
| Provider/tool turn runtime | OpenCode | Current Coder, Kilo | Narrow Node `ProviderAdapter` and tool lifecycle | adapt/rewrite |
| Goal continuation/budgets/agent topology | Codex | Current Coder | Lease-fenced Run scheduler and durable Agent Graph | adapt/rewrite |
| Event journal/leases/judge | OpenHands SDK | OpenCode | SQL event journal, projections, outbox, fencing, evaluator ports | adapt/rewrite |
| Checkpoint/restore | Cline | Aider/OpenCode | Run checkpoint metadata + private Git refs + transactional restore | adapt/rewrite |
| Git/worktrees | Aider | OpenCode/Cline | Run-owned GitTransaction and worktree service | adapt/rewrite |
| Structural RepoMap | Aider | Kilo | Tree-sitter-compatible extractor + graph ranking + lexical fallback | reimplement |
| Semantic index/memory/sandbox | Kilo | Codex | Async lexical/vector-ready index, evidence-backed memory, capability sandbox | adapt/rewrite |
| MCP/LSP | OpenCode | Current Coder | Supervised adapters subject to policy/recovery | adapt/rewrite |
| CLI/API/config/Ottili integrations | Current Coder | OpenCode | Thin CLI, typed HTTP/SSE, import-only migration, optional managed adapters | port/redesign |
| Coordinator discipline | Mission specification | Claude reference unavailable | Small configurable roles and explicit synthesis/verification | independent |

All source reuse, if any, must be registered before release with exact donor
path, commit, license, and notice. No Claude Code source is permitted.
