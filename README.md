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

- `task_kind` describes the work: general (`general`, `quick`), analysis (`code_research`, `planning`, `code_review`), sustained change (`large_refactor`, `test_authoring`), or bounded change (`isolated_implementation`, `algorithmic`).
- `required_access` describes corporate toolchain access. Company Jira, company Confluence, and the internal GitHub host `github-ix.int.automotive-wan.com` are Kiro-only requirements. The `github_ix` requirement applies **only** to that internal host; public GitHub such as `github.com` is routed normally from `task_kind` and must not set `github_ix`.
- `reasoning_effort` optionally overrides thinking. When omitted, the router selects `low` for quick work, `medium` for general research and isolated implementation, `high` for planning, reviews and tests, and `xhigh` for large refactors and algorithmic work. Pi uses the level directly, Codex and Claude translate it, and Kiro currently ignores it.

For the Pi harness, model hints are resolved only against authenticated, available models. A provider-qualified hint fails before spawn if that provider is unavailable; a bare model id never selects an unauthenticated provider and must be unambiguous across the remaining providers.

Create the machine-local configuration at `~/.pi/agent/subagent-routing.json`:

```json
{
  "version": 1,
  "environment": "corporate",
  "piModels": {
    "quick": "github-copilot/gpt-5.6-luna",
    "code_review": "github-copilot/claude-opus-5",
    "algorithmic": "github-copilot/gpt-6-astra"
  },
  "kiroModels": {
    "quick": "claude-4.5",
    "code_review": "aumo-work:claude-4.5"
  }
}
```

Use `"personal"` outside the corporate network. If the file is absent or invalid, routing fails safe to the personal policy and reports the configuration problem.

`piModels` and `kiroModels` are optional and map a `task_kind` to the model that harness's children should use. Either applies only when the router picks that harness and the spawn carries no explicit `model`; unlisted task kinds keep the harness default, which for Pi is the parent model.

- `piModels` values are provider-qualified (`provider/model-id`), because a bare id can be ambiguous across authenticated providers. The configured model's provider, not the parent's, supplies the Pi quota, and a model that is unavailable fails the spawn rather than falling back.
- `kiroModels` values are Kiro hints — `agent:model`, `agent:` or `model`. Kiro only serves Claude models, so a named model must be a Claude one; an agent-only value keeps Kiro's own default.

Invalid entries are ignored and reported by `/subagents route`, which also lists both effective mappings. `subagent-routing.example.json` is a template; the active file is intentionally not tracked because the environment is machine-specific.

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
