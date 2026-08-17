# Risk Register

| ID | Risk | Likelihood | Impact | Mitigation | Owner | Status |
| --- | --- | --- | --- | --- | --- | --- |
| RK-001 | Donor code creates license/provenance issues | medium | high | Use selective independent implementations and third-party notices | coordinator | active |
| RK-002 | Daemon crash causes duplicate executor writes | medium | critical | Lease generation fencing and recovery tests precede production runtime | control plane | active |
| RK-003 | Context / agent process incorrectly ends Run | medium | critical | Durable state machine and automatic continuation tests | control plane | active |
| RK-004 | Checkpoint restore damages workspace | medium | critical | Pre-restore capture, transaction and rollback tests | recovery | active |
| RK-005 | External Ottili platform access is unavailable | high | medium | Adapter ports, deterministic mocks, legacy contract audit | integrations | mitigated |
| RK-006 | Native dependency breaks cross-platform install | medium | high | Prefer Node APIs, CI matrix, capability detection | foundation | active |
