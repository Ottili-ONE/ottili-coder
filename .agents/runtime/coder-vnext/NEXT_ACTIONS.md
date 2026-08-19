# Next Actions

This session closed nearly every remaining open requirement with direct
evidence: MCP/LSP/worktree/checkpoint composition into the live runtime
(including workspace-only checkpoint restore), R45–R49 (managed-auth
wiring, BYOK/managed provider round trips, deleting confirmed-dead
`packages/integrations/src/provider.ts`, deterministic remote/hybrid
backend contracts), R51 (`ottili-coder models`/`ottili-coder mcp` CLI
commands, `action.yml` — a real composite GitHub Action self-tested by a
CI job that actually invokes it), R34 (OCF benchmark expanded to
representative datasets plus a real tokenizer comparison), R60
(confirmed the shipped product has zero third-party runtime
dependencies and its devDependency tree has no copyleft license), R61 (a
full documentation-to-implementation audit found and fixed 6 real
discrepancies), and a provenance/security audit pass (found and fixed
one real advisory, `KP-038`). Full detail and evidence for every item is
in `VALIDATION_LOG.md`, `KNOWN_PROBLEMS.md`, and `DECISIONS.md`
(ADR-017 through ADR-024). GitHub Actions has confirmed green on every
substantive commit through run 32298325087 (commit `856978f`); the
`esbuild` bump (`KP-038`) has not yet been pushed/re-confirmed on CI as
of this revision. Do not declare `TRUE_COMPLETE` while any item below
remains open.

1. Push the `esbuild` bump (`KP-038`) and re-confirm cross-platform CI.
2. Rerun the full root matrix (`pnpm install --frozen-lockfile`, lint,
   format:check, check:eol, check:boundaries, typecheck, test,
   test:integration, test:recovery, test:e2e, build, test:package, bench)
   plus a re-confirmed green cross-platform GitHub Actions matrix
   (including `action-smoke`) on the actual final commit before
   reconsidering `TRUE_COMPLETE`.

## Deliberately open, not neglected

- **`KP-024`** (`store.ts` still a single ~3000-line module): a partial
  decomposition already happened this session (ADR-014); further
  splitting risks the transactional-fencing invariants that decomposition
  proved. Pick up alongside `KP-035` if a dependency-graph refactor is
  ever undertaken.
- **`KP-032`** (an unreproduced one-off `LeaseFencedError` on an unrelated
  doc-only commit): has not recurred across every subsequent CI run this
  session. If it recurs, capture full evidence before attempting a fix
  rather than guessing.
- **`KP-035`** / **R48** (`LocalExecutionBackend` is not `execute_command`'s
  live implementation): composing it in would regress the Windows/output-
  safety hardening `execute_command` already has; needs a dependency-graph
  decision (a shared low-level process-exec package) first. Not scheduled
  until that decision is made.
- **`KP-037`** (OCF's codec is not composed into `RunContextCompiler`'s
  live output): needs live-model access to validate whether a real
  provider parses OCF's compact/dense syntax as reliably as JSON on the
  highest-consequence payload in the system, or a conservative first step
  with an explicit before/after mission-outcome comparison. Not scheduled
  until one of those is possible.
- **R51's OAuth gap** (interactive Ottili-Auth login): needs a live
  external Ottili Auth service this environment cannot reach. Not
  scheduled until that access exists.
- **R53/R55** (full server-API/full SDK-surface error-path coverage): not
  bounded targets the way R54/R56 were. Keep narrowing opportunistically,
  not as a discrete task.
- A future increment could extend checkpoint restore beyond workspace-only
  (full point-in-time Task/Agent Graph reconstruction via event replay),
  deliberately left out of ADR-021's scope as materially larger.
