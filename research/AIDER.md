# Aider Audit

Pinned donor: `Aider-AI/aider` at
`5dc9490bb35f9729ef2c95d00a19ccd30c26339c` (Apache-2.0).

## Findings

- `aider/repomap.py` is a strong, concrete structural-context reference. It
  collects Tree-sitter definition/reference tags, makes a file-reference to
  definition-file multigraph, boosts active/mentioned files and distinctive
  identifiers, runs personalized PageRank, and renders a deterministic,
  token-budgeted declaration map with special files first.
- Its persistent tags cache uses mtime. Ottili will use content hash, parser
  version, and query version cache keys; support changed/deleted-file
  invalidation; preserve lexical fallback when a grammar is unavailable.
- `aider/repo.py` contains useful one-worktree validation, diff/status, and
  scoped commit concepts. Its dirty-file helper omits untracked files, so
  Ottili will use NUL-safe porcelain v2 including `??`, rename/copy states,
  index state, and worktree identity.
- `aider/commands.py` and `aider/coders/base_coder.py` show safety gates for
  session-local undo, but it is not transactional and can leave partial
  checkout. Ottili will checkpoint a pre-state and use a verified Git
  transaction/private checkpoint restore instead.
- `aider/voice.py` models voice correctly as optional client ingress:
  capture → transcription → normal prompt. Ottili will keep voice outside the
  durable runtime and never fail a Run because audio fails.

## Decisions

| Area                                | Decision                | Important donor paths/tests                       |
| ----------------------------------- | ----------------------- | ------------------------------------------------- |
| Structural RepoMap graph/ranking    | REIMPLEMENT algorithm   | `aider/repomap.py`, `tests/basic/test_repomap.py` |
| Tag cache                           | ADAPT then strengthen   | `repomap.py` cache paths/logic                    |
| Git worktree/status/commit concepts | ADAPT                   | `aider/repo.py`, repo tests                       |
| Undo                                | REWRITE transactionally | `aider/commands.py`, `base_coder.py`              |
| Checkpoint format                   | DROP as source          | Aider only tracks session commits                 |
| Voice                               | ADAPT client boundary   | `aider/voice.py`, voice tests                     |

## Ottili implementation target

`RepoMapService.build` will return rendered text, selected entries, token count,
staleness, and diagnostics. It will be usable without embeddings. Git changes
will be attributed with Run/Agent/Task/Checkpoint metadata, never global
environment mutation. No Aider source is copied by this audit.
