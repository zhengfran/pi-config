# Deprecated: headless subagent runtime

This implementation is preserved in place, including ongoing uncommitted profile and relay work, but is disabled by the `-extensions/subagents/index.ts` entry in the root `settings.json`.

The active replacement is the Pi-managed Git package `git:github.com/zhengfran/pi-herdr-agents`, with Herdr panes, managed worktrees, and native Claude/Kiro lifecycle support. See the root `README.md` for usage, operational notes, and rollback; `docs/deprecated-subagents.md` retains this implementation's documentation.

Use `npm run test:deprecated` for this directory's offline suite. Paid/live harness tests are opt-in via `npm run test:deprecated:live`. Enable only one subagent implementation at a time: both register overlapping subagent tools and commands.
