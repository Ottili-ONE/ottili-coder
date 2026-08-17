# OpenHands and OpenHands SDK Audit

Pinned donors: `OpenHands/OpenHands` at
`6670b4726a81fc73e797a193dae86264857a663d` and
`OpenHands/software-agent-sdk` at
`b56221283f74dbced26d1da134ded26860bb4f14` (MIT).

## Findings

- The SDK's `conversation/event_store.py` stores immutable append-only events
  and validates duplicates/parents. `conversation/state.py` maintains a
  rebuildable head snapshot and branch replay. Ottili will use an ordered SQL
  event journal with parent/causation links and rebuild projections after a
  crash rather than trust a snapshot head alone.
- `agent_server/conversation_lease.py` models owner, monotonic generation, TTL,
  host, PID, renewal, and guarded writes. `event_service.py` applies it to
  events/state. Ottili will retain the semantics with database CAS leases,
  fencing every state/outbox mutation and tool dispatch; it will additionally
  stop execution after lease loss.
- The SDK identifies unmatched action intents and turns possibly interrupted
  actions into durable errors. Ottili will require each action intent to reach
  `Succeeded`, `Rejected`, `Failed`, or `EffectUnknown`; only idempotent,
  reconciled effects may retry after recovery.
- `workspace/base.py` and remote workspace adapters form a useful execution
  backend contract with output cursors and de-duplication. Ottili will define
  a persisted backend state machine and retain references/health/output cursor,
  never raw credentials.
- `conversation/goal/{controller,judge}.py` and critic integrations distinguish
  loop/judge/quality concerns, but donor LLM judge acceptance and fail-open
  critic cannot override deterministic validation. Ottili will store evaluator
  version/prompt hash/evidence separately and use a mandatory Completion Gate.
- Canvas event stores provide useful client de-duplication and history/live
  merge patterns. Ottili SSE ordering will use durable sequence IDs, not
  timestamps.

## Decisions

| Area                       | Decision                            | Important donor paths/tests                |
| -------------------------- | ----------------------------------- | ------------------------------------------ |
| Event journal/projections  | ADAPT semantic pattern              | SDK `conversation/{event_store,state}.py`  |
| Branch/replay              | ADAPT                               | `local_conversation.py`, event-tree tests  |
| Leases/fencing             | ADAPT then strengthen               | `conversation_lease.py`, contention tests  |
| Unfinished side effects    | ADAPT                               | `state.py`, `event_service.py`             |
| Execution backend contract | ADAPT                               | `workspace/{base,remote}/*`                |
| Goal judge/critic          | ADAPT interfaces; REWRITE authority | `goal/*`, critic tests                     |
| File-lock/JSON storage     | DROP                                | unsuitable as distributed Run coordination |

## Provenance boundary

No OpenHands source is copied by this audit. Independent Ottili tests must
cover append/projection crash gaps, invalid parent rejection, lease takeover,
stale executor rejection, unmatched side effect reconciliation, exactly-once
continuation, and ordered reconnect.
