# Third-Party Notices and Provenance

Ottili Coder vNext is an independent Apache-2.0 project. It was rebuilt after
an architecture and feature audit of the repositories listed below. The
research checkout directories are outside this product Git repository and are
not shipped as product source.

## Current implementation provenance

The initial vNext implementation is independently written TypeScript. It uses
architecture concepts and behavior-oriented research, not directory-level
copies. If an upstream source fragment is later copied or adapted, this file
must be updated before release with:

- upstream project, URL, pinned commit, and path;
- license and copyright notice;
- a concise description of the adaptation;
- all required license text or notice placement.

No such source-fragment reuse is registered for the initial implementation.

## Research donors

| Project              | Pinned commit                            | License at audit | Research role                                                 |
| -------------------- | ---------------------------------------- | ---------------- | ------------------------------------------------------------- |
| OpenCode             | 31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d | MIT              | Provider/tool/event/retry/MCP/LSP/Git patterns.               |
| Kilo Code            | 91a337e31cd7675d680aeb13c92870b8f81bdf36 | MIT              | Index, memory, and sandbox patterns.                          |
| OpenAI Codex         | 32a383c0ba5ed42a1adc3f2084014895bfe7738c | Apache-2.0       | Durable goals, continuations, accounting, and graph patterns. |
| OpenHands            | 6670b4726a81fc73e797a193dae86264857a663d | MIT              | Event projections, leases, and recovery concepts.             |
| OpenHands SDK        | b56221283f74dbced26d1da134ded26860bb4f14 | MIT              | Agent-runtime mechanics concepts.                             |
| Cline                | 041afb718bcdfe50eabd90d060e5335ef98e2d16 | Apache-2.0       | Checkpoint and transactional-restore concepts.                |
| Aider                | 5dc9490bb35f9729ef2c95d00a19ccd30c26339c | Apache-2.0       | RepoMap, Git-safety, and voice-boundary concepts.             |
| Current Ottili Coder | 7bcd1a2a6ee1880112f06b39221ffe9c6cfe44eb | MIT              | Feature/UX/integration audit.                                 |

The exact donor lock and the port matrix are reproduced under docs/donors/ and
the full audit notes remain under research/.

## Explicit exclusion

The Claude Code snapshot/reference was unavailable to the audit and has
**no source reuse authorization**. No source, test, API implementation,
internal design file, or other material from that archive is included here.

The optional Ottili ONE platform repository was likewise unavailable during
the audit and is not embedded in this product.

## Dependencies

Development dependencies are declared in package.json and pinned in
pnpm-lock.yaml. Their license obligations must be reviewed as part of a
release artifact audit. This notice does not replace the dependency metadata
or any license files distributed by those dependencies.
