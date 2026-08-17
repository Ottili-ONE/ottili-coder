# Architecture Synthesis

## Governing invariant

`Mission → Run → Goal / Task Graph / Agent Graph → Agent → SessionEpoch → LLM Turn`

The Run is durable truth. No client connection, daemon process, worker, model
response, session, or context window is allowed to terminate it implicitly.

## Product layers

```text
CLI / SDK / future clients
        │ versioned HTTP + sequenced SSE
        ▼
Daemon server (authentication, command ingress, event stream)
        ▼
Control plane (Run commands, scheduler, leases, budgets, locks, completion)
        ▼
Runtime (provider sessions, tools, retries, compaction, epochs)
        ▼
Workspace / recovery / context / validation adapters
        ▼
SQLite WAL: append-only events + normalized materialized projections
```

## Ownership and recovery

One daemon/executor acquires a renewable, monotonic Run lease. Every event,
projection update, command receipt, scheduled action, and side-effect dispatch
is conditional on that fencing epoch. A stale executor cannot mutate Run state
or dispatch effects after takeover. The event journal is authoritative;
projections are rehydratable. Each action intent gets a durable terminal result
or `EffectUnknown`, which prevents unsafe blind replay.

## Completion

An implementer may only propose completion. The control plane requires every
mandatory requirement to be proven, deterministic validations to pass, and an
independent verifier record. An optional judge/critic adds assessment but
cannot override deterministic failure.

## Package boundaries

- `protocol`: wire DTOs and schemas.
- `core`: IDs, domain state machines, errors, policies, ports.
- `control-plane`: migrations, event transactions, scheduler, budgets/leases.
- `runtime`: provider/tool loop, retries, session epochs.
- `agents`, `validation`, `recovery`, `workspace`, `context`, `context-format`:
  dedicated domain services over lower contracts.
- `server`: HTTP/SSE adapter; `sdk`: client; `apps/cli`: thin client only.
- `integrations`: Ottili Auth/AI/Cloud/config import boundaries.

## Initial vertical slice

The first implementation proves the non-negotiable behavior with a scripted
provider and controlled tools: create Mission/Run/Goal → daemon owns it → goal
continues automatically → tool/file edit/validation events persist → unproven
requirements reject completion → CLI can detach and reconnect → restart can
rehydrate/continue through a fenced lease.
