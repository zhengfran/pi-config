# pi-config

Personal configuration and local extensions for [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

This repository is intentionally separate from [`dotconfig`](https://github.com/zhengfran/dotconfig) and is included there as the `tools/ai/pi` submodule.

## Install

```bash
git clone --recurse-submodules git@github.com:zhengfran/dotconfig.git ~/dotconfig
cd ~/dotconfig/tools/ai/pi
npm run install:all
```

Then link this directory to Pi's agent directory:

```bash
mkdir -p ~/.pi
ln -s ~/dotconfig/tools/ai/pi ~/.pi/agent
```

The dotconfig `scripts/setup-config.sh` script performs the link interactively.

## Contents

- `settings.json` — portable Pi settings and installed Pi package declarations
- `extensions/` — local TypeScript extensions
- `themes/` — local themes
- `AGENTS.md` — global coding-agent instructions

Runtime/private state such as authentication, sessions, trust data, downloaded packages, and generated model catalogs is excluded by `.gitignore`.

Skills are managed independently by [`zzc-skills`](https://github.com/zhengfran/zzc-skills) and are therefore not tracked here.

## Development

```bash
npm run install:all
npm run check
npm test
npm run format:check
```
