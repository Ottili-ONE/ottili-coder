# Ottili Coder

> Give it a mission. Let it work until the evidence says it is done.

Ottili Coder is an open-source, long-horizon coding-agent runtime. Its central
unit is a durable **Run**, not a terminal session or one model response. A
daemon owns the Run, records its state and events in SQLite, and exposes a
versioned HTTP/SSE interface. The CLI and SDK are disposable clients: closing
them must not make a Run disappear.

## Current scope

This repository is the Node.js and pnpm vNext rebuild. The implementation
contains a tested vertical slice for durable Run creation, a lease-fenced
scheduler, a provider/tool turn loop, event replay over SSE, checkpoint
primitives, context services, and a thin CLI/SDK boundary.

It is deliberately not presented as a hosted service, a production security
boundary, or a replacement for human review. In particular, an actual provider
configuration, workspace policy, and independent verifier are deployment
responsibilities. See [known limitations](#known-limitations) before using it
on valuable repositories.

## Design at a glance

```text
CLI / SDK / other clients
        │ HTTP + sequenced SSE (v1)
        ▼
Daemon server
        ▼
Control plane ─── SQLite WAL
        │           events + projections + leases + receipts
        ▼
Scheduler → runtime → provider and declared tools
        │
        ├── workspace / Git / checkpoints / sandbox policy
        ├── context / RepoMap / memory / OCF
        └── validation / requirement ledger / completion gate
```

The durable hierarchy is:

```text
Mission → Run → Goal / Task graph / Agent graph → Session epoch → LLM turn
```

The Run is the recovery boundary. A model context window, worker process, CLI,
SSE stream, or provider request is not.

## Requirements

- Node.js 24 or newer; the control plane uses the built-in SQLite API.
- pnpm 11.15.1 or a compatible pnpm version.
- Git, for workspace/checkpoint features.

The project does not require Bun or OpenTUI.

## Build and validate

From a fresh checkout:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:recovery
pnpm build
```

Useful development commands:

```sh
pnpm dev -- help
pnpm doctor
pnpm bench
node scripts/check-boundaries.mjs
```

The root commands are intentionally the supported validation interface; no
package-private command should be necessary for ordinary contribution checks.

## CLI

The binary is named ottili-coder. In this source checkout, run it through
pnpm:

```sh
pnpm dev -- help
pnpm dev -- doctor
```

The current command surface includes:

```text
run <prompt> [--workspace <path-or-uri>] [--follow]
attach <run-id> [--after <sequence>] [--once] [--follow]
resume <run-id> [--follow]
runs list [--status <status>] [--limit <count>]
run status|pause|resume|cancel <run-id>
daemon start|status|stop|restart
agents list <run-id>
checkpoints list <run-id>
approvals list <run-id>
approvals resolve <run-id> <approval-id> <approved|rejected> [--resolver <id>]
config preview|import
doctor
```

Use --json for machine-readable CLI output. attach reads durable history first
and can continue with SSE; reconnect with --after <sequence>.

The CLI locates a daemon through OTTILI_CODER_DAEMON_URL or a local endpoint
descriptor in ~/.ottili/coder/daemon.json. daemon start launches the bundled
daemon entrypoint by default; OTTILI_DAEMON_COMMAND can replace it for a
deployment-specific launcher. The launcher may set OTTILI_CODER_DAEMON_TOKEN.
This separation is intentional: terminal processes never own the Run lifecycle.

See [the protocol guide](docs/architecture/PROTOCOL.md) for the HTTP endpoints
and [the migration guide](MIGRATION.md) for legacy configuration import.

## Safety model

- The server binds to 127.0.0.1 by default. Binding beyond loopback requires a
  bearer token.
- SQLite state uses WAL mode; executor-owned control-plane writes validate a
  monotonic Run lease generation before committing.
- Tool calls record an intent before execution and a terminal outcome after it.
  A crash leaves uncertain effects for recovery rather than silently replaying
  them.
- Tool permissions, resource scopes, sandbox policy, and approval records are
  explicit data; approval decisions are available over the daemon API and CLI.
  This is not a claim that every host can enforce every requested sandbox
  restriction.
- Completion is a control-plane decision: required evidence, deterministic
  validation, and an independent verifier are all required.

Read [Security](SECURITY.md) and
[the security architecture](docs/architecture/SECURITY.md) before exposing a
daemon or granting write/network privileges.

## Package layout

| Area                           | Responsibility                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------- |
| packages/protocol              | Versioned wire contracts and serializable policy types.                         |
| packages/core                  | Domain state machines, budget, blocker, lease, and permission rules.            |
| packages/control-plane         | SQLite migrations, event journal, projections, leases, commands, and scheduler. |
| packages/runtime               | Provider/tool turn engine and durable coordinator bridge.                       |
| packages/agents                | Agent graph, roles, capacity, mailbox, and supervisor primitives.               |
| packages/validation            | Requirement ledger, stagnation, and completion gate.                            |
| packages/recovery              | Checkpoint transaction and tool-failure recovery policy.                        |
| packages/workspace             | Git snapshots, worktrees, commands, and sandbox profiles.                       |
| packages/context               | RepoMap, lexical semantic index, memory, and context planning.                  |
| packages/context-format        | OCF/1 encoding, decoding, and deltas.                                           |
| packages/server / packages/sdk | HTTP/SSE daemon adapter and TypeScript client.                                  |
| packages/integrations          | Provider, config migration, MCP, and execution-backend boundaries.              |
| apps/cli                       | Thin daemon client.                                                             |

## Configuration and credentials

Canonical user configuration lives in ~/.ottili/coder; project configuration
lives in .ottili/coder.json. Legacy import is preview-first and
non-destructive. Configuration files and daemon descriptors are written with
owner-only file permissions where the platform supports them.

Bring-your-own-key provider use does not require an Ottili account. The Ottili
AI adapter and managed-auth interface are integration boundaries; never commit
API keys, bearer tokens, or a daemon descriptor containing a token.

## Documentation

- [Architecture overview](docs/architecture/OVERVIEW.md)
- [Runtime and long-horizon behavior](docs/architecture/RUNTIME.md) and
  [long-horizon model](docs/architecture/LONG_HORIZON.md)
- [Persistence and recovery](docs/architecture/PERSISTENCE.md) and
  [recovery](docs/architecture/RECOVERY.md)
- [Agents](docs/architecture/AGENTS.md), [context](docs/architecture/CONTEXT.md),
  [OCF](docs/architecture/OCF.md), and [protocol](docs/architecture/PROTOCOL.md)
- [Contributing](CONTRIBUTING.md), [security reporting](SECURITY.md), and
  [migration](MIGRATION.md)
- [Donor provenance](docs/donors/DONOR_LOCK.md) and
  [third-party notices](THIRD_PARTY_NOTICES.md)

## Known limitations

- The CLI includes a local daemon entrypoint, but this checkout does not
  promise a managed installer, multi-user service, or cloud control plane.
- The local execution backend can run commands, but it is not a container or
  VM isolation boundary. Sandbox profiles express and assess policy; the host
  must provide any stronger enforcement.
- MCP and LSP use declarative, supervised process/transport boundaries. The
  project does not bundle arbitrary plug-in/module loading or LSP server
  binaries. A managed OAuth flow is not advertised as complete in this source
  tree.
- The semantic index is currently a deterministic lexical, vector-ready
  service rather than a bundled embedding database.

These limitations are intentional disclosures, not silent fallbacks. Track
changes in [CHANGELOG.md](CHANGELOG.md).

## License and provenance

Ottili Coder is independently implemented and licensed under
[Apache-2.0](LICENSE). Research donors are pinned and documented. No Claude
Code snapshot source was copied, and donor repositories are not embedded in
this product repository. See [REBUILD_REPORT.md](REBUILD_REPORT.md) for the
rebuild record.
