# ADR 0002: Independent Rebuild and Provenance

## Status

Accepted.

## Context

The rebuild research examined OpenCode, Kilo, OpenAI Codex, OpenHands, Cline,
Aider, and the legacy Ottili Coder. Each has different licensing, runtime
assumptions, and technical strengths. An unavailable Claude Code
snapshot/reference has no source reuse authorization.

## Decision

Ottili Coder vNext is independently implemented in a clean Node/pnpm
repository. Research is recorded with pinned donor commits and a decision
matrix. Donor source is not embedded in the product repository.

If a future change copies or adapts upstream source, it must identify the
exact file/path, pinned commit, license, notices, and transformation in
THIRD_PARTY_NOTICES.md before release. The Claude reference is categorically
excluded from source reuse.

## Consequences

- Concepts can be adopted while runtime/package identities remain Ottili-native.
- License review occurs at an actual source-reuse boundary, not only at audit
  time.
- The product must not be presented as an official donor project.
- Documentation makes the difference between inspiration and copied code
  visible to users and contributors.
