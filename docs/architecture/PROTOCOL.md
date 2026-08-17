# Daemon Protocol v1

## Scope

The protocol is the versioned boundary between durable daemon state and
disposable clients. Contracts live in packages/protocol. Server responses use
a JSON envelope:

```json
{ "ok": true, "value": {} }
```

or:

```json
{
  "ok": false,
  "error": {
    "code": "invalid_request",
    "message": "…",
    "retryable": false
  }
}
```

The current protocol version string is v1. Clients should tolerate additive
response fields and must not assume an unrecognized event type can be safely
treated as a completion signal.

## Routes

| Method | Route                                 | Purpose                                                                        |
| ------ | ------------------------------------- | ------------------------------------------------------------------------------ |
| GET    | /v1/health                            | Liveness and protocol version.                                                 |
| GET    | /v1/ready                             | Daemon readiness.                                                              |
| GET    | /v1/version                           | Server and protocol versions.                                                  |
| POST   | /v1/runs                              | Create a Mission, Run, initial Goal, coordinator Agent, and continuation.      |
| GET    | /v1/runs                              | List Runs, optionally limited or status-filtered.                              |
| GET    | /v1/runs/:runId                       | Read Run detail, agents, current Goal, and requirements.                       |
| POST   | /v1/runs/:runId/commands              | Pause, resume, or cancel with an idempotency key.                              |
| POST   | /v1/runs/:runId/steering              | Persist steering input as an event.                                            |
| GET    | /v1/runs/:runId/agents                | List durable Agents.                                                           |
| GET    | /v1/runs/:runId/checkpoints           | List persisted checkpoint metadata.                                            |
| GET    | /v1/runs/:runId/approvals             | Read durable approval records.                                                 |
| POST   | /v1/runs/:runId/approvals/:approvalId | Resolve one pending approval as approved or rejected with a resolver identity. |
| GET    | /v1/runs/:runId/events                | Read events after a sequence number.                                           |
| GET    | /v1/runs/:runId/events/stream         | Stream durable events through SSE.                                             |

The routes accept the expected JSON shape at the server boundary and reject
malformed/non-object payloads. Request bodies are capped at one megabyte in
the current server.

## Creating a Run

POST /v1/runs accepts mission title, prompt, and workspace URI, with an
optional shared budget. The control plane creates durable Mission, Run, Goal,
and coordinator Agent records within a transaction, starts the Run, records
initial events, and creates a continuation.

The returned Run is not a completed task. It may continue independently after
the HTTP request finishes.

## Commands and idempotency

POST /commands expects a command of pause, resume, or cancel. Clients should
send an Idempotency-Key header with a stable UUID for a logical action. The
control plane stores its receipt transactionally. A transport retry returns the
original state instead of reapplying a command to a newer revision.

The server reports lease and revision conflicts as retryable HTTP 409 errors.
Clients should read current state before making a different semantic request.

## Events and SSE reconnect

Every event has a Run-local increasing sequence. History requests use the
after query parameter. SSE accepts both after and Last-Event-ID:

```text
GET /v1/runs/<run-id>/events?after=42
GET /v1/runs/<run-id>/events/stream?after=42
Last-Event-ID: 42
```

Each SSE frame carries an id equal to the event sequence, an event name equal
to its type, and JSON event data. The server sends keepalive comments while
waiting. A client should persist the last fully processed sequence, fetch
history after it, then stream from the resulting sequence.

## TypeScript SDK

OttiliClient is a thin fetch/SSE client. It owns no Run state and may be
discarded at any time. It exposes health, readiness, version, Run creation and
listing, detail read, idempotent commands, steering, agents, checkpoints,
approval listing/resolution, event history, and an async streamEvents iterator.

The SDK raises OttiliClientError for non-success envelopes and transport
errors. The error includes protocol code, retryability, and HTTP status for
callers that need a retry policy.

## Compatibility

A breaking change to v1 routes, event requirements, or mandatory request
fields requires an architecture decision, migration note, and an explicit
protocol-version decision. The CLI is a client of this same API; it must not
gain an exclusive in-process execution path.
