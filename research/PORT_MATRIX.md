# Legacy Feature Port Matrix

| Capability                               | Classification | vNext outcome                                                       |
| ---------------------------------------- | -------------- | ------------------------------------------------------------------- |
| Product identity / binary                | KEEP           | `ottili-coder` remains the public binary                            |
| CLI command intent                       | PORT           | Run, attach, resume, daemon, models, MCP, config, doctor via SDK    |
| In-process TUI                           | REDESIGN       | Readline/ANSI client; no execution ownership                        |
| Build/Plan/Debug/Ask roles               | PORT           | Configurable role/policy profiles over one runtime                  |
| FullRun / TaskGraph experiments          | REDESIGN       | SQL-backed Mission/Run/Task state machine                           |
| Providers / Ottili AI                    | PORT           | Adapter boundary; local BYOK works unauthenticated                  |
| Account / OAuth                          | PORT           | Optional managed-service adapter only                               |
| MCP / LSP                                | PORT           | Durable supervision and permissions replace session-local lifecycle |
| Config                                   | REDESIGN       | Canonical `~/.ottili/coder`, non-destructive legacy import          |
| HTTP / SDK                               | REDESIGN       | One versioned Run protocol and generated-style TypeScript client    |
| GitHub Action                            | REDESIGN       | Invokes same headless Run API                                       |
| Cloud command surface                    | REDESIGN       | Local backend plus contract-tested remote/hybrid adapters           |
| Snapshot/checkpoint UX                   | PORT concepts  | Private refs and transactional Run checkpoint implementation        |
| Bun / OpenTUI / `@opencode-ai` namespace | DROP           | Node-only Ottili-native runtime                                     |
