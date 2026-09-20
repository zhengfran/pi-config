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
- `reasoning_effort` optionally overrides thinking. When omitted, the router selects `low` for quick work, `medium` for general research and isolated implementation, `high` for planning, reviews and tests, and `xhigh` for large refactors and algorithmic work. Pi uses the level directly, and Claude, Codex and Kiro each translate it to their own scale.

For the Pi harness, model hints are resolved only against authenticated, available models. A provider-qualified hint fails before spawn if that provider is unavailable; a bare model id never selects an unauthenticated provider and must be unambiguous across the remaining providers.

Both environments can reach every harness; they differ only in preference order, with corporate keeping Kiro ahead of Codex for bounded work.

Create the machine-local configuration at `~/.pi/agent/subagent-routing.json`:

```json
{
  "version": 1,
  "environment": "corporate",
  "models": {
    "code_review": [
      { "harness": "kiro", "model": "claude-sonnet-5", "effort": "high" },
      { "harness": "claude", "model": "sonnet", "effort": "high" },
      { "harness": "codex", "model": "gpt-5.6-terra", "effort": "high" }
    ],
    "quick": [
      {
        "harness": "pi",
        "model": "github-copilot/gpt-5.6-luna",
        "effort": "low"
      }
    ]
  }
}
```

Use `"personal"` outside the corporate network. If the file is absent or invalid, routing fails safe to the personal policy and reports the configuration problem.

`models` is optional and lists, per `task_kind`, every way that task may run: `{ "harness": …, "model": …, "effort": … }`. The list is one preference group — availability and `required_access` filter it, then allowance ordering picks the winner; otherwise the listed order stands.

Allowance ordering compares only like with like: 20% of a five-hour window means something different from 20% of a monthly one. A group is ranked on the **shortest window kind every candidate reports** — five-hour first, then weekly, monthly, per-model and other — and when the candidates share no kind, the configured order stands. `/subagents route` prints each provider's windows and names the kind a decision was made on. A configured list replaces the built-in tiers and the environment policy for that task kind, so a corporate machine can list Codex here deliberately. Unlisted task kinds fall back to the built-in tiers.

- `model` is optional and harness-specific: Pi takes a provider-qualified `provider/model-id` (a bare id is ambiguous across authenticated providers), Claude a model alias, Codex a model slug, and Kiro an `agent:model`, `agent:` or `model` hint. Omitting it keeps that harness's own default, which for Pi is the parent model.
- Kiro serves only Claude models (`claude-opus-5`, `claude-opus-4.8`, `claude-sonnet-5`, `claude-haiku-4.5`, …) plus its own `auto` picker, and `kiro_default` / `kiro_planner` are its agents, so a Kiro entry naming any other model is rejected.
- `effort` is optional and falls back to the task-kind default; an explicit `reasoning_effort` on the spawn still wins over both.
- A configured Pi model draws on its own provider's allowance rather than the parent's, and a model that is unavailable fails the spawn rather than falling back.

Invalid entries are ignored and reported by `/subagents route`, which also lists the effective candidates per task kind. `subagent-routing.example.json` is a template; the active file is intentionally not tracked because the environment is machine-specific.

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
