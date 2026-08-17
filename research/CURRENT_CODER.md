# Current Ottili Coder Audit

Pinned donor: `Ottili-ONE/coder-cli` at
`7bcd1a2a6ee1880112f06b39221ffe9c6cfe44eb` (MIT).

## Observed product surface

The legacy product is a large Bun/OpenCode-shaped monorepo. Its
`packages/ottili-coder` package contains CLI commands, a TUI, typed HTTP API,
sessions/agents, task graph and full-run state, provider and account layers,
MCP/LSP, Git/worktree/snapshot, checkpoint/crash-resume, cloud integration,
permissions, plugins, ACP, and a broad test corpus. Key directories include:

- `src/cli/cmd/{run,attach,serve,models,providers,mcp,agent,cloud}.ts`
- `src/{fullrun,taskgraph,control-plane,agent,session}/`
- `src/{provider,account,auth,cloud,config}/`
- `src/{mcp,lsp,git,worktree,snapshot,permission}/`
- `src/server/routes/instance/httpapi/`
- `test/{cli,control-plane,taskgraph,cloud,config,git,mcp,provider,server}/`

Its package manifest requires Bun/OpenTUI and `@opencode-ai/*` workspace
packages, so it cannot be carried as the new Node product base.

## Preliminary KEEP / PORT / REDESIGN / DROP

| Capability | Decision | Ottili vNext treatment |
| --- | --- | --- |
| `ottili-coder` binary and core command intent | PORT | Thin Node client over the daemon protocol |
| Interactive TUI | REDESIGN | Simple readline/ANSI attach client first; no runtime coupling |
| Run / full-run / task graph concepts | REDESIGN | Mission/Run-centered durable control plane |
| Provider and Ottili AI routes | PORT | Typed adapters; local BYOK remains login-free |
| Account/auth managed-service boundaries | PORT | Optional managed-service integration only |
| MCP / LSP | PORT | Supervised adapters behind ordinary permissions/recovery |
| Git / worktree / snapshots | REDESIGN | Run-owned transactional services/checkpoints |
| Legacy checkpoint/crash-resume lessons | PORT concepts | New durable event/lease recovery model |
| HTTP API / SDK / ACP | REDESIGN | Versioned protocol and TypeScript SDK; compatibility where safe |
| Cloud / local deployment adapters | REDESIGN | Real local backend plus contract-tested remote/hybrid ports |
| Configuration | PORT | Import legacy config non-destructively into `~/.ottili/coder` |
| GitHub integration/action | PORT later | Headless client of the same daemon protocol |
| OpenCode names, Bun, OpenTUI, legacy effect monolith | DROP | Replaced by Node-native package boundaries |

No legacy source is copied by this audit. The final port matrix will be
updated after the dedicated feature audit and implementation verification.

## Dedicated feature-audit evidence

| Area | Evidence | Final direction |
| --- | --- | --- |
| CLI compatibility | `src/index.ts`, `src/cli/cmd/run.ts`, `attach.ts`, `serve.ts`, CLI help tests | Keep useful aliases and JSON/headless use, but replace in-process runtime and unconditional exit with daemon SDK calls |
| Modes/agents | `src/agent/agent.ts`, `src/config/agent.ts`, agent tests | Port Build/Plan/Debug/Ask intent and permissions as data-backed roles; redesign scheduling |
| Full run/task graph | `src/{fullrun,taskgraph}/*` | Port concepts/tests only; current Bun/JSON persistence is not production-integrated durable state |
| Providers/Ottili AI | `src/provider/*`, `src/plugin/ottili-coder-{models,auth}.ts`, account tests | Port adapters/contracts with managed-service boundary; preserve BYOK without login |
| `ottili-auto` | `src/provider/ottili-auto/*`, provider tests | Redesign optional routing policy; do not carry secret scanning or static mismatch-prone catalog |
| Config/migration | `src/config/*`, `core/src/{config,v1/config/migrate}.ts` | Import/preview only from legacy locations; no destructive auto-migration |
| MCP | `src/mcp/*`, lifecycle/OAuth tests | Port protocol mechanics; redesign supervision, secret storage, and recovery metadata |
| LSP | `src/lsp/*`, LSP tests | Port diagnostics/symbol concepts; redesign process lifecycle/download behavior |
| Server/API | `src/server/*`, `packages/server`, HTTP API tests | Redesign around a single versioned Run protocol; retain typed contracts/event testing ideas |
| SDKs | `packages/sdk/js/*`, Python wrapper | Port TS contract generation; redesign Python as optional client, not a CLI proxy |
| GitHub integration | `github/action.yml`, `github/index.ts`, `src/cli/cmd/github*.ts` | Redesign as idempotent Run API client with scoped credentials |
| Cloud | `src/cloud/*`, `src/tool/cloud.ts`, cloud tests | Port HTTP adapter/mock concepts; redesign Local/Remote/Hybrid backend state/continuity |
| Checkpoint/resume | `src/{snapshot,cairn}/*`, session tests | Port UX/diff ideas only; replace with transactional Run checkpoint engine |

The legacy codebase has pervasive `@opencode-ai/*`, Bun, OpenTUI, and mixed V1
and V2 architecture. It is a regression corpus and compatibility reference,
not a base or directory-level port target.
