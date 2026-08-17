# Migrating from the legacy Ottili Coder

Ottili Coder vNext is a clean Node.js rebuild, not an in-place upgrade of the
legacy Bun/OpenCode-shaped application. It preserves useful user intent while
changing the execution model from a session-owned CLI to a daemon-owned,
durable Run.

## What changes

| Legacy area                  | vNext direction                                                      |
| ---------------------------- | -------------------------------------------------------------------- |
| CLI process owns a session   | Thin CLI attaches to a daemon-owned Run.                             |
| Bun and OpenTUI runtime      | Node.js and pnpm; no mandatory Bun/OpenTUI.                          |
| Session/full-run persistence | SQLite event journal plus materialized Run projections.              |
| Ad-hoc task/agent state      | Explicit Mission, Run, Goal, Task, Agent, and SessionEpoch entities. |
| Snapshot UX                  | Git-backed checkpoint and transactional restore primitives.          |
| Config locations             | Canonical ~/.ottili/coder and project .ottili/coder.json.            |
| Providers/auth               | BYOK adapter boundary plus optional managed Ottili boundary.         |
| HTTP interfaces              | Versioned v1 HTTP/SSE protocol and TypeScript SDK.                   |

The legacy feature audit is documented in
[research/CURRENT_CODER.md](research/CURRENT_CODER.md). It is a compatibility
reference, not a source-tree dependency.

## Configuration import

vNext recognizes these legacy JSON candidates:

```text
~/.ottili-coder/config.json
~/.config/ottili-coder/config.json
<project>/.ottili-coder/config.json
```

Inspect before writing:

```sh
pnpm dev -- config preview
pnpm dev -- config preview --project .
```

Copy settings non-destructively:

```sh
pnpm dev -- config import
pnpm dev -- config import --project .
```

The importer never deletes or edits the source. It refuses to overwrite an
existing canonical configuration unless you pass --overwrite.

Canonical targets are:

```text
~/.ottili/coder/config.json
<project>/.ottili/coder.json
```

Review imported provider endpoints and credentials before use. A legacy config
is untrusted input; malformed JSON is left untouched.

## Moving workflows

### Starting and following work

Instead of making a terminal session the owner of work, start a Run and attach
to it:

```sh
pnpm dev -- run "Investigate and fix the failing tests" --workspace .
pnpm dev -- attach <run-id> --follow
```

Detaching only stops the client. Reattach from another terminal with the Run
ID, or query pnpm dev -- runs list.

### Daemon discovery

The CLI first honours OTTILI_CODER_DAEMON_URL, then a descriptor at
~/.ottili/coder/daemon.json, then the default loopback URL. daemon start has a
bundled local daemon entrypoint; a deployment can replace it through
OTTILI_DAEMON_COMMAND or supply an endpoint directly. For remote operation,
use a token and a network boundary appropriate to the environment.

### Scripts and integrations

Automations should call the v1 HTTP API or TypeScript SDK, not scrape terminal
output. Use an idempotency key for pause/resume/cancel commands, persist the
Run ID, and resume event consumption from the last durable sequence.

## Compatibility boundaries

The following are not promised as drop-in migration targets in this source
build:

- legacy OpenTUI rendering and Bun plugin mechanics;
- implicit session state or a one-process TUI runtime;
- unsafe automatic credential copying;
- a managed OAuth migration;
- arbitrary plug-in/module loading or bundled third-party LSP binaries.

Keep the legacy installation intact until the required vNext workflow has been
validated with a disposable workspace. Migration is reversible because legacy
configuration is only copied, never moved or deleted.
