#!/bin/sh
# Disposable, non-production NEGATIVE probe for bwrap-based child isolation on Linux.
#
# Purpose: sanity-check that an *unprivileged* `bwrap --unshare-all` invocation with a
# minimal, explicit bind allowlist stops a child process running arbitrary code from
# reaching things it has no business reaching, when nothing about the sandbox is bound
# to grant that access. This is a smoke test for one specific bwrap incantation on one
# machine, not a security certification of Pi, of bwrap, or of the kernel.
#
# WHAT THIS DOES PROVE (when it exits 0):
#   - A child launched via `bwrap --unshare-all` with only a per-run scratch dir bound
#     cannot read a sibling file (a disposable dummy "secret") that lives one directory
#     up from the bound scratch dir, even though both dirs share the same parent tmpdir
#     and the same UID/GID -- ordinary POSIX permissions would have allowed the read.
#   - The same child cannot see or connect to a disposable relay-style fixture (a
#     dummy "DB" file and a listening UNIX-domain socket) that a sibling process on the
#     host owns, when that fixture's directory is not part of the bind allowlist.
#   - The same child cannot inspect a sibling process's /proc/<pid> entries (environ,
#     fd, cwd) -- PID-namespace isolation makes the sibling's PID simply not exist
#     inside the child's /proc, rather than merely permission-denied.
#   - The same child cannot see the real host Docker socket (/var/run/docker.sock or
#     /run/docker.sock) *if one exists on this host* -- checked by existence only,
#     never by talking to the daemon.
#   - Each negative check has a matching positive control run *outside* the sandbox,
#     proving the fixture really is reachable to a same-UID process in general, so a
#     "denied" result inside the sandbox is attributable to the sandbox and not to a
#     broken/missing fixture.
#
# WHAT THIS DOES NOT PROVE (out of scope, do not cite this script for any of it):
#   - Nothing here is a production security verification or a substitute for a real
#     audit. See tools/ai/pi/README.md's existing "not connected"/"OS boundary not
#     verified" caveats -- this script does not lift them.
#   - Does not exercise the real Pi relay server/store; it uses representative
#     disposable fixtures of the same shape (a UNIX socket + a plain "db" file).
#   - Does not test root/privileged adversaries, setuid/setgid escapes, kernel
#     exploits, side channels (shared /proc/sys, sysfs, cgroup, kernel keyring, timing),
#     or any seccomp/LSM (AppArmor/SELinux) policy -- bwrap's own restrictions only.
#   - Does not test behavior on other kernels, other bwrap versions, under concurrent
#     load, or with root-run/setuid bwrap binaries.
#   - The Docker-socket check is skipped (not silently passed) if this host has no
#     docker socket at all; a skip is reported plainly and does not count as a pass.
#   - If unprivileged user namespaces are unavailable or bwrap itself is missing or
#     broken on this machine, the script FAILS CLOSED: it reports that isolation could
#     not be exercised and exits non-zero. A non-zero/"cannot verify" result must never
#     be read as "isolation confirmed" -- only an explicit all-PASS summary means that.
#
# Safety: no network use (--unshare-net), no elevated privileges, no sudo, no real
# secrets (dummy marker strings only), no interaction with any live production
# service (the Docker check only stats a path, it never opens/writes the socket).
# Everything is created under a single disposable mktemp -d root and removed on exit.

set -eu

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

log() { printf '%s\n' "$*"; }
pass() { PASS_COUNT=$((PASS_COUNT + 1)); log "PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); log "FAIL: $*"; }
skip() { SKIP_COUNT=$((SKIP_COUNT + 1)); log "SKIP: $*"; }

fail_closed() {
  log "FAIL-CLOSED: $*"
  log "FAIL-CLOSED: isolation NOT exercised on this host -- this is not a pass, and it is not a production verification of anything."
  exit 2
}

# ---- Preflight: refuse to claim anything if the sandbox primitive itself is unusable.
if ! command -v bwrap >/dev/null 2>&1; then
  fail_closed "bwrap (bubblewrap) binary not found on PATH"
fi
if ! command -v python3 >/dev/null 2>&1; then
  fail_closed "python3 not found on PATH (needed for the disposable socket fixture)"
fi
if [ "$(uname -s)" != "Linux" ]; then
  fail_closed "this probe is Linux-specific (bwrap/user-namespaces); refusing to run on $(uname -s)"
fi

LIB64_BIND_ARGS=""
[ -d /lib64 ] && LIB64_BIND_ARGS="--ro-bind /lib64 /lib64"

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/linux-child-isolation-check.XXXXXX")
SIBLING_PID=""
SOCKET_SERVER_PID=""

cleanup() {
  [ -n "$SOCKET_SERVER_PID" ] && kill "$SOCKET_SERVER_PID" >/dev/null 2>&1 || true
  [ -n "$SIBLING_PID" ] && kill "$SIBLING_PID" >/dev/null 2>&1 || true
  rm -rf -- "$TMP_ROOT" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ---- Sandbox sanity check: can we even run a trivial unprivileged bwrap command?
if ! bwrap --unshare-all --die-with-parent \
     --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib $LIB64_BIND_ARGS \
     --proc /proc --dev /dev \
     -- /usr/bin/true >/dev/null 2>"$TMP_ROOT/bwrap-sanity.err"; then
  cat "$TMP_ROOT/bwrap-sanity.err" >&2 || true
  fail_closed "a trivial 'bwrap --unshare-all -- true' failed on this host (unprivileged user namespaces likely disabled) -- cannot exercise isolation, cannot verify anything"
fi

# ---- Fixture layout under one disposable tmp root:
#   $TMP_ROOT/sibling/   -- everything the child must NOT be able to reach
#   $TMP_ROOT/child/     -- the only directory bound into the sandbox
SIBLING_DIR="$TMP_ROOT/sibling"
CHILD_DIR="$TMP_ROOT/child"
mkdir -p "$SIBLING_DIR" "$CHILD_DIR"

SECRET_FILE="$SIBLING_DIR/secret.txt"
printf '%s\n' "dummy-marker-not-a-real-secret-$$-$(date +%s)" >"$SECRET_FILE"
chmod 600 "$SECRET_FILE"

RELAY_DB="$SIBLING_DIR/relay.db"
printf '%s\n' "dummy-disposable-relay-db-fixture" >"$RELAY_DB"

RELAY_SOCK="$SIBLING_DIR/relay.sock"
PY_SOCKET_CONNECT='
import socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(1)
try:
    s.connect(sys.argv[1])
    print("CONNECTED")
    sys.exit(0)
except OSError as e:
    print("REFUSED:", e)
    sys.exit(1)
'
PY_SOCKET_SERVE='
import os, socket, sys
path = sys.argv[1]
try:
    os.unlink(path)
except FileNotFoundError:
    pass
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind(path)
s.listen(1)
sys.stdout.write("ready\n")
sys.stdout.flush()
while True:
    conn, _ = s.accept()
    conn.close()
'

# Start the sibling "relay" process: a bare UNIX-socket listener representing a
# sibling process's DB/socket. Its PID doubles as the "sibling process" target for
# the /proc inspection check below.
python3 -c "$PY_SOCKET_SERVE" "$RELAY_SOCK" >"$TMP_ROOT/relay.ready" 2>"$TMP_ROOT/relay.err" &
SIBLING_PID=$!
SOCKET_SERVER_PID=$SIBLING_PID

for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -s "$TMP_ROOT/relay.ready" ] && break
  sleep 0.2
done
if [ ! -s "$TMP_ROOT/relay.ready" ] || [ ! -S "$RELAY_SOCK" ]; then
  cat "$TMP_ROOT/relay.err" >&2 || true
  fail_closed "could not start the disposable relay-socket fixture -- cannot exercise the relay-socket check"
fi

# ---- bwrap invocation used for every "inside the sandbox" attempt below.
# --unshare-all: new mount/pid/net/ipc/uts/cgroup/user namespaces (no network, no
#   visibility into the host PID table).
# --die-with-parent: no orphaned children if this script is killed.
# Only /usr,/bin,/lib(64),/etc are bound (read-only, needed to exec sh/python3), plus
# a private /proc, /dev and /tmp, plus the child's own scratch dir. The sibling dir,
# the host's /run and /var/run (where Docker's socket lives) are simply never bound,
# so under the fresh mount namespace they do not exist at all for the child.
bwrap_run() {
  bwrap \
    --unshare-all \
    --die-with-parent \
    --ro-bind /usr /usr \
    --ro-bind /bin /bin \
    --ro-bind /lib /lib \
    $LIB64_BIND_ARGS \
    --ro-bind /etc /etc \
    --proc /proc \
    --dev /dev \
    --tmpfs /tmp \
    --bind "$CHILD_DIR" "$CHILD_DIR" \
    --chdir "$CHILD_DIR" \
    --uid "$(id -u)" --gid "$(id -g)" \
    -- "$@"
}

# check_denied DESCRIPTION OUTSIDE_SHOULD_SUCCEED  -- then runs "$@" both outside and
# inside the sandbox as a POSIX-sh -c command string, asserting outside succeeds
# (fixture is real and reachable) and inside fails (sandbox actually blocked it).
check_denied() {
  desc=$1
  cmd=$2

  set +e
  sh -c "$cmd" >"$TMP_ROOT/outside.out" 2>"$TMP_ROOT/outside.err"
  outside_rc=$?
  set -e
  if [ "$outside_rc" -ne 0 ]; then
    fail "$desc -- SKIPPED-AS-INVALID: positive control failed outside the sandbox too (rc=$outside_rc), so this proves nothing about isolation"
    return
  fi

  # The outer shell must finish and report the inner command's status. A bwrap
  # launch failure or a child crash is NOT evidence that isolation denied access.
  set +e
  bwrap_run sh -c 'sh -c "$1"; code=$?; printf "CHECK_EXIT=%s\n" "$code"; exit 0' _ "$cmd" \
    >"$TMP_ROOT/inside.out" 2>"$TMP_ROOT/inside.err"
  sandbox_rc=$?
  set -e
  marker=$(tail -n 1 "$TMP_ROOT/inside.out")
  if [ "$sandbox_rc" -ne 0 ]; then
    fail "$desc -- bwrap/child failed before reporting the check result (rc=$sandbox_rc); proves nothing"
  elif [ "$marker" = 'CHECK_EXIT=0' ]; then
    fail "$desc -- child INSIDE the sandbox succeeded where it must not: $(cat "$TMP_ROOT/inside.out")"
  else
    case "$marker" in
      CHECK_EXIT=[1-9]*|CHECK_EXIT=[1-9])
        pass "$desc (reachable outside the sandbox, denied inside: ${marker#CHECK_EXIT=})" ;;
      *) fail "$desc -- no valid child check result; proves nothing (last line: $marker)" ;;
    esac
  fi
}

log "== linux-child-isolation-check: $(bwrap --version) on $(uname -sr) =="

check_denied "sibling secret file must not be readable" \
  "cat '$SECRET_FILE'"

check_denied "sibling relay-db fixture must not be visible" \
  "test -e '$RELAY_DB'"

check_denied "sibling relay UNIX socket must not be connectable" \
  "python3 -c '$PY_SOCKET_CONNECT' '$RELAY_SOCK'"

check_denied "sibling process's /proc/<pid>/environ must not be readable" \
  "test -r '/proc/$SIBLING_PID/environ' && cat '/proc/$SIBLING_PID/environ' >/dev/null"

check_denied "sibling process's /proc/<pid>/fd must not be listable" \
  "ls '/proc/$SIBLING_PID/fd' >/dev/null"

DOCKER_SOCK=""
for candidate in /var/run/docker.sock /run/docker.sock; do
  [ -S "$candidate" ] && DOCKER_SOCK=$candidate && break
done
if [ -n "$DOCKER_SOCK" ]; then
  check_denied "host Docker socket ($DOCKER_SOCK) must not be reachable (existence check only, never opened)" \
    "test -e '$DOCKER_SOCK'"
else
  skip "host Docker socket not present on this machine -- Docker-reachability check skipped, not asserted as passing"
fi

log ""
log "== summary: $PASS_COUNT passed, $FAIL_COUNT failed, $SKIP_COUNT skipped =="
if [ "$FAIL_COUNT" -gt 0 ]; then
  log "RESULT: FAIL -- child isolation was NOT demonstrated for at least one check."
  exit 1
fi
log "RESULT: PASS (probe only) -- see the top-of-file comment for what this does and does not prove. This is NOT a production security verification."
exit 0
