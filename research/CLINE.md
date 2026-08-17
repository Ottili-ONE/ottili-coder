# Cline Audit

Pinned donor: `cline/cline` at
`041afb718bcdfe50eabd90d060e5335ef98e2d16` (Apache-2.0).

## Findings

- `sdk/packages/core/src/hooks/checkpoint-hooks.ts` establishes the right
  checkpoint timing: capture before a root-run model/tool cycle, identify a
  checkpoint by semantic user-run rather than fragile message position, and
  deduplicate using durable history after restart.
- The donor uses a non-invasive Git snapshot: `git stash create` for tracked
  state plus a temporary index/NUL pathspec commit for nonignored untracked
  files, retained below private `refs/cline/checkpoints/...`. This is a strong
  Git implementation reference, not Ottili's canonical checkpoint format.
- `checkpoint-restore.ts` validates refs before destructive work, captures a
  recoverable pre-state, restores workspace, and rolls back on later failure.
  It deliberately warns the user that successful workspace restore can use
  `git clean -fd`; Ottili must make deletion scope explicit and policy gated.
- `session-versioning-service.ts` has useful snapshot-before-replace and
  ref-retention-on-fork patterns. `local-runtime-host.ts` demonstrates that
  resumed/forked state persists immediately while transient empty sessions can
  remain memory-only.
- Cline's completion guard is not sufficient for Ottili: its agent runtime
  guards only a no-tool completion path, so a terminal tool may bypass it.
  Ottili's control-plane Completion Gate must always execute independently.

## Decisions

| Area | Decision | Important donor paths/tests |
| --- | --- | --- |
| Root checkpoint timing/semantic numbering | ADAPT | `checkpoint-hooks.ts`, hook tests |
| Git tracked/untracked capture | ADAPT implementation pattern | `checkpoint-hooks.ts` |
| Restore transaction | ADAPT then REWRITE API | `checkpoint-restore.ts`, versioning tests |
| Checkpoint canonical storage | REWRITE | Use durable metadata/CAS plus Git optimization |
| Successful destructive restore UX | REWRITE | Explicit impact/policy/approval requirements |
| Completion guard | DROP as authority | `agents/src/agent-runtime.ts` |

## Provenance boundary

No Cline source is copied by this audit. Tests to independently reproduce
include invalid-reference non-destructiveness, tracked/untracked restore,
created-after-checkpoint deletion policy, ignored-file preservation, and every
restore-stage rollback.
