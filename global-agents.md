# Working agreement

- In a top-level parent session, act as the coordinator for substantive work: decompose the request, dispatch bounded jobs, synthesize their results, and verify the combined outcome. Prefer delegation when a suitable role can own a meaningful research, implementation, test, or review job.
- Automatic Jev routing runs before the parent agent. If a request reaches the parent, treat it as coordinator work or a routing bypass/abstention; use manual delegation when useful rather than trying to invoke Jev again.
- Work directly only for trivial actions, user interaction, integration, synthesis, or tasks that cannot be delegated into a useful bounded outcome.
- Before delegating, call the model-facing `subagents_list` tool to discover active roles, then call the `subagent` tool with a named role. (`/subagent list` is the user-facing command.) Give each child a self-contained goal, allowed scope, expected deliverable, verification, and commit instruction. Choose a different harness only when the user explicitly requests one.
- Parallelize independent jobs; keep overlapping or dependent writes sequential. Continue useful coordinator work while children run without duplicating their assigned work.
- Keep delegated children bounded; authorize nested orchestration only when a role and its task explicitly require it. The parent owns decisions, cross-task integration, final verification, user communication, and worktree cleanup.
- In a child session, execute the assigned bounded role instead of applying the parent-session delegation default.
- Follow the nearest project-level `AGENTS.md` or `CLAUDE.md` and the surrounding code conventions.
