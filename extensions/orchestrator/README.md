# Orchestrator pi profiles

`index.ts` is a real, auto-discovered pi extension, but it is inert by default.
Source one provisioned `global.env` or `project.env` outside this repository
before starting pi. The stable client id/token are daemon credentials, not pi
settings, and the daemon remains the authority for project scope and delegation
depth. The worker profile deliberately has neither the profile switch nor any
orchestrator credential. Start a direct worker through
`profiles/pi-worker.mjs`; it removes inherited `ZZC_ORCHESTRATOR_*` values and
uses Pi's `--no-extensions` flag, leaving built-in concrete-work tools without
`orchestrator_intent`, `orchestrator_sync`, or subagent delegation. Runtime
pi-worker launches carry the same `--no-extensions` boundary.

The extension uses protocol `v1` of the runtime's private Unix-socket API. It
stores and renders a complete local presentation entry before acknowledging a
notification, retries a pending acknowledgement after reopen, and persists its
advanced cursor plus pending-question projection across pi or daemon restart.
It does not copy task state. Missing socket, credentials, unavailable capability,
blocked precondition, rejected request, or unknown transport acceptance are
returned verbatim to the pi session rather than represented as success.
