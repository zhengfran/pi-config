# pi-config

Personal configuration for [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent), included in [`dotconfig`](https://github.com/zhengfran/dotconfig) as the `tools/ai/pi` submodule. `scripts/setup-config.sh` links it into `~/.pi/agent`; auth, sessions and Pi-managed packages stay there untracked.

## What's in it

- **Extensions** — `ask-user` tool, `/copy-all` command, Herdr agent-state hook
- **Agents** — `oracle` subagent definition
- **DSH delegation** — `bin/dsh-acp.mjs` bridges `pi-subagents` to DeepSeek Harness over ACP
- **Themes** — `github-dark-default`, `gruvbox-dark`, `omarchy-system`
- **Global instructions** — `global-agents.md`
- **Packages** (`settings.json`) — Nowledge Mem, subscription usage, web access, subagents, fff file search, billion-context, [BTW side conversations](https://github.com/zhengfran/pi-btw)

Skills are managed separately in [`zzc-skills`](https://github.com/zhengfran/zzc-skills).
