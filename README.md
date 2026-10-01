# pi-config

Personal configuration and local extensions for [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent), included in [`dotconfig`](https://github.com/zhengfran/dotconfig) as the `tools/ai/pi` submodule.

## Install

```bash
git clone --recurse-submodules git@github.com:zhengfran/dotconfig.git ~/dotconfig
cd ~/dotconfig/tools/ai/pi
npm run install:all
~/dotconfig/scripts/setup-config.sh
```

The setup script keeps `~/.pi/agent` as a real directory and links only portable resources:

```text
~/.pi/agent/AGENTS.md      -> global-agents.md
~/.pi/agent/agents        -> agents/
~/.pi/agent/extensions    -> extensions/
~/.pi/agent/settings.json -> settings.json
~/.pi/agent/themes        -> themes/
```

Authentication, sessions, trust decisions, and Pi-managed packages remain in the agent directory. Skills are managed independently by [`zzc-skills`](https://github.com/zhengfran/zzc-skills).

## Herdr agents (active)

`settings.json` loads `git:github.com/zhengfran/pi-herdr-agents`, the public fork that adds native Claude Code and Kiro lifecycle support to the upstream Herdr/worktree orchestrator. Pi manages its checkout under `<agent-dir>/git/github.com/zhengfran/pi-herdr-agents`; no source copy is kept in this config repo. Pi supplies runtime dependencies.

```bash
pi install git:github.com/zhengfran/pi-herdr-agents
# Later, update just this package:
pi update git:github.com/zhengfran/pi-herdr-agents
```

Finish active children before updating, then restart Pi or run `/reload`. Make source changes in a separate development clone and publish them to GitHub; Pi's managed checkout is replaceable package state.

- Package documentation: [zhengfran/pi-herdr-agents](https://github.com/zhengfran/pi-herdr-agents)
- Upstream acknowledgement: [giuseppecrj/pi-herdr-agents](https://github.com/giuseppecrj/pi-herdr-agents)
- Personal role overrides: [agents/](agents/) — `scout` (codebase recon), `researcher` (web research), `worker` (implementation)

Start Pi inside **Herdr** with `HERDR_ENV=1`. The package runs Pi-backed and native Claude/Kiro children in dedicated Herdr panes and can provision managed Git worktrees. Other terminal multiplexers are not supported; outside Herdr, role discovery remains available but child launch fails closed.

Tools:

```typescript
subagents_list({});
subagent({ agent: "scout", task: "Map the authentication flow" });
subagent({ agent: "worker", name: "auth-fix", task: "Implement the agreed fix" });
subagent_send({ name: "auth-fix", message: "Also cover expired tokens" });
```

`/subagent scout <task>` is the equivalent slash command. Results return asynchronously; the widget tracks running children. Persistent specialists and running native sessions accept follow-ups through `subagent_send`; completed native sessions can be continued with `subagent_resume`. Pi children contact their parent through `caller_ping`.

Pi's startup default is set in `settings.json`. Personal profiles in `agents/` pin each role's model independently and are linked to `~/.pi/agent/agents`, overriding package defaults without modifying Pi's managed checkout. Their frontmatter is the source of truth for model and thinking level; the spawn's `model` argument can override the profile. Project-local `.pi/agents` definitions take precedence over these global profiles.

These are complete personal profiles, not partial model-only overrides. Review package role changes when updating. Research tools use the already-installed `pi-web-access` package and its actual tool names, including `fetch_content`.

### Operational notes

- Pi-backed roles use authenticated Pi provider/model IDs. Roles with `cli: claude` or `cli: kiro` use the native harness lifecycle, correlated receipts, verified process ownership, exact-loadout resume, and bounded nested delegation.
- Tool allowlists are capability selection, not an OS sandbox. Review project-local agent definitions before delegating in an unfamiliar repository.
- Use ordinary panes for read-only or sequential work. Use a unique managed worktree for each parallel independent writer; the parent owns review, integration, and cleanup.
- Existing handles and sessions from the deprecated local runtime or the previous package are not migrated into the new registry.

Finish any running children before using `/reload` or restarting Pi. The currently open session retains its loaded tools until then. After reload, use `subagents_list` rather than `subagent_spawn`.

## Deprecated implementation and rollback

`extensions/subagents/` is **deprecated and disabled**, not deleted or moved. `settings.json` excludes `extensions/subagents/index.ts` so it cannot conflict with the replacement's subagent tools and commands. All existing uncommitted source and experimental relay work are preserved. The old routing examples and machine-local `~/.pi/agent/subagent-routing.json` remain intact but are unused by the replacement.

Historical documentation is retained at [docs/deprecated-subagents.md](docs/deprecated-subagents.md); the old design vocabulary remains in `CONTEXT.md`.

To roll back after finishing active children:

1. Remove `git:github.com/zhengfran/pi-herdr-agents` from `settings.json`.
2. Remove `-extensions/subagents/index.ts` from its `extensions` array.
3. Restore the deterministic-routing guidance in `global-agents.md` if using that runtime again.
4. Restart Pi or run `/reload`.

Enable only one implementation at a time.

## Development

```bash
npm run install:all
pi install git:github.com/zhengfran/pi-herdr-agents
npm run check           # retained local extensions, including deprecated source
npm test                # config/load regressions against the installed Git package
npm run test:deprecated # retained headless runtime's offline suite
```

The old paid/live harness tests remain opt-in via `npm run test:deprecated:live`. The experimental Linux isolation scripts remain available for the deprecated relay; they do not validate the active package.

The replacement's unit tests and CI live in its own repository. To run them, use a separate development clone:

```bash
git clone https://github.com/zhengfran/pi-herdr-agents.git
cd pi-herdr-agents
npm ci
npm test
```

Its `npm run test:integration` suite requires Herdr; live integration tests additionally require configured model access and may make model requests. Do not run development installs or edit source inside Pi's managed checkout.
