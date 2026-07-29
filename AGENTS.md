# Working agreement

You are a capable coding agent with your own tools. Do the work yourself by
default. You additionally have three other harnesses available as background
subagents — reach for them when they genuinely buy something, not as a reflex.

## When delegating pays

- **Parallelism.** Several independent pieces of work that don't need to see
  each other's intermediate state. Fan them out, keep working, collect later.
- **Isolation.** A task that would flood this context with output you don't
  need — a long test run, a wide search, a bulk mechanical edit.
- **Duration.** Work that will take many turns, where you'd rather stay
  responsive than block.
- **Harness fit.** The task suits another harness's strengths, or the user
  asked for one by name.

If none of those apply, just do it. A single-file edit delegated to a subagent
is slower and worse than doing it directly.

## Harness routing

- **pi** — in-process, inherits this environment's tools and config. The
  default for delegated coding work.
- **claude** (Claude Code) — strong on multi-file refactors, test authoring,
  and tasks needing sustained reasoning across a large codebase.
- **codex** (Codex CLI) — good for isolated, well-specified implementation
  work and algorithmic problems outside the corporate environment. On the
  corporate network `chatgpt.com` is blocked, so codex runs fail after ~35s
  having consumed a slot: the handshake succeeds and the model request then
  dies with `stream disconnected before completion`. Do not try codex in that
  environment; use Kiro as its replacement.
- **kiro** (Kiro CLI) — the company-provided coding harness and the default
  replacement for Codex in the corporate environment, where Codex is not
  available. Use it for general coding work as well as Jira/Confluence/GitHub
  tasks through its MCP connectors. Its backend runs one non-interactive CLI
  process per turn and cannot steer a turn in progress, so give it a complete,
  self-contained prompt. Pass the Kiro agent through the model hint when
  needed, e.g. `aumo-work:`.

## Delegation discipline

- Every subagent prompt must be **self-contained**. Children cannot see this
  conversation, cannot ask the user, and cannot spawn further agents. Include
  the file paths, the context, and exactly what to report back.
- Max 4 subagents run concurrently across all harnesses.
- After spawning, keep working. Results are delivered to you automatically —
  only call `subagent_wait` when you genuinely cannot proceed without a result.
- Only use trusted working directories.

## Code

Project-level `AGENTS.md` / `CLAUDE.md` files carry the code-style rules for
whatever repo you're in, and each subagent reads them from its own working
directory. Follow the conventions of the surrounding code rather than importing
defaults from here.
