# OCF/1 Context Format

## Purpose

OCF is a compact, deterministic format for structured context records. It is
used where regular JSON would be unnecessarily verbose while a human-readable,
schema-governed stream is still useful for debugging and testing.

OCF is not a general-purpose executable serialization format. It accepts only
serializable values and validates every field against a registered schema.

## Wire shape

An OCF/1 stream starts with a profile/shape line and a schema declaration:

```text
!ocf/1|compact|collection
@task/1=id,s,title,flags
task|T1|R|Fix scheduler|["durable","sqlite"]
```

The exact field aliases come from the schema. Values can be scalars, lists, or
objects subject to the OCF value grammar. Invalid headers, blank lines,
unbalanced values, unknown schemas, wrong versions, and field mismatches are
parse errors rather than best-effort guesses.

## Profiles

| Profile  | Aim                                                          |
| -------- | ------------------------------------------------------------ |
| readable | Favor descriptive field names.                               |
| compact  | Use compact schema field aliases.                            |
| dense    | Use numeric schema IDs and compact aliases where registered. |

Selection is explicit and deterministic. A decoder sees the profile in the
stream; profile choice must not change record meaning.

## Schemas and round trips

OcfSchemaRegistry holds schema names, IDs, versions, field names, aliases, and
field types. Encoding validates a plain record before rendering. Decoding
resolves the schema and converts wire aliases back into named fields.

The unit tests cover all profiles, nested values, parse errors, schema
validation, and encode/decode equality. These tests are the source of truth
for supported grammar, rather than a claim of broad compatibility with an
external format.

## Delta mode

OCF delta is implemented for records with a base hash. A delta contains a
base fingerprint and operations. Applying it verifies the base before
producing a target. A mismatched base is rejected so a stale context snapshot
cannot be patched into a different record.

Delta mode is useful for controlled snapshots, not as a substitute for the
event journal. Run events remain the authoritative state-transition record.

## Benchmarking

The benchmark fixture lives at packages/context-format/bench/ocf-benchmark.ts.
Run it directly (the root `pnpm bench` runs a different, whole-workspace
benchmark and does not include this one):

```sh
pnpm --filter @ottili/context-format run bench
```

It compares pretty JSON, minified JSON, a YAML subset, a CSV-like format, and
all three OCF profiles against three record shapes mirroring real durable
structures this project persists, not arbitrary synthetic ones: a task
ledger (id/status/deps/title/evidence, at 20/100/500 records to show how the
comparison scales), a requirement ledger (longer prose descriptions, closer
to what a Requirement's `description` field actually looks like), and an
event log (a nested `payload` object, closer to what a durable `RunEvent`
actually carries). Record measurements, input corpus, profile, and
comparison method in the durable validation log. Do not quote token savings
without the exact measured fixture and result.

## Token estimation

Two different token counters exist for two different purposes, and neither
is a stand-in for the other:

- `estimateTokens` (`packages/context-format/src/value.ts`) is a fast,
  dependency-free lexical heuristic — it is what `RepoMap` and
  `ContextPlanner` call on every context compile, in the hot path that
  enforces a Run's live token budget. Speed and a zero-install footprint
  matter more there than provider-exact precision: a slow or heavy
  tokenizer would slow down every turn of every Run.
- The benchmark additionally counts real `cl100k_base` tokens via
  `tiktoken` (MIT-licensed, a `packages/context-format`-only dev
  dependency — never a runtime dependency of the shipped product) and
  reports `estimatorErrorRatio` (lexical estimate ÷ real count) per format,
  so the estimator's actual accuracy is documented with real comparison
  data rather than asserted. `cl100k_base` is not exact for every provider
  (Anthropic and Google use different, unpublished tokenizers), but it is a
  real, widely-used BPE tokenizer and the only practical fixed point to
  measure against without bundling a heavier, provider-specific dependency
  into every install.

The measured ratio is consistently **greater than 1** across every format in
this fixture (the lexical estimator over-counts, typically by roughly
15–95% depending on how punctuation-dense the format is) — the safer
direction for a budget-enforcement estimator to be wrong in, since
over-estimating trims content before a real provider limit is hit rather
than after.
