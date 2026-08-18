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
