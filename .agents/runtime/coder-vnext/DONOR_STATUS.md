# Donor / Repository Knowledge Cache (WUID)

This is the durable, task-local cache of everything learned from the external
and legacy repositories during the vNext rebuild. It is deliberately more
operational than the research reports: use it to decide whether a future change
may borrow a _concept_, must be rewritten, or must not reuse a donor at all.

The canonical long-form evidence remains in `research/`; this file preserves
the decision-relevant knowledge even if an agent is resumed without its prior
conversation context. Donor clones are sibling research worktrees, never part
of the product Git history.

## Global rules learned from all donors

1. **A Run, not a chat/session, is the durable unit.** A CLI, SSE connection,
   daemon process, model context window, PTY, or provider request may disappear
   without ending a Run.
2. **The daemon/control plane is the source of truth.** It owns SQLite events,
   normalized projections, idempotency receipts, budgets, scheduler state,
   leases, checkpoints, and approval records. CLI and SDK are HTTP/SSE clients
   only.
3. **Every executor-owned mutation and side effect needs a renewable,
   monotonic fencing generation.** In-memory locks, process-local drains, a
   PID, and a best-effort health check are insufficient after takeover/restart.
4. **Tool calls require intent-before-effect and a terminal outcome.** An
   unmatched intent becomes reconciliation/manual recovery, never blind replay.
   Policy, sandbox, resource locks, approval, budget, and idempotency are all
   evaluated before an effect.
5. **Completion cannot be a model assertion or terminal tool shortcut.** The
   durable requirement/evidence ledger plus independent validation/verifier
   decide terminal completion inside the Store transaction.
6. **Git and context artifacts are optimizations, not durable truth.** Capture
   workspace state transactionally; treat compaction/RepoMap/memory/indexes as
   derived, bounded, provenance-bearing context.
7. **No donor is a product base.** Reuse is selective and provenance-gated;
   donor branding, cloud assumptions, auto-plugin loading, Bun/OpenTUI runtime
   coupling, and session-local recovery are excluded.

## Pin, license, and intended-use ledger

| Repository                                     | Audit pin / status                                     | License    | Retained role                                                            | Non-negotiable boundary                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------ | ---------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| OpenCode (`anomalyco/opencode`)                | `v1.18.18`, `31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d` | MIT        | Provider/tool/event/retry/MCP/LSP/Git concepts and tests                 | Never make its Bun build/runtime, cloud branding, or auto-plugin loader a vNext dependency.                      |
| Kilo Code (`Kilo-Org/kilocode`)                | `91a337e31cd7675d680aeb13c92870b8f81bdf36`             | MIT        | Index, memory redaction, sandbox profile, daemon-hygiene concepts        | Its UI/cache/session state is not durable Run truth; platform sandbox support is incomplete.                     |
| OpenAI Codex (`openai/codex`)                  | `32a383c0ba5ed42a1adc3f2084014895bfe7738c`             | Apache-2.0 | Goal versioning, idle continuation, accounting, graph, sandbox patterns  | One Goal/Thread and local listener generation are not sufficient Mission/Run leases.                             |
| OpenHands (`OpenHands/OpenHands`)              | `6670b4726a81fc73e797a193dae86264857a663d`             | MIT        | Event/branch replay, backend/judge interfaces                            | File-lock/JSON coordination and LLM judge authority are not vNext control-plane truth.                           |
| OpenHands SDK (`OpenHands/software-agent-sdk`) | `b56221283f74dbced26d1da134ded26860bb4f14`             | MIT        | Lease/generation, unmatched-action recovery, workspace contracts         | Strengthen to SQLite CAS/fencing; do not copy its storage model as distributed coordination.                     |
| Cline (`cline/cline`)                          | `041afb718bcdfe50eabd90d060e5335ef98e2d16`             | Apache-2.0 | Root checkpoint timing, non-invasive Git capture, transactional restore  | Git stash object tricks are not the canonical checkpoint format; terminal-tool completion guard is insufficient. |
| Aider (`Aider-AI/aider`)                       | `5dc9490bb35f9729ef2c95d00a19ccd30c26339c`             | Apache-2.0 | RepoMap algorithm, Git/worktree UX, voice ingress boundary               | Reimplement algorithms; mtime cache, incomplete untracked handling, and partial undo are not acceptable.         |
| Current Ottili Coder (`Ottili-ONE/coder-cli`)  | `7bcd1a2a6ee1880112f06b39221ffe9c6cfe44eb`             | MIT        | Legacy UX, roles, config, Ottili-provider, MCP/LSP and regression corpus | Bun/OpenTUI/OpenCode-shaped mixed V1/V2 monolith is a donor, never the base.                                     |
| Claude Code snapshot (`MurrayTom/claude-code`) | unavailable; authentication required                   | unknown    | Reference-only architecture context                                      | **No source reuse.** The unavailable clone is not a blocker.                                                     |
| Ottili ONE platform (`Ottili-ONE/ottilionev1`) | unavailable; authentication required                   | unknown    | Optional managed-service contract context                                | No source reuse planned; local OSS/BYOK must remain independent.                                                 |

## Per-repository retained knowledge

### OpenCode

- **Take/adapt:** normalized provider model capabilities/limits/costs, typed
  stream events, tool-call identity and output truncation, permission concepts,
  retry classification (`Retry-After` plus jitter), transcript-tail compaction,
  MCP/LSP transport/catalog ideas, and Git/worktree/snapshot safety tests.
- **Rewrite:** Node-native provider registration/auth, durable Mission/Run
  scheduler, durable retry/failover, sandboxed tool executor, MCP/LSP/PTY
  supervision, and run-owned worktree lifecycle.
- **Drop:** Bun build/runtime/import-map assumptions, OpenCode cloud/Go
  branding, upsell headers, runtime package/plugin installation, arbitrary
  repository tool auto-load, and process-local session drains.
- **Specific caution:** donor event append/projection and idempotent prompt
  admission are useful, but its `claim()` is not a renewable fenced lease and
  its documented post-crash continuation remains incomplete.
- **Evidence:** `research/OPENCode.md`; donor paths include
  `src/provider/provider.ts`, `src/session/{llm,retry,compaction}.ts`,
  `src/{mcp,lsp,git,worktree,snapshot}/`.

### Kilo Code

- **Take/adapt:** Tree-sitter plus deterministic fallback chunking, content
  hash cache and atomic replacement, worktree index overlay, bounded memory
  injection, project identity across worktrees, secret-like-content redaction,
  sandbox profiles/canonical paths/network proxy ideas, and restrictive daemon
  state-file/health/version discipline.
- **Rewrite:** index job persistence, hybrid retrieval/reranking/freshness and
  provenance, structured/evidence-backed memory, durable recovery, and daemon
  ownership with transactional leases/fences.
- **Drop:** VS Code Agent Manager as runtime architecture, cache/index as
  source of truth, plaintext/URL credential shortcuts, and any claim of
  universal sandbox support (Windows is intentionally unsupported by donor).
- **Specific caution:** Kilo's vector search is cache-oriented, its Markdown
  memory uses simple term overlap, and health/version checks do not replace
  Run recovery.
- **Evidence:** `research/KILO.md`; key donor areas are `kilo-indexing`,
  `kilo-memory`, `kilo-sandbox`, and `kilocode/daemon`.

### OpenAI Codex

- **Take/adapt:** immutable goal versions/CAS to stop stale turns charging or
  mutating a replacement, idle-triggered continuation, persisted deferral,
  delta-based accounting, directed parent/child Agent Graph and deterministic
  traversal, ordered durable rollout records, and policy/approval separation.
- **Rewrite:** map the pattern to Mission → Run → Goal/Task/Agent graphs;
  database scheduler claims and cross-process Run epochs; persistent blocker
  fingerprints/consecutive-count policy; and full sandbox executor fences.
- **Drop/avoid:** treating its three-turn blocker prompt guidance as enforced
  policy, direct `blocked` on one non-retryable turn error, one-goal-per-thread
  schema, and process-local listener generation as a lease substitute.
- **Specific caution:** account usage deltas exactly once by
  `(runEpoch, turnId, meterSequence)`-like identity, not cumulative provider
  totals.
- **Evidence:** `research/CODEX.md`; relevant areas include `state`,
  `ext/goal`, `agent-graph-store`, `rollout`, and `sandboxing`.

### OpenHands and OpenHands SDK

- **Take/adapt:** append-only event log plus rebuildable snapshot/branch replay,
  lease owner/generation/TTL/renewal shape, explicit unmatched-action failures,
  backend contracts with output cursors/de-duplication, and judge/critic
  interface separation from deterministic completion authority.
- **Rewrite:** SQLite event/outbox implementation, CAS lease fencing at every
  write/effect boundary, persisted backend state, and evaluator evidence/version
  records.
- **Drop:** FileLock/JSON storage as control-plane coordination and a fail-open
  LLM critic as a completion authority.
- **Specific caution:** recovery must write an `EffectUnknown`-style durable
  result for an unmatched action; replay only after idempotency/reconciliation.
- **Evidence:** `research/OPENHANDS.md`; SDK donor paths include
  `conversation/{event_store,state,conversation_lease}.py` and workspace
  backends.

### Cline

- **Take/adapt:** capture before the root model/tool cycle, semantic user-run
  checkpoint numbering, restart dedupe, tracked plus untracked Git capture,
  private checkpoint ref retention, validate-before-mutate restore, emergency
  pre-state capture, and rollback if a later restore/fork step fails.
- **Rewrite:** checkpoint API/storage independent of Git, explicit
  tracked/untracked/deletion policy and impact preview, audit journal,
  multi-root/non-Git behavior, and completion verification at every terminal
  path.
- **Drop:** raw stash-shaped object format as application state, unchecked
  `git clean -fd` semantics, raw private refs as public IDs, and its completion
  guard as terminal authority.
- **Specific caution:** a successful restore can delete nonignored untracked
  files; this needs explicit user/policy scope even when rollback protects a
  failed transaction.
- **Evidence:** `research/CLINE.md`; key donor files are
  `checkpoint-hooks.ts`, `checkpoint-restore.ts`, and
  `session-versioning-service.ts`.

### Aider

- **Take/adapt:** Tree-sitter tags, reference-to-definition graph ranking,
  active-file/mentioned-symbol boosts, personalized PageRank, deterministic
  token-budget rendering, special project files, lexical fallback, one-worktree
  validation, porcelain-v2 status concepts, and optional client-side voice
  ingress.
- **Rewrite:** cache key from content hash/parser/query version rather than
  mtime, hybrid/provenance-aware context retrieval, NUL-safe complete dirty
  state including untracked/rename/copy/index, transactional Git rollback, and
  Run/Agent/Task attribution.
- **Drop:** session-local commit list as checkpoint authority and partial
  checkout/soft-reset undo as a generic recovery mechanism.
- **Specific caution:** Aider's dirty helper omits untracked files and its undo
  can leave a partial state. Voice failures must remain non-fatal client input
  failures, never Run failures.
- **Evidence:** `research/AIDER.md`; key donor paths are `aider/repomap.py`,
  `aider/repo.py`, `aider/commands.py`, and `aider/voice.py`.

### Current Ottili Coder

- **Port selectively:** public `ottili-coder` identity; run/attach/resume,
  JSON/headless UX; Build/Plan/Debug/Ask intent as role/policy data; config
  precedence/migration fixtures; provider/Ottili adapter boundary; MCP/LSP
  protocol mechanics; GitHub/cloud request/mock concepts; snapshot/diff UX.
- **Redesign:** all full-run/task-graph JSON experiments into SQL Run state;
  in-process server/client lifecycle into one versioned daemon API; checkpoint
  and crash resume into transactional Run recovery; remote/cloud into explicit
  Local/Remote/Hybrid backend contracts; and config migration into preview-first
  non-destructive import under `~/.ottili/coder`.
- **Drop:** Bun/OpenTUI and `@opencode-ai/*` dependencies, OpenCode
  compatibility names as canonical behavior, unconditional process exit,
  default in-process HTTP application, secret scanning/loading in
  `ottili-auto`, dynamic LSP tool download at core startup, legacy cloud job as
  durable local Run truth, and hard-wired GitHub child-server port/process
  lifetime.
- **Specific caution:** legacy `fullrun`/`taskgraph` are unintegrated
  file-backed experiments; `ottili-auto` provider mappings can diverge; legacy
  MCP auth storage is not an encrypted credential vault.
- **Evidence:** `research/CURRENT_CODER.md` and `research/PORT_MATRIX.md`.

## Cross-donor implementation map

| vNext concern            | Best donor knowledge            | Required Ottili-native change                                                                     |
| ------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------- |
| Provider/tool loop       | OpenCode + Current Coder + Kilo | Node-only adapters, durable attempts/budgets/fences and policy-gated effects.                     |
| Goal continuation/agents | Codex + Current Coder           | DB scheduler claim, durable graph, goal version CAS and blocker policy.                           |
| Events/leases/recovery   | OpenHands SDK + OpenCode        | SQLite event journal/projections/outbox, renewable lease and unknown-effect recovery.             |
| Checkpoints/Git          | Cline + Aider + OpenCode        | Private refs as optimization, transactional restore, user-dirt protection and worktree ownership. |
| RepoMap/context/memory   | Aider + Kilo                    | Deterministic bounded structural map, lexical fallback, provenance/redaction and durable memory.  |
| Sandbox/policy           | Kilo + Codex + OpenCode         | Typed capabilities, approval and host capability detection; no false isolation claim.             |
| MCP/LSP                  | OpenCode + Current Coder        | Supervised restartable adapters with credential, egress and recovery policy.                      |
| CLI/API/config           | Current Coder + OpenCode        | Thin client over typed HTTP/SSE, preview-only migration, no session ownership.                    |

## Provenance and reuse procedure

- This rebuild intentionally uses independently written TypeScript. No donor
  source was copied wholesale, and there are no donor repositories in the
  product tree.
- Before copying or substantially adapting code, record the exact donor URL,
  commit, path, copyright header, license, rationale, and date in
  `THIRD_PARTY_NOTICES.md` and the relevant decision record. Preserve required
  MIT/Apache notices.
- Do not copy generated binaries, vendor patches, model catalogs, cloud auth,
  branding/upsell strings, arbitrary plugin execution paths, or source from the
  unavailable Claude/Ottili ONE repositories.
- Audit transitive dependency licenses independently before a release. The
  presence of an MIT/Apache donor pin is not a complete redistribution audit.

## Canonical source pointers and local research locations

| Need                       | Durable report                                        | Local clone / status                                                                   |
| -------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Donor URLs, pins, licenses | `research/DONOR_LOCK.md`                              | `/root/ottili-coder-dev/ottili-coder-vnext-workspace/sources/` sibling research clones |
| Design/port decisions      | `research/DONOR_MATRIX.md`, `research/PORT_MATRIX.md` | See individual reports below                                                           |
| OpenCode                   | `research/OPENCode.md`                                | `sources/opencode-v1.18.18` at the pinned tag                                          |
| Kilo                       | `research/KILO.md`                                    | `sources/kilo` at its pinned commit                                                    |
| Codex                      | `research/CODEX.md`                                   | `sources/codex` at its pinned commit                                                   |
| OpenHands / SDK            | `research/OPENHANDS.md`                               | `sources/openhands`, `sources/openhands-sdk`                                           |
| Cline                      | `research/CLINE.md`                                   | `sources/cline`                                                                        |
| Aider                      | `research/AIDER.md`                                   | `sources/aider`                                                                        |
| Current Ottili Coder       | `research/CURRENT_CODER.md`                           | `sources/ottili-coder-current`                                                         |
| Whole-system synthesis     | `research/ARCHITECTURE_SYNTHESIS.md`                  | independent product implementation                                                     |

## Resume checklist

When resuming this mission or reviewing a future port:

1. Read this file, `REQUIREMENTS.md`, `KNOWN_PROBLEMS.md`, and
   `VALIDATION_LOG.md` first.
2. Read the precise `research/<DONOR>.md` before relying on a donor detail.
3. Treat an implementation as Ottili-native unless an exact reuse entry exists
   in `THIRD_PARTY_NOTICES.md`.
4. Preserve the separation between durable control plane and volatile runtime.
5. Do not upgrade a requirement to `PROVEN` merely because a donor has it;
   require vNext source plus direct vNext validation.
