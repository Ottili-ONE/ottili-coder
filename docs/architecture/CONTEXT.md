# Context Architecture

## Principle

Context is selected evidence, not an ever-growing chat transcript. The context
layer separates fixed mission/policy material from dynamic retrieval so a Run
can start a fresh SessionEpoch without losing its durable state.

## RepoMap

RepoMap creates a deterministic structural summary of source files. It extracts
language-shaped symbols with a conservative lexical parser and ranks entries
within a token budget. The current implementation prioritizes stable behavior
and fallback coverage over claiming a full compiler or language server.

The map includes path, symbol shape, exported status, relationships, and
estimated tokens. It is useful for orientation and context planning, but it is
not an authorization or correctness proof about repository code.

## Semantic index

SemanticIndex is an asynchronous, deterministic lexical retrieval service with
a vector-ready boundary. It reports states including idle, indexing, ready,
unavailable, and failed. Search results include scored path/chunk metadata.

The initial implementation does not bundle an embedding model, vector database,
or remote index service. Its lexical fallback is intentional and should remain
usable when an optional semantic backend is unavailable.

## Project memory

ProjectMemory keeps candidate observations separate from promoted memory.
Promotion carries scope, confidence, source evidence, and policy checks. Recall
is scored and bounded.

The memory layer redacts common secret-like patterns before retaining content.
Redaction reduces accidental exposure; it is not a replacement for a dedicated
secret-management system or a guarantee that every secret syntax is detected.
Sensitive provider credentials and bearer tokens should never enter memory.

## Context planning

ContextPlanner receives fixed and ordinary candidates plus a token budget:

1. Fixed items such as mission, goal, and policy are selected first.
2. Dynamic items rank by explicit priority, relevance, and source weight.
3. Items may be bounded or truncated only when the item permits it.
4. Omitted items carry a reason instead of disappearing silently.

This creates a deterministic context plan with selected/omitted records and an
estimated token count. Required content cannot be silently displaced by a
large, low-value search result.

## Persistence boundary

The context package provides domain services. The control plane decides which
context snapshot references to persist for a Run or checkpoint. Do not place
unbounded raw files, provider credentials, or private tool output in an event
payload merely to make a later prompt convenient.

For compact transport and snapshot formats, see [OCF](OCF.md).
