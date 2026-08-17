# Security Architecture

## Threat model

Ottili Coder processes untrusted prompts, repositories, tool output, provider
responses, and potentially MCP server messages. It can be configured to run
commands and mutate workspaces. The architecture therefore assumes that a
model, a tool description, and a client connection are not trusted authority.

Primary threats include:

- a stale executor committing after a daemon restart;
- a client retry causing a second state-changing command;
- a tool crash leaving an external effect ambiguous;
- an exposed non-loopback daemon accepting unauthenticated calls;
- an MCP configuration using dynamic code loading or insecure remote URLs;
- a workspace or provider response leaking credentials into durable records;
- an overbroad local execution environment.

## Controls by layer

| Layer         | Control                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| Server        | Loopback default; token required for non-loopback bind; bounded JSON request body; typed route parsing. |
| Protocol      | Serializable policy/tool contracts; no executable function crosses a wire boundary.                     |
| Control plane | SQLite transactions, revision checks, idempotency receipts, resource locks, lease fencing.              |
| Runtime       | Tool intent/outcome records, structured provider failure classification, AbortSignal boundary.          |
| Workspace     | Declared sandbox profile, worktree support, private Git checkpoint refs.                                |
| Integrations  | Declarative MCP configs; no plugin/module loader fields; shell false for stdio.                         |
| Context       | Bounded selection and redaction of common secret-like memory content.                                   |
| Validation    | Completion requires evidence and independent verification rather than model self-report.                |

## Authentication and network exposure

OttiliDaemonServer accepts a token option. A server bound to any host other than
127.0.0.1, ::1, or localhost rejects construction without one. Clients send
the value as a bearer token.

The local descriptor is discovery data, not durable Run data. It can carry the
token and should be treated like a credential. The daemon-client writes its
configuration directory and descriptor with restrictive modes where supported.

For a remote deployment, use TLS termination, token rotation, process
isolation, network ACLs, and a service manager. The source tree itself does
not provide a complete multi-user authorization system.

## Permissions and sandboxing

Permission evaluation combines Run, role, tool, and sandbox policy using the
most restrictive applicable decision. Resource scopes distinguish read and
write access and allow conflicting mutations to be blocked.

SandboxProfile captures filesystem, network, process, and environment policy.
Capability detection states whether a selected backend can enforce that profile.
The local backend is intentionally transparent: it executes a command under
the daemon user. It should be treated as a development convenience, not
untrusted-code containment.

## Secrets and durable data

Do not write these values into a Mission, Run, event payload, checkpoint,
RepoMap, project memory, or committed config:

- provider API keys;
- Ottili access tokens;
- daemon bearer tokens;
- MCP authorization headers;
- private repository credentials.

Redaction limits accidental memory retention, but no pattern detector catches
every secret. Prefer environment injection or an external secret store under
the host operator's control.

## Side effects and recovery

Lease fencing prevents stale actors from changing durable Ottili state. It
cannot reverse an already-delivered external request. This is why tool calls
record metadata and intents before execution, and why recovery may select
reconcile or manual intervention instead of retry.

See [SECURITY.md](../../SECURITY.md) for reporting guidance and
[Recovery](RECOVERY.md) for the restoration path.
