# Donor Lock

Pins were captured on 2026-08-17. Donor clones are sibling research working
copies and are never part of the Ottili Coder product Git history.

| Donor                | URL                                                 | Ref              | Commit                                   | License at audit | Role                                 | Source reuse                                                 |
| -------------------- | --------------------------------------------------- | ---------------- | ---------------------------------------- | ---------------- | ------------------------------------ | ------------------------------------------------------------ |
| OpenCode             | https://github.com/anomalyco/opencode.git           | v1.18.18         | 31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d | MIT              | Primary coding-runtime research      | Selective and attributed if later reused.                    |
| Kilo Code            | https://github.com/Kilo-Org/kilocode.git            | default at audit | 91a337e31cd7675d680aeb13c92870b8f81bdf36 | MIT              | Index/memory/sandbox hardening       | Selective and attributed if later reused.                    |
| OpenAI Codex         | https://github.com/openai/codex.git                 | default at audit | 32a383c0ba5ed42a1adc3f2084014895bfe7738c | Apache-2.0       | Goal/long-horizon architecture       | Selective and attributed if later reused.                    |
| OpenHands            | https://github.com/OpenHands/OpenHands.git          | default at audit | 6670b4726a81fc73e797a193dae86264857a663d | MIT              | Event persistence, leases, judging   | Concepts/selective attributed reuse only.                    |
| OpenHands SDK        | https://github.com/OpenHands/software-agent-sdk.git | default at audit | b56221283f74dbced26d1da134ded26860bb4f14 | MIT              | Agent runtime mechanics              | Concepts/selective attributed reuse only.                    |
| Cline                | https://github.com/cline/cline.git                  | default at audit | 041afb718bcdfe50eabd90d060e5335ef98e2d16 | Apache-2.0       | Checkpoints/recovery                 | Concepts/selective attributed reuse only.                    |
| Aider                | https://github.com/Aider-AI/aider.git               | default at audit | 5dc9490bb35f9729ef2c95d00a19ccd30c26339c | Apache-2.0       | RepoMap/Git/voice concepts           | Independently reimplement algorithms; attribute inspiration. |
| Claude Code snapshot | https://github.com/MurrayTom/claude-code.git        | unavailable      | —                                        | unknown          | Architecture reference               | **No source reuse.**                                         |
| Current Ottili Coder | https://github.com/Ottili-ONE/coder-cli.git         | default at audit | 7bcd1a2a6ee1880112f06b39221ffe9c6cfe44eb | MIT              | Legacy feature/UX/integration corpus | Selective and attributed if later reused.                    |
| Ottili ONE platform  | https://github.com/Ottili-ONE/ottilionev1.git       | unavailable      | —                                        | unknown          | Optional contract context            | No source reuse planned.                                     |

The Claude archive and optional Ottili ONE platform repository could not be
cloned because GitHub authentication was unavailable. This is non-blocking:
their status is documented rather than silently assumed.

## Release rule

Before release, any actual source reuse must be entered in
THIRD_PARTY_NOTICES.md with the exact upstream file path, pin, license,
copyright/notice material, and a description of the adaptation. Architectural
inspiration is not represented as copied source.
