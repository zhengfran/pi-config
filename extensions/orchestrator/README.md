# Orchestrator pi profiles

`index.ts` is a real, auto-discovered pi extension, but it is inert by default.
Source one provisioned `global.env` or `project.env` outside this repository
before starting pi. The stable client id/token are daemon credentials, not pi
settings, and the daemon remains the authority for project scope and delegation
depth. The worker profile deliberately has neither the profile switch nor any
orchestrator credential, so ordinary worker pi keeps its concrete-work tools
without `orchestrator_intent` or `orchestrator_sync`.

The extension uses protocol `v1` of the runtime's private Unix-socket API. It
records a local presentation entry before acknowledging a notification, then
uses the daemon's durable notifications and event cursor to recover after pi or
daemon restart. It stores presentation/cursor/pending-question hints only; it
does not copy task state. Missing socket, credentials, unavailable capability,
blocked precondition, rejected request, or unknown transport acceptance are
returned verbatim to the pi session rather than represented as success.
