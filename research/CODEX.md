# OpenAI Codex Audit

Pinned donor: `openai/codex` at
`32a383c0ba5ed42a1adc3f2084014895bfe7738c` (Apache-2.0).

## Findings

- A durable goal is separate from live execution in
  `codex-rs/state/src/model/thread_goal.rs`,
  `state/src/runtime/goals.rs`, `ext/goal/src/runtime.rs`, and
  `ext/goal/src/api.rs`. Every replacement receives a new goal identity so a
  stale turn cannot update a newer goal. Ottili will apply this as `goal_version`
  conditional updates within a Run transaction.
- `ext/goal/src/extension.rs` starts continuation on lifecycle idle, while
  `ext/goal/src/runtime.rs` serializes it and re-reads state before starting a
  turn. Ottili will implement an equivalent durable scheduler claim rather than
  a UI or LLM-text heuristic.
- `state/goals_migrations/0002_thread_goal_continuation_deferrals.sql` shows
  that continuation deferral is durable state, not an in-memory flag. Ottili
  will persist deferral/wake state.
- `ext/goal/src/accounting.rs` charges deltas at several lifecycle boundaries,
  and `state/src/runtime/goals.rs` atomically transitions a goal at limits.
  Ottili will record idempotent usage events keyed by Run epoch/turn/meter
  sequence to avoid charging cumulative provider totals repeatedly.
- `agent-graph-store/src/{store,types,local}.rs` and
  `state/migrations/0021_thread_spawn_edges.sql` persist directed parent-child
  relationships and deterministic traversal. Ottili will retain a separate
  durable Agent Graph rather than tie topology to worker memory.
- `rollout/src/{recorder,policy,ordinal}.rs` demonstrates ordered durable
  records and explicit flush failure. Ottili will use a transactional database
  event/outbox rather than a JSONL-only record.
- `sandboxing/src/manager.rs`, `core/src/sandboxing/mod.rs`, and
  `core/src/tools/sandboxing.rs` demonstrate that policy, platform argv
  transformation, and approval are distinct concerns.

## Decisions

| Area                      | Decision                             | Important donor paths/tests                                               |
| ------------------------- | ------------------------------------ | ------------------------------------------------------------------------- |
| Goal identity/version CAS | ADAPT concept                        | `state/src/{model/thread_goal,runtime/goals}.rs`                          |
| Idle continuation         | ADAPT then REWRITE durable scheduler | `ext/goal/src/{extension,runtime}.rs`                                     |
| Budget accounting         | ADAPT concept                        | `ext/goal/src/accounting.rs`                                              |
| Blocked semantics         | REWRITE                              | donor only supplies prompt guidance; enforce persistent repeated blockers |
| Agent graph               | ADAPT model                          | `agent-graph-store/*`, `state/migrations/0021_thread_spawn_edges.sql`     |
| Events/replay             | ADAPT model                          | `rollout/{recorder,policy,ordinal}.rs`                                    |
| Lease/fencing             | REWRITE                              | listener generation is process-local only                                 |
| Sandbox policy            | ADAPT                                | `sandboxing/*`, `core/src/sandboxing/*`                                   |

## Required differences

Codex models one Goal per Thread and may transition a Goal directly to blocked
on non-retryable turn error. Ottili requires Mission → Run → Goal/Task Graph,
explicit `waiting_external`, a persisted repeated-blocker audit, renewable
cross-process leases, and completion evidence. The implementation will use the
architecture as inspiration and no Codex source is copied by this audit.
