# Security Policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability involving credentials,
arbitrary command execution, path traversal, daemon authentication, SQLite
state disclosure, MCP transport, or checkpoint restoration.

Until a dedicated security contact is published, report privately to the
Ottili ONE maintainer through the repository's private security-reporting
channel, including:

- affected version or commit;
- a minimal reproduction;
- impact and prerequisites;
- whether secrets, a non-loopback daemon, or untrusted workspace content are
  involved;
- a safe way to contact you for follow-up.

Please avoid attaching live credentials or private repositories. We aim to
acknowledge a report within seven days and will coordinate a fix before public
disclosure where practical.

## Supported scope

The current vNext source tree is an early source build. Security fixes are
made against the default branch. A release support window will be stated with
the first published release.

## Deployment baseline

1. Bind the daemon to loopback unless you deliberately operate it behind a
   trusted reverse proxy.
2. A non-loopback bind requires a bearer token in the daemon server
   constructor. Use a high-entropy token and protect its descriptor file.
3. Restrict the daemon process account, filesystem access, workspace
   directories, and network egress independently of Ottili Coder.
4. Treat all prompts, repository contents, tool output, MCP server output, and
   provider responses as untrusted input.
5. Review tool permissions and resource scopes before enabling writes,
   external APIs, or destructive actions.
6. Keep provider keys, Ottili access tokens, and daemon tokens outside Git and
   diagnostic logs.

## Security properties and non-properties

The implementation provides useful controls:

- loopback by default and bearer-token enforcement for non-loopback binds;
- HTTP request size limits and typed JSON validation at the server boundary;
- owner-only modes when writing the local config directory and daemon
  descriptor, subject to platform filesystem semantics;
- monotonic lease fencing to reject stale executor writes;
- durable tool intent/outcome records and recovery classification;
- declarative MCP configuration that rejects module/plugin loaders and uses
  shell: false for stdio commands;
- HTTPS-only remote MCP endpoints except loopback HTTP.

It does **not** turn a process on the local machine into a perfect sandbox.
The local backend can execute commands with the daemon user's privileges.
Sandbox profiles represent requested policy and report whether a host backend
can enforce it; use an OS/container/VM boundary for stronger isolation.

## Credentials and privacy

The project intentionally keeps client discovery metadata separate from durable
Run state. A local daemon descriptor may contain a bearer token and is
therefore sensitive. Provider adapters accept credentials at construction time;
do not serialize them into a Mission, Run, event payload, checkpoint, or
project configuration.

The Ottili AI adapter is an optional managed-provider boundary. Bring-your-own
key use remains independent of Ottili login. No claim is made that the source
tree implements a complete managed OAuth credential vault.

See [the architecture security guide](docs/architecture/SECURITY.md) for the
threat model and recovery-specific considerations.
