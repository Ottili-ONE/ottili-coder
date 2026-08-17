# Contributing to Ottili Coder

Thanks for improving Ottili Coder. This is a durable-systems project: a
plausible demo is not enough if recovery, evidence, or ownership semantics are
unclear.

## Development setup

Use Node.js 24+ and pnpm 11.15.1 or compatible versions.

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

Use pnpm format only when you intend to apply formatting changes. The
repository is TypeScript-first and Node-native; do not add a mandatory Bun,
OpenTUI, or donor-runtime dependency without an accepted architecture decision.

## Contribution principles

1. Preserve the boundary between a durable Run and a disposable client.
2. Treat event records, command receipts, leases, checkpoints, and external
   side effects as recovery-sensitive data.
3. Do not add a direct path from an agent response to Run completion. The
   completion gate and an independent verifier must remain authoritative.
4. Do not weaken a permission, sandbox, resource-lock, or tool-recovery
   invariant merely to make a demo easier.
5. Keep public contracts serializable and versioned in packages/protocol.
6. Add deterministic tests for failure paths as well as happy paths.

## Package boundaries

The intended dependency direction is:

```text
protocol → core → runtime → domain services → server → CLI / SDK
```

Context and integrations may use lower contracts where necessary, but must not
create a cycle. core and runtime must not import clients, terminal UI, web, or
desktop code. Run:

```sh
node scripts/check-boundaries.mjs
```

before submitting a dependency-boundary change. Update the script and the
architecture documents when a deliberate new boundary is introduced.

## Tests

Place unit tests under tests/unit, integration tests under tests/integration,
and restart/recovery tests under tests/recovery.

For a durable behavior, tests should normally establish all of the following:

- the pre-crash/pause state is persisted;
- recovery uses a new lease generation or an idempotent receipt;
- a stale actor cannot commit after takeover;
- event sequence is sufficient to reconnect a client;
- uncertain external effects are reconciled rather than blindly retried.

Provider tests must use a controlled fake or local test service. Never place a
real access token in fixtures or test output.

## Documentation and public claims

Update README, architecture documentation, and REBUILD_REPORT.md whenever a
public behavior or limitation changes. Documentation must distinguish:

- implemented and tested behavior;
- a typed extension point;
- a future plan.

Do not describe a policy abstraction as a host-enforced sandbox, an interface
as a deployed cloud service, or an optional verifier as automatic independent
verification.

## Provenance

This project was rebuilt after research of several open-source donors. Research
does not grant blanket copy permission. Before contributing copied or adapted
source, record its exact upstream path, pinned commit, license, and required
notice in THIRD_PARTY_NOTICES.md and docs/donors/. Do not copy source from the
Claude Code snapshot/reference under any circumstances.

## Changes and review

Keep commits focused and explain the durability or safety effect in the change
description. A good pull request includes:

- the problem and the affected invariant;
- tests run, including failure/recovery tests where relevant;
- migration or compatibility impact;
- documentation updates;
- any new dependency, license, or credential-handling impact.

Report security-sensitive findings privately as described in
[SECURITY.md](SECURITY.md), not in a public issue.
