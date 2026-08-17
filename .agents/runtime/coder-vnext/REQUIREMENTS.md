# Ottili Coder vNext Requirement Ledger

Status values: `UNPROVEN`, `PROVEN`, `CONTRADICTED`, `WAIVED`.

| ID | Requirement | Proof required | Status | Evidence |
| --- | --- | --- | --- | --- |
| R01 | Independent clean Ottili Coder repo | Separate Git root, no donor history | PROVEN | New Git repo on `main`; donors are sibling directories |
| R02 | Selective functional OpenCode-derived runtime | Runtime/provider/tool integration tests | UNPROVEN | — |
| R03 | No mandatory Bun runtime | Dependency scan and Node CI | UNPROVEN | — |
| R04 | No OpenTUI runtime dependency | Dependency scan | UNPROVEN | — |
| R05 | Node/pnpm build works | Root install/typecheck/build | UNPROVEN | — |
| R06 | CLI is a thin client | Boundary tests and architecture audit | UNPROVEN | — |
| R07 | Daemon owns execution | Detach/restart integration tests | UNPROVEN | — |
| R08 | Run persists independently of Session | Persistence/restart test | UNPROVEN | — |
| R09 | Durable Mission entity | Migration and repository tests | UNPROVEN | — |
| R10 | Durable Goal entity | Migration and repository tests | UNPROVEN | — |
| R11 | Goal auto-continues while active | Scheduler integration test | UNPROVEN | — |
| R12 | Persistent Task Graph | Dependency/restart tests | UNPROVEN | — |
| R13 | Persistent Agent Graph | Topology/restart tests | UNPROVEN | — |
| R14 | Agent spawn/continue/wait/stop/resume | Lifecycle tests | UNPROVEN | — |
| R15 | Run survives CLI disconnect | Daemon attach integration test | UNPROVEN | — |
| R16 | Run survives daemon restart | Crash/recovery integration test | UNPROVEN | — |
| R17 | Lease fencing prevents stale writes | Lease takeover test | UNPROVEN | — |
| R18 | Checkpoint captures workspace | Git snapshot test | UNPROVEN | — |
| R19 | Checkpoint captures untracked files | Untracked fixture test | UNPROVEN | — |
| R20 | Checkpoint restore is transactional | Failure/rollback test | UNPROVEN | — |
| R21 | Context exhaustion creates continuation | Session epoch test | UNPROVEN | — |
| R22 | Structured provider recovery | Scripted-provider tests | UNPROVEN | — |
| R23 | Stagnation detection | Repeated-failure test | UNPROVEN | — |
| R24 | Requirement Ledger exists | Persistence/API tests | UNPROVEN | — |
| R25 | Completion Gate exists | Completion tests | UNPROVEN | — |
| R26 | Independent verification exists | Fresh verifier integration test | UNPROVEN | — |
| R27 | Unproven requirements prevent completion | Completion rejection test | UNPROVEN | — |
| R28 | Aider-style structural RepoMap exists | Ranking tests | UNPROVEN | — |
| R29 | Kilo-style semantic index exists | Index startup/search tests | UNPROVEN | — |
| R30 | Project Memory exists | Promotion/recall tests | UNPROVEN | — |
| R31 | Context Planner exists | Budget/selection tests | UNPROVEN | — |
| R32 | OCF exists | Codec tests | UNPROVEN | — |
| R33 | OCF roundtrip is correct | Fuzz/roundtrip tests | UNPROVEN | — |
| R34 | OCF token benchmark exists | Reproducible benchmark | UNPROVEN | — |
| R35 | OCF delta mode exists or documented rejection | Delta tests/evidence | UNPROVEN | — |
| R36 | Git service exists | Workspace tests | UNPROVEN | — |
| R37 | Worktree manager exists | Lifecycle tests | UNPROVEN | — |
| R38 | Sandbox abstraction exists | Capability/inheritance tests | UNPROVEN | — |
| R39 | MCP exists | Lifecycle/permission tests | UNPROVEN | — |
| R40 | LSP exists | Adapter/diagnostic tests | UNPROVEN | — |
| R41 | Tool recovery metadata exists | Recovery metadata tests | UNPROVEN | — |
| R42 | Resource locks exist | Contention tests | UNPROVEN | — |
| R43 | Shared Run budget exists | Parent/child budget test | UNPROVEN | — |
| R44 | Usage/cost accounting exists | Cost-record tests | UNPROVEN | — |
| R45 | Ottili AI adapter exists | Contract tests | UNPROVEN | — |
| R46 | Local BYOK works without login | Local provider test | UNPROVEN | — |
| R47 | Ottili Auth managed-service boundary exists | Auth adapter tests | UNPROVEN | — |
| R48 | Local execution backend works | End-to-end fixture test | UNPROVEN | — |
| R49 | Remote/Hybrid contracts are testable | Deterministic takeover test | UNPROVEN | — |
| R50 | Legacy feature matrix completed | `research/PORT_MATRIX.md` | UNPROVEN | — |
| R51 | Useful current features are ported | Compatibility tests | UNPROVEN | — |
| R52 | Legacy config import exists | Import fixture test | UNPROVEN | — |
| R53 | Server API is typed | Protocol/server type tests | UNPROVEN | — |
| R54 | SSE reconnect works | Last-Event-ID integration test | UNPROVEN | — |
| R55 | TypeScript SDK works | SDK integration tests | UNPROVEN | — |
| R56 | CLI attach/resume works | CLI end-to-end tests | UNPROVEN | — |
| R57 | Doctor command exists | CLI smoke test | UNPROVEN | — |
| R58 | Root validation commands exist | Script checks | UNPROVEN | — |
| R59 | Recovery integration suite passes | Recovery suite | UNPROVEN | — |
| R60 | OSS licensing/notices are correct | License audit | UNPROVEN | — |
| R61 | Documentation matches implementation | Documentation audit | UNPROVEN | — |
| R62 | No Claude Code source copied | Provenance scan/audit | UNPROVEN | — |
| R63 | No donor repository embedded | Repository scan/audit | UNPROVEN | — |
| R64 | No known critical/high defects remain | Problem ledger and audit | UNPROVEN | — |
| R65 | Full final validation passes | Validation log | UNPROVEN | — |
