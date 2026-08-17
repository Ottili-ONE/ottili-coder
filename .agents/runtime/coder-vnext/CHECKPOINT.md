# Ottili Coder vNext — Durable Checkpoint

## Mission

Build the independent, Node-based, open-source Ottili Coder vNext CLI, daemon,
and durable long-horizon execution runtime described in the rebuild mission.

## Current stop level

ACTIVE — no terminal stop level has been reached.

## Current milestone

M2: Node/pnpm monorepo and durable control-plane foundation.

## Completed milestones

- Created a clean workspace separated from all donors.
- Initialized an independent Git repository on branch `main`.
- Cloned and pinned all accessible required donor repositories.
- Recorded unavailable reference/platform donors without treating them as blockers.
- Completed parallel, read-only initial donor/architecture/repository audits.
- Synthesized donor, provenance, port, and architecture matrices.

## Open milestones

- Establish the strict Node/pnpm monorepo and test foundation.
- Build durable control plane, runtime, recovery, context, server, CLI, and integrations.
- Execute full validation, fresh audits, and final report.

## Active implementation

Establishing the strict Node/pnpm workspace, package boundaries, and unit-test
foundation before the daemon/control-plane vertical slice.

## Active validation

Workspace separation, donor pinning, license inspection, and research
synthesis completed. Node's SQLite API has been verified in the local Node 24
runtime. No product build/test command has run yet.

## Current blockers

None. The Claude Code research archive and optional Ottili ONE platform
repository require unavailable GitHub authentication; both are explicitly
non-blocking and are documented in `DONOR_STATUS.md`.

## Current assumptions

- Product source root is this repository, not any donor.
- Node 24.19.0 at `/opt/node24/bin/node` is the supported local development
  runtime because system Node 20 cannot execute the installed pnpm version.
- SQLite will initially use Node's supported `node:sqlite` API, retaining a
  clear persistence port for Postgres.

## Latest important commands/results

- `git init …/ottili-coder-vnext` — succeeded; independent repository created.
- `git -C sources/opencode checkout -B research/opencode-v1.18.18 v1.18.18`
  — succeeded at `31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d`.
- donor `LICENSE` header inspection — all accessible donor licenses recorded.
- `/opt/node24/bin/node --version` — `v24.19.0` available.
- Node SQLite in-memory create/insert/select probe — succeeded with `ok`.

## Exact resume action

Read this file, `REQUIREMENTS.md`, and `NEXT_ACTIONS.md`; then implement the
Node/pnpm foundation and durable control-plane vertical slice.
