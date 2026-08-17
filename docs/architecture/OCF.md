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
Use the root benchmark command when available:

```sh
pnpm bench
```

Record measurements, input corpus, profile, and comparison method in the
durable validation log. Do not quote token savings without the exact measured
fixture and result.
