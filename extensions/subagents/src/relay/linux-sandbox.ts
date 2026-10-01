/**
 * linux-sandbox.ts — Linux per-child confinement launcher for the relay.
 *
 * This module builds the `bubblewrap` (bwrap) invocation that confines an
 * arbitrary child process so that same-UID code inside it cannot reach a
 * sibling child's bridge socket, the relay's private state, a sibling's
 * `/proc`, the host network, or the Docker socket. It is the OS boundary that
 * the mailbox contract (`06-durable-mailbox-contract`) makes a hard release
 * gate: a private socket + a token in the child's environment is explicitly
 * NOT sufficient, because same-UID code can read another process's
 * environment, fds and files.
 *
 * The design avoids a stealable credential entirely. The child is handed a
 * *capability*, not a secret: exactly one per-instance Unix socket, bind
 * mounted read-only at a fixed path (`/run/pi-bridge.sock`) inside its own
 * mount namespace. The relay maps that socket back to `{group, instance,
 * fence}` on the host side, so a connection that arrives on it is that
 * instance by construction. A sibling running arbitrary code cannot see the
 * socket (fresh tmpfs `/run`, no bind), cannot route to it (network namespace
 * unshared — no loopback, no abstract sockets), and cannot read any relay
 * file (nothing but the workspace and read-only system paths are bound). There
 * is therefore no token for a sibling to exfiltrate and no way to connect to
 * another instance's endpoint.
 *
 * IMPORTANT: this boundary only holds for code that is actually launched
 * through this confinement. A same-UID process that is NOT confined has the
 * user's full privileges (on some hosts that includes Docker-group / sudo
 * access). Callers therefore MUST fail closed — refuse to mint a bridge or run
 * an adapter — when {@link detectLinuxSandbox} reports the primitive is
 * unavailable, rather than launching an unconfined child.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";

/** Fixed in-sandbox path where the instance's bridge socket is mounted. */
export const SANDBOX_BRIDGE_SOCKET = "/run/pi-bridge.sock";
/** Fixed in-sandbox path where the child's writable workspace is mounted. */
export const SANDBOX_WORKSPACE = "/workspace";

/** Default read-only host paths a child needs to exec an interpreter. */
const DEFAULT_RO_BINDS = ["/usr", "/bin", "/lib", "/lib64", "/etc"] as const;

export interface SandboxCapability {
  /** True only when an unprivileged, network-isolated bwrap child actually ran. */
  readonly available: boolean;
  /** Human-readable reason when `available` is false (for fail-closed logs). */
  readonly reason: string;
  /** Resolved bwrap version string, when detected. */
  readonly bwrapVersion?: string;
}

export interface BuildSandboxArgvInput {
  /** bwrap executable (default `bwrap`, resolved on PATH). */
  readonly bwrapPath?: string;
  /** Host path of this instance's bridge socket; bound read-only into the child. */
  readonly hostBridgeSocket: string;
  /** Host path of the child's writable workspace; the only writable host bind. */
  readonly hostWorkspace: string;
  /** Program + args to run inside the sandbox. */
  readonly command: readonly string[];
  /** Override the read-only system binds (defaults cover a typical interpreter). */
  readonly roBinds?: readonly string[];
  /** Extra environment for the child; merged over the minimal safe base. */
  readonly extraEnv?: Readonly<Record<string, string>>;
}

export interface SandboxLaunchSpec {
  readonly argv: string[];
  /** Complete, controlled environment for the child (host env is NOT inherited). */
  readonly env: Record<string, string>;
}

function assertSafeAbsolute(label: string, path: string): void {
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path)) {
    throw new Error(`${label} must be an absolute path`);
  }
  if (normalize(path) !== path || path.split("/").includes("..")) {
    throw new Error(`${label} must be normalized and free of '..'`);
  }
}

/**
 * Build the argv + environment for a confined child. Pure and deterministic:
 * it performs no I/O so it can be unit-tested on any platform. Every hardening
 * invariant is enforced here so a caller cannot accidentally weaken it:
 *
 * - `--unshare-all` with NO `--share-net`: new user/pid/net/ipc/uts/cgroup/mount
 *   namespaces and no network reachability (loopback, abstract sockets, Docker).
 * - `--die-with-parent` and `--new-session`: no orphan survival, no terminal
 *   injection back into the parent session.
 * - fresh `/proc`, `/dev`, and tmpfs `/tmp` + `/run`: no sibling `/proc`, no
 *   inherited runtime dir.
 * - read-only system binds only; the single writable host path is the
 *   workspace; the bridge socket is bound read-only at a fixed path.
 * - the host relay state directory, `~/.pi`, and the Docker socket are never
 *   bound, so they simply do not exist in the child's mount namespace.
 * - the child's environment is fully replaced (no host secrets inherited).
 */
export function buildChildSandboxArgv(
  input: BuildSandboxArgvInput,
): SandboxLaunchSpec {
  const bwrap = input.bwrapPath ?? "bwrap";
  if (!Array.isArray(input.command) || input.command.length === 0) {
    throw new Error("Sandbox command must be a non-empty argv");
  }
  assertSafeAbsolute("hostBridgeSocket", input.hostBridgeSocket);
  assertSafeAbsolute("hostWorkspace", input.hostWorkspace);

  const roBinds = input.roBinds ?? DEFAULT_RO_BINDS;
  const argv: string[] = [
    bwrap,
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/run",
  ];

  for (const path of roBinds) {
    assertSafeAbsolute("roBind", path);
    // `--ro-bind-try` tolerates hosts that lack e.g. /lib64 without weakening
    // anything that is present.
    argv.push("--ro-bind-try", path, path);
  }

  argv.push("--ro-bind", input.hostBridgeSocket, SANDBOX_BRIDGE_SOCKET);
  argv.push("--bind", input.hostWorkspace, SANDBOX_WORKSPACE);
  argv.push("--chdir", SANDBOX_WORKSPACE);

  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid !== undefined) argv.push("--uid", String(uid));
  if (gid !== undefined) argv.push("--gid", String(gid));

  argv.push("--", ...input.command);

  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin",
    HOME: SANDBOX_WORKSPACE,
    TMPDIR: "/tmp",
    PI_BRIDGE_SOCKET: SANDBOX_BRIDGE_SOCKET,
    ...(input.extraEnv ?? {}),
  };

  return { argv, env };
}

/**
 * Probe whether unprivileged, network-isolated bwrap confinement actually
 * works on this host. Fails closed: any error, a missing binary, or a
 * non-Linux platform yields `available: false` with a reason. A caller must
 * treat anything other than `available: true` as "do not launch a child."
 */
export function detectLinuxSandbox(bwrapPath = "bwrap"): SandboxCapability {
  if (process.platform !== "linux") {
    return { available: false, reason: `not Linux (${process.platform})` };
  }
  let bwrapVersion: string | undefined;
  try {
    const version = spawnSync(bwrapPath, ["--version"], { encoding: "utf8" });
    if (version.status !== 0) {
      return {
        available: false,
        reason: `bwrap --version failed (${version.error?.message ?? version.status})`,
      };
    }
    bwrapVersion = version.stdout.trim();
  } catch (error) {
    return {
      available: false,
      reason: `bwrap not runnable: ${(error as Error).message}`,
    };
  }

  const trueBin = existsSync("/usr/bin/true")
    ? "/usr/bin/true"
    : existsSync("/bin/true")
      ? "/bin/true"
      : undefined;
  if (!trueBin) {
    return { available: false, reason: "no /bin/true to exercise the sandbox" };
  }

  // Run a real confined child with the network namespace unshared. If
  // unprivileged user namespaces are disabled, this exits non-zero and we do
  // NOT claim isolation.
  const roBinds: string[] = [];
  for (const path of DEFAULT_RO_BINDS) {
    if (existsSync(path)) roBinds.push("--ro-bind", path, path);
  }
  const probe = spawnSync(
    bwrapPath,
    [
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      ...roBinds,
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--tmpfs",
      "/run",
      "--",
      trueBin,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (probe.status !== 0) {
    return {
      available: false,
      reason: `confined 'true' failed (unprivileged user namespaces likely disabled): ${
        probe.stderr?.trim() || probe.error?.message || `exit ${probe.status}`
      }`,
      bwrapVersion,
    };
  }
  return { available: true, reason: "ok", bwrapVersion };
}
