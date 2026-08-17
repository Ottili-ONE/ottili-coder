# Known Problems

| ID | Severity | Symptom | Root cause | Evidence | Status | Intended fix |
| --- | --- | --- | --- | --- | --- | --- |
| KP-001 | low | Claude Code archive unavailable locally | GitHub authentication is required | Clone returned `could not read Username` | open | Retain reference-only status; never use source |
| KP-002 | low | Ottili ONE platform source unavailable locally | GitHub authentication is required | Clone returned `could not read Username` | open | Use legacy Coder contracts and testable adapters |
| KP-003 | medium | System Node cannot run installed pnpm | System Node is v20; pnpm requires `node:sqlite` | pnpm fails under system Node | mitigated | Pin/use Node 24 in tooling and CI |
