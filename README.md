# pi-config

Personal configuration and local extensions for [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent).

This repository is included in [`dotconfig`](https://github.com/zhengfran/dotconfig) as the `tools/ai/pi` submodule.

## Install

```bash
git clone --recurse-submodules git@github.com:zhengfran/dotconfig.git ~/dotconfig
cd ~/dotconfig/tools/ai/pi
npm run install:all
~/dotconfig/scripts/setup-config.sh
```

The setup script keeps `~/.pi/agent` as a real directory and links only the portable resources:

```text
~/.pi/agent/AGENTS.md    -> global-agents.md
~/.pi/agent/extensions  -> extensions/
~/.pi/agent/settings.json -> settings.json
~/.pi/agent/themes      -> themes/
```

It does not replace the agent directory, so authentication, sessions, trust decisions, and Pi-managed packages remain intact.

## Contents

- `settings.json` — portable Pi settings and installed package declarations
- `extensions/` — local TypeScript extensions
- `themes/` — local themes
- `global-agents.md` — global coding-agent instructions

Runtime/private state stays under `~/.pi/agent` and is not tracked here. Skills are managed independently by [`zzc-skills`](https://github.com/zhengfran/zzc-skills); Pi discovers them through `~/.agents/skills`.

## Subagent routing

`extensions/subagents` deterministically selects a harness from the kind of work, required corporate-system access, backend availability, environment policy, and fresh account-wide allowance data from [`pi-subscription-usage`](https://github.com/zhengfran/pi-subscription-usage). The usage package owns refresh and credentials; the router only reads its owner-only, versioned cache.

Routing keeps two concerns separate:

- `task_kind` describes the work: general, analysis (`code_research`, `code_review`), sustained change (`large_refactor`, `test_authoring`), or bounded change (`isolated_implementation`, `algorithmic`).
- `required_access` describes corporate toolchain access. Company Jira, company Confluence, and the internal GitHub host `github-ix.int.automotive-wan.com` are Kiro-only requirements. The `github_ix` requirement applies **only** to that internal host; public GitHub such as `github.com` is routed normally from `task_kind` and must not set `github_ix`.
- `reasoning_effort` optionally overrides thinking. When omitted, the router selects `medium` for general research and isolated implementation, `high` for reviews and tests, and `xhigh` for large refactors and algorithmic work. Pi uses the level directly, Codex and Claude translate it, and Kiro currently ignores it.

For the Pi harness, model hints are resolved only against authenticated, available models. A provider-qualified hint fails before spawn if that provider is unavailable; a bare model id never selects an unauthenticated provider and must be unambiguous across the remaining providers.

Create the machine-local configuration at `~/.pi/agent/subagent-routing.json`:

```json
{
  "version": 1,
  "environment": "corporate"
}
```

Use `"personal"` outside the corporate network. If the file is absent or invalid, routing fails safe to the personal policy and reports the configuration problem. `subagent-routing.example.json` is a template; the active file is intentionally not tracked because the environment is machine-specific.

Run `/subagents route` to inspect the effective environment, backend availability, cache freshness, shortest-window allowance, task-fit tiers, and effective decisions. Routing never blocks on a provider refresh and never retries a failed spawn on another harness. After first enabling the usage package, run `/usage refresh` if you want to prime the cache immediately. An explicit harness override is honored only when the user asks for it.

## Development

```bash
npm run install:all
npm run check
npm test
npm run format:check
```

External harness smoke tests are opt-in:

```bash
npm run test:live
```
