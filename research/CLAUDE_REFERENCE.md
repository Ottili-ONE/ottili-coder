# Claude Code Reference Status

The specified `MurrayTom/claude-code` archive could not be cloned because
GitHub authentication is unavailable. Its local donor directory is absent.

## Boundary

- This donor is **REFERENCE ONLY** and has **NO SOURCE REUSE** authorization.
- No source, API, tests, internals, or implementation was inspected or copied.
- Its unavailability is non-blocking because the product architecture can be
  independently implemented from the mission requirements and other available
  donors.

## Independently adopted product principles

The following are derived from the mission specification, not from source:

- a coordinator owns decomposition, synthesis, integration, and independent
  verification rather than blindly forwarding worker findings;
- agents have bounded roles and persist async lifecycle events;
- clients are disposable while Mission → Run → Goal/Task/Agent → SessionEpoch
  remains durable;
- checkpoints and recovery preserve workspace plus execution evidence;
- fresh verification is isolated from implementation context.
