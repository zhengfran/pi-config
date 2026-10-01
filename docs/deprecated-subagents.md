# Deprecated headless subagent implementation

> Historical documentation retained from pi-config before the interactive-package migration.
> `extensions/subagents/index.ts` is disabled in `settings.json`; all existing source,
> tests, routing examples, and experimental relay work are retained in place.
> This document describes the deprecated implementation, not the active tools.
> See [the current README](../README.md) for the replacement and rollback procedure.
> Run the old offline suite with `npm run test:deprecated` and the opt-in live suite
> with `npm run test:deprecated:live` (the historical commands below predate migration).

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

The repository includes two complete profiles: `subagent-routing.corporate.example.json` uses all configured providers, while `subagent-routing.personal.example.json` removes Kiro and GitHub Copilot model routes. Copy the appropriate profile to the machine-local `~/.pi/agent/subagent-routing.json`:

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

Allowance ordering compares only like with like: 20% of a five-hour window means something different from 20% of a monthly one. A group is ranked on the **shortest window kind every candidate reports** — five-hour first, then weekly, monthly, per-model and other — and when the candidates share no kind, the configured order stands.

One judgement does cross window kinds, because "almost out" is comparable even when the percentages are not: a candidate with **under 15% left in any window** moves behind the others, keeping its relative order. If every candidate is that low, the group still yields one rather than failing. `/subagents route` prints each provider's windows, names the kind a decision was made on, and lists any demoted candidate. A configured list replaces the built-in tiers and the environment policy for that task kind, so a corporate machine can list Codex here deliberately. Unlisted task kinds fall back to the built-in tiers.

- `model` is optional and harness-specific: Pi takes a provider-qualified `provider/model-id` (a bare id is ambiguous across authenticated providers), Claude a model alias, Codex a model slug, and Kiro an `agent:model`, `agent:` or `model` hint. Omitting it keeps that harness's own default, which for Pi is the parent model.
- Kiro serves only Claude models (`claude-opus-5`, `claude-opus-4.8`, `claude-sonnet-5`, `claude-haiku-4.5`, …) plus its own `auto` picker, and `kiro_default` / `kiro_planner` are its agents, so a Kiro entry naming any other model is rejected.
- `effort` is optional and falls back to the task-kind default; an explicit `reasoning_effort` on the spawn still wins over both.
- A configured Pi model draws on its own provider's allowance rather than the parent's — `github-copilot` against the Copilot window, `openai-codex` against the same ChatGPT window the Codex harness spends — and a model that is unavailable fails the spawn rather than falling back. The same GPT model is usually authenticated on both providers, so listing both gives Pi a fallback when one allowance runs down; note that the ChatGPT backend serves them with a smaller context window than Copilot does.

Invalid entries are ignored and reported by `/subagents route`, which also lists the effective candidates per task kind. `subagent-routing.corporate.example.json` and `subagent-routing.personal.example.json` are templates; the active file is intentionally not tracked because the environment is machine-specific.

Run `/subagents route` to inspect the effective environment, backend availability, cache freshness, shortest-window allowance, task-fit tiers, and effective decisions. Routing never blocks on a provider refresh and never retries a failed spawn on another harness. After first enabling the usage package, run `/usage refresh` if you want to prime the cache immediately. An explicit harness override is honored only when the user asks for it.

## Experimental agent profiles and local messages

`subagent_spawn` now accepts optional `agent` (a role profile name), distinct from `name` (the child instance alias). Without `agent`, legacy `task_kind` and routing behavior remain unchanged. A profile may provide `task_kind`; conflicting call-supplied kinds fail. User profiles live under `~/.pi/agent/agents/*.md`; project overrides under `.pi/agents/*.md` require an explicit persisted Pi trust decision. The current parser supports version-1 Markdown frontmatter with scalars, **inline lists** and one level of `harness` mappings; unsupported YAML syntax fails closed. The version-1 contract is tracked in the local Wayfinder vault; no default role profiles are installed here.

This is an **in-process implementation stage**, not cross-session collaboration: profiled child ids are UUIDs, aliases are unique within the current parent session, but neither the resolved loadout nor the child manager survives Pi shutdown yet. Pi/Claude headless role injection is wired; `filesystem_read_only` profiles are rejected until an OS boundary is verified. Codex profiled launch is also blocked until native child-agent prevention is verified; named Claude/Codex model hints are refused rather than treated as authenticated. The profile resolver will not route corporate-only profiled requests through legacy Kiro. These guards do not turn tool allowlists into an OS sandbox.

`subagent_message({target, message})` submits a follow-up to a tracked headless child by id or unique local alias, including a successfully settled child while the parent is still open. The return is **not** a durable accepted/delivered/processed receipt; it cannot reach a child after `/reload` or parent exit. Cross-session relay, same-UID anti-spoofing, Herdr panels and native delivery proof remain separate release gates. Continue using the existing management tools for inspection/cancellation.

The experimental `extensions/subagents/src/relay/` store and standalone health-only socket server are **not connected to the subagent tools**. The public bootstrap server exposes no write RPCs and no credentials; it requires separate private state and short runtime/socket directories (`node --experimental-strip-types extensions/subagents/src/relay/server.ts STATE_DIR RUNTIME_DIR`) and does not auto-start with Pi. Mutating operations exist only on the authenticated per-instance bridge described below, which is likewise not wired into the live tools. Do not run any of this as a production relay: authorized cross-session attach, an independent executor and proven native receipts do not exist yet. `npm test` includes their offline Linux lock/socket/bridge tests. On a Mac with Node 24+ and `npm ci`, run `scripts/relay-macos-check.sh` for disposable bootstrap/store/crash tests; it explicitly does **not** certify same-UID security, a LaunchAgent or real native messaging. Those release gates remain outstanding.

### Linux per-child boundary and bridge (prototype tested on this host; not shipped)

`extensions/subagents/src/relay/linux-sandbox.ts` builds an argv for launching a child under `bwrap --unshare-all` (new user/pid/net/ipc/uts/cgroup/mount namespaces, **network off**, `no_new_privs`, empty capabilities). Its bridge to the relay is a **capability, not a token**: one per-instance Unix socket bind-mounted read-only at a fixed in-sandbox path (`/run/pi-bridge.sock`). The host side (`bridge-endpoint.ts`) maps that socket back to `{group, instance, fence}`, so the sender is derived from *which socket the connection arrived on* — any `sender`/`from` in the request body is ignored. There is therefore no shared secret in the child's environment or filesystem for a sibling to steal, and a sibling cannot reach another instance's socket (fresh tmpfs `/run`, no bind, network namespace). The prototype bridge refuses to construct if its caller reports sandbox support. **That check is not launch enforcement or caller authentication:** its capability argument is supplied by the caller, and any unconfined same-UID host process that reaches an endpoint can use it (the test deliberately confirms host access as a positive control). Production integration must bind socket minting to a verified confined launch and isolate the host endpoint from unconfined child code before enabling it.

`npm run test:security:linux` (`scripts/linux-child-bridge-security-check.ts`) launches **real confined children running adversarial code** against a live bridge + store and asserts, each with an outside-sandbox positive control: a child on A's socket that forges `sender: B` is still recorded as A; the child cannot reach B's bridge socket (its real host path is handed to the child and still fails); the relay state directory, SQLite DB, a sibling host process's `/proc`, host loopback TCP and the Docker socket are all unreachable. On this host (Ubuntu 20.04, kernel 5.4, bubblewrap 0.4.0) all eight checks pass; the harness exits `2` and asserts nothing if unprivileged user namespaces are unavailable. The older `npm run test:isolation:linux` remains as a lighter fixture-visibility probe.

**This boundary only holds for code actually launched through the confinement.** It is not wired into the live Pi/Claude/Codex adapters, does not exercise real native messaging or Herdr, and **no macOS equivalent is implemented** — so tickets 08–12 stay open. A same-UID process that is *not* confined keeps the user's full privileges (this host has Docker-group and passwordless-sudo access), which is why the live relay must not mint a bridge until a trusted executor actually enforces confinement and the host endpoint is protected. A stale accepted connection also needs fencing on reads; the bridge now checks the current bound fence for every operation.

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
