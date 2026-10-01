#!/bin/sh
# Offline, disposable macOS smoke/fault tests for the unfinished relay prototype.
# Does not launch a model worker, install a LaunchAgent, or read credentials.
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  printf '%s\n' 'ERROR: Run this on macOS; Linux results cannot satisfy the macOS gate.' >&2
  exit 2
fi

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo"
if ! node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)' 2>/dev/null; then
  printf '%s\n' 'ERROR: Relay prototype needs Node.js 24+ (node:sqlite and TypeScript strip-types).' >&2
  exit 2
fi
if [ ! -d node_modules ]; then
  printf '%s\n' 'ERROR: Install dependencies first (npm ci) in the pi-config repo.' >&2
  exit 2
fi

printf 'macOS relay prototype check: %s / node %s\n' "$(uname -sm)" "$(node -p process.version)"
printf '%s\n' 'Running TypeScript check and disposable lock/store/socket/crash tests...'
npm run check
node --test --experimental-strip-types \
  extensions/subagents/relay-ownership.test.ts \
  extensions/subagents/relay-store.test.ts \
  extensions/subagents/relay-server.test.ts \
  extensions/subagents/relay-crash.test.ts
printf '%s\n' 'PROTOTYPE TESTS PASSED. RELEASE STILL BLOCKED: no authenticated bridge, same-UID attack proof, native receipts, independent executor/reattach or LaunchAgent test.'
