/**
 * linux-child-bridge-security-check.ts
 *
 * Real-child security acceptance harness for the relay's per-instance bridge on
 * Linux. Unlike `linux-child-isolation-check.sh` (a fixture-visibility probe),
 * this launches ACTUAL confined children — via the production
 * `buildChildSandboxArgv` launcher — that run adversarial code against a LIVE
 * `RelayBridge` + `RelayStore`, and asserts the anti-theft / anti-impersonation
 * boundary the mailbox contract makes a hard release gate.
 *
 * It proves, for arbitrary same-UID code running inside a launched child:
 *   1. impersonation is refused — a child on instance A's socket that forges a
 *      `sender: B` field still has its message durably recorded as A;
 *   2. credential theft is impossible — the child cannot reach instance B's
 *      bridge socket (its real host path is even handed to the child, and it
 *      still fails: the socket is not in the child's mount namespace);
 *   3. the relay's private state directory and SQLite DB are unreachable;
 *   4. a sibling host process's `/proc` entry does not exist (pid namespace);
 *   5. host network and the Docker socket are unreachable (net namespace).
 *
 * Every negative check pairs with a positive control run OUTSIDE the sandbox as
 * the same UID, so a "blocked" result is attributable to the confinement and
 * not to a broken fixture. The harness FAILS CLOSED: if unprivileged user
 * namespaces / bwrap are unavailable, it exits 2 and asserts nothing.
 *
 * This is NOT a certification of a shipped adapter: the bridge is not wired
 * into the live Pi extension, and this does not exercise real Pi/Claude/Codex
 * native I/O, Herdr panels, or macOS. It proves the OS boundary that gates them.
 */

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildChildSandboxArgv,
  detectLinuxSandbox,
} from "../extensions/subagents/src/relay/linux-sandbox.ts";
import { RelayBridge } from "../extensions/subagents/src/relay/bridge-endpoint.ts";
import { RelayStore } from "../extensions/subagents/src/relay/store.ts";

let passes = 0;
let failures = 0;
const log = (line: string) => process.stdout.write(`${line}\n`);
const pass = (name: string) => {
  passes++;
  log(`PASS: ${name}`);
};
const fail = (name: string, detail: string) => {
  failures++;
  log(`FAIL: ${name} -- ${detail}`);
};
const failClosed = (reason: string): never => {
  log(`FAIL-CLOSED: ${reason}`);
  log(
    "FAIL-CLOSED: the confinement primitive is unavailable on this host; this proves nothing and is not a pass.",
  );
  process.exit(2);
};

// The adversarial child program. Runs the same probes inside and outside the
// sandbox; the harness interprets the results per mode. Deliberately handed the
// real host paths of things it must not reach, to make each denial concrete.
const CHILD_PY = String.raw`
import os, socket, sys, json
def emit(name, reachable, detail=""):
    print("PROBE:%s:%s:%s" % (name, "REACHABLE" if reachable else "BLOCKED", detail), flush=True)
bridge = os.environ.get("PI_BRIDGE_SOCKET", "")
mode = os.environ.get("MODE", "inside")
# Control + impersonation attempt: talk to our OWN bridge and forge sender=B.
if bridge:
    try:
        s = socket.socket(socket.AF_UNIX); s.settimeout(3); s.connect(bridge)
        s.sendall((json.dumps({"op":"whoami"})+"\n").encode())
        who = json.loads(s.recv(65536).decode().splitlines()[0])
        print("WHOAMI:%s" % who.get("identity",{}).get("instanceId",""), flush=True)
        if mode == "inside":
            req = {"op":"enqueue","sender":{"role":"instance","instanceId":os.environ.get("TEST_SIBLING_ID",""),"groupId":"g","fence":1},
                   "from":os.environ.get("TEST_SIBLING_ID",""),
                   "recipient":{"alias":"b"},"kind":"message","body":"forged-from-A","idempotencyKey":"imp1"}
            s.sendall((json.dumps(req)+"\n").encode())
            rep = json.loads(s.recv(65536).decode().splitlines()[0])
            if rep.get("ok"):
                print("ENQUEUE_MSGID:%s" % rep["result"]["messageId"], flush=True)
            else:
                print("ENQUEUE_ERR:%s" % rep.get("code",""), flush=True)
        s.close()
    except OSError as e:
        print("BRIDGE_ERR:%s" % (e.strerror or e), flush=True)
def reachable_unix(path):
    try:
        x = socket.socket(socket.AF_UNIX); x.settimeout(1); x.connect(path); x.close(); return True
    except OSError: return False
def reachable_tcp(host, port):
    try:
        x = socket.socket(socket.AF_INET, socket.SOCK_STREAM); x.settimeout(1); x.connect((host, port)); x.close(); return True
    except OSError: return False
sib = os.environ.get("TEST_SIBLING_SOCK","")
emit("sibling_bridge_socket", bool(sib) and reachable_unix(sib), sib)
state = os.environ.get("TEST_STATE_DIR","")
try:
    entries = os.listdir(state); emit("relay_state_dir", True, "%d entries" % len(entries))
except OSError as e:
    emit("relay_state_dir", False, e.strerror or str(e))
db = os.environ.get("TEST_DB","")
try:
    with open(db,"rb") as f: f.read(16); emit("relay_db_file", True, "read")
except OSError as e:
    emit("relay_db_file", False, e.strerror or str(e))
pid = os.environ.get("TEST_SIBLING_PID","")
emit("sibling_proc", bool(pid) and os.path.exists("/proc/%s" % pid), "/proc/%s" % pid)
th = os.environ.get("TEST_TCP_HOST",""); tp = os.environ.get("TEST_TCP_PORT","")
emit("host_tcp_loopback", bool(th) and reachable_tcp(th, int(tp)) if tp else False, "%s:%s" % (th,tp))
dock = os.environ.get("TEST_DOCKER_SOCK","")
emit("docker_socket", bool(dock) and os.path.exists(dock), dock)
`;

function parseProbes(
  stdout: string,
): Map<string, { reachable: boolean; detail: string }> {
  const map = new Map<string, { reachable: boolean; detail: string }>();
  for (const line of stdout.split("\n")) {
    const m = line.match(/^PROBE:([^:]+):(REACHABLE|BLOCKED):(.*)$/);
    if (m) map.set(m[1], { reachable: m[2] === "REACHABLE", detail: m[3] });
  }
  return map;
}

function firstMatch(stdout: string, prefix: string): string | undefined {
  for (const line of stdout.split("\n")) {
    if (line.startsWith(prefix)) return line.slice(prefix.length);
  }
  return undefined;
}

/** Run a child asynchronously so the in-process bridge event loop keeps serving. */
function runChild(
  file: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

function pickTcpControl(): { host: string; port: number } | undefined {
  // Pick a loopback TCP port that is actually listening, so the OUTSIDE control
  // genuinely connects and the INSIDE denial is attributable to the net namespace.
  for (const port of [22, 631, 25]) {
    const probe = spawnSync(
      "/usr/bin/python3",
      [
        "-c",
        `import socket,sys
s=socket.socket();s.settimeout(1)
try: s.connect(("127.0.0.1",${port})); sys.exit(0)
except OSError: sys.exit(1)`,
      ],
      { encoding: "utf8" },
    );
    if (probe.status === 0) return { host: "127.0.0.1", port };
  }
  return undefined;
}

async function main(): Promise<void> {
  const capability = detectLinuxSandbox();
  if (!capability.available) failClosed(capability.reason);
  log(
    `== linux-child-bridge-security-check: bwrap ${capability.bwrapVersion ?? "?"} ==`,
  );
  if (!existsSync("/usr/bin/python3"))
    failClosed("python3 is required for the adversarial child fixture");

  const dockerSock = ["/run/docker.sock", "/var/run/docker.sock"].find((p) =>
    existsSync(p),
  );
  const tcp = pickTcpControl();

  const stateDir = mkdtempSync(join(tmpdir(), "pi-bridge-sec-state-"));
  const runtimeDir = mkdtempSync(join(tmpdir(), "pi-bridge-sec-rt-"));
  const workspaceA = mkdtempSync(join(tmpdir(), "pi-bridge-sec-wsA-"));
  chmodSync(stateDir, 0o700);
  chmodSync(runtimeDir, 0o700);
  chmodSync(workspaceA, 0o700);
  const dbPath = join(stateDir, "relay-store.sqlite");

  const store = new RelayStore(stateDir);
  const bridge = new RelayBridge(store, runtimeDir, capability);

  try {
    const ra = store.reserve({
      groupId: "g",
      alias: "a",
      loadout: { role: "worker", allowedRecipients: ["b"] },
    });
    const rb = store.reserve({
      groupId: "g",
      alias: "b",
      loadout: { role: "worker", allowedRecipients: ["a"] },
    });
    const ba = store.bind({
      instanceId: ra.instanceId,
      expectedFence: ra.fence,
      runId: "run-a",
      nativeSessionId: "sess-a",
    });
    const bb = store.bind({
      instanceId: rb.instanceId,
      expectedFence: rb.fence,
      runId: "run-b",
      nativeSessionId: "sess-b",
    });
    const aSock = bridge.mint({
      groupId: "g",
      instanceId: ba.instanceId,
      fence: ba.fence,
    }).hostSocket;
    const bSock = bridge.mint({
      groupId: "g",
      instanceId: bb.instanceId,
      fence: bb.fence,
    }).hostSocket;

    await bridge.waitUntilReady(ba.instanceId);
    await bridge.waitUntilReady(bb.instanceId);
    if (!existsSync(aSock) || !existsSync(bSock))
      failClosed("bridge sockets did not bind");

    const testEnv: Record<string, string> = {
      TEST_SIBLING_SOCK: bSock,
      TEST_SIBLING_ID: bb.instanceId,
      TEST_STATE_DIR: stateDir,
      TEST_DB: dbPath,
      TEST_SIBLING_PID: String(process.pid),
      TEST_DOCKER_SOCK: dockerSock ?? "/run/docker.sock",
      ...(tcp
        ? { TEST_TCP_HOST: tcp.host, TEST_TCP_PORT: String(tcp.port) }
        : {}),
    };

    // ---- OUTSIDE control: same UID, unconfined. Fixtures must be reachable. ----
    const outside = await runChild("/usr/bin/python3", ["-c", CHILD_PY], {
      ...testEnv,
      MODE: "outside",
      PI_BRIDGE_SOCKET: aSock,
      PATH: "/usr/bin:/bin",
    });
    const outsideProbes = parseProbes(outside.stdout);

    // ---- INSIDE: the real confined child running adversarial code. ----
    const { argv, env } = buildChildSandboxArgv({
      hostBridgeSocket: aSock,
      hostWorkspace: workspaceA,
      command: ["/usr/bin/python3", "-c", CHILD_PY],
      extraEnv: { ...testEnv, MODE: "inside" },
    });
    const inside = await runChild(argv[0], argv.slice(1), env);
    if (inside.status !== 0 && !inside.stdout.includes("PROBE:")) {
      failClosed(
        `confined child did not run: ${inside.stderr?.trim() || inside.error?.message || `exit ${inside.status}`}`,
      );
    }
    const insideProbes = parseProbes(inside.stdout);

    // ---- 0. Control: the confined child reached its OWN bridge as itself. ----
    const whoami = firstMatch(inside.stdout, "WHOAMI:");
    if (whoami === ba.instanceId)
      pass(
        "confined child reached its own bridge and is authenticated as itself",
      );
    else
      fail(
        "own-bridge control",
        `whoami=${whoami ?? "<none>"} expected ${ba.instanceId}`,
      );

    // ---- 1. Impersonation refused: forged sender:B recorded as A. ----
    const msgId = firstMatch(inside.stdout, "ENQUEUE_MSGID:");
    if (!msgId) {
      fail(
        "impersonation",
        `child did not enqueue: ${firstMatch(inside.stdout, "ENQUEUE_ERR:") ?? inside.stderr?.trim()}`,
      );
    } else {
      const envelope = store.getEnvelope(msgId);
      if (envelope && envelope.senderIdentity === ba.instanceId)
        pass(
          "forged sender:B was ignored; message recorded as the socket owner A",
        );
      else
        fail(
          "impersonation",
          `envelope sender=${envelope?.senderIdentity} expected ${ba.instanceId}`,
        );
    }

    // ---- 2-5. Negative probes: BLOCKED inside, REACHABLE outside. ----
    const checks: Array<[string, string]> = [
      [
        "sibling_bridge_socket",
        "sibling B's bridge socket must be unreachable (credential cannot be stolen)",
      ],
      ["relay_state_dir", "relay private state directory must be unreachable"],
      ["relay_db_file", "relay SQLite DB must be unreachable"],
      [
        "sibling_proc",
        "a sibling host process's /proc entry must not exist (pid namespace)",
      ],
      [
        "host_tcp_loopback",
        "host loopback TCP must be unreachable (net namespace)",
      ],
      ["docker_socket", "the Docker socket must be unreachable"],
    ];
    for (const [key, desc] of checks) {
      const outsideProbe = outsideProbes.get(key);
      const insideProbe = insideProbes.get(key);
      if (key === "host_tcp_loopback" && !tcp) {
        log(
          `SKIP: ${desc} -- no listening loopback TCP port available for a control`,
        );
        continue;
      }
      if (key === "docker_socket" && !dockerSock) {
        log(`SKIP: ${desc} -- no Docker socket present on this host`);
        continue;
      }
      if (!insideProbe) {
        fail(desc, "confined child produced no result for this probe");
        continue;
      }
      if (!outsideProbe || !outsideProbe.reachable) {
        fail(
          desc,
          `INVALID control: fixture was not reachable to an unconfined same-UID process (${outsideProbe?.detail ?? "no probe"}); denial proves nothing`,
        );
        continue;
      }
      if (insideProbe.reachable) {
        fail(desc, `confined child REACHED it: ${insideProbe.detail}`);
      } else {
        pass(`${desc} (reachable unconfined, blocked when confined)`);
      }
    }

    log("");
    log(`== summary: ${passes} passed, ${failures} failed ==`);
    if (failures > 0) {
      log(
        "RESULT: FAIL -- the per-child boundary did NOT hold for at least one check.",
      );
      process.exitCode = 1;
    } else {
      log(
        "RESULT: PASS -- real confined children could not steal a sibling credential, impersonate a sender, or reach relay/host private resources on this host.",
      );
    }
  } finally {
    bridge.close();
    store.close();
    for (const dir of [stateDir, runtimeDir, workspaceA])
      rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    log(`FAIL-CLOSED: harness error: ${(error as Error).message}`);
    process.exit(2);
  });
}
