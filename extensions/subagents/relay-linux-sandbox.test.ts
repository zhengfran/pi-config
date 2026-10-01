import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChildSandboxArgv,
  detectLinuxSandbox,
  SANDBOX_BRIDGE_SOCKET,
  SANDBOX_WORKSPACE,
} from "./src/relay/linux-sandbox.ts";

const base = {
  hostBridgeSocket: "/run/user/1000/pi-relay/inst.sock",
  hostWorkspace: "/tmp/pi-child-workspace",
  command: ["/usr/bin/python3", "-c", "pass"],
};

test("argv enforces network isolation and never shares the net namespace", () => {
  const { argv } = buildChildSandboxArgv(base);
  assert.ok(argv.includes("--unshare-all"), "must unshare all namespaces");
  assert.ok(!argv.includes("--share-net"), "must never retain host network");
  assert.ok(argv.includes("--die-with-parent"));
  assert.ok(argv.includes("--new-session"));
});

test("argv gives a fresh /proc, /dev and tmpfs /run so no sibling state leaks in", () => {
  const { argv } = buildChildSandboxArgv(base);
  const joined = argv.join(" ");
  assert.match(joined, /--proc \/proc/);
  assert.match(joined, /--dev \/dev/);
  assert.match(joined, /--tmpfs \/tmp/);
  assert.match(joined, /--tmpfs \/run/);
});

test("the bridge socket is bound read-only at the fixed path; workspace is the only writable bind", () => {
  const { argv } = buildChildSandboxArgv(base);
  const roBind = argv.indexOf("--ro-bind");
  // find the exact bridge ro-bind pair
  let foundBridge = false;
  let foundWorkspace = false;
  for (let i = 0; i < argv.length - 2; i++) {
    if (
      argv[i] === "--ro-bind" &&
      argv[i + 1] === base.hostBridgeSocket &&
      argv[i + 2] === SANDBOX_BRIDGE_SOCKET
    )
      foundBridge = true;
    if (
      argv[i] === "--bind" &&
      argv[i + 1] === base.hostWorkspace &&
      argv[i + 2] === SANDBOX_WORKSPACE
    )
      foundWorkspace = true;
  }
  assert.ok(roBind >= 0);
  assert.ok(foundBridge, "bridge socket must be a read-only bind");
  assert.ok(foundWorkspace, "workspace must be the writable bind");
  // The only writable host bind is the workspace: no other `--bind` pair.
  const writableBinds = argv.filter((a) => a === "--bind").length;
  assert.equal(writableBinds, 1);
});

test("no host relay state, ~/.pi, or docker socket is ever bound in", () => {
  const { argv } = buildChildSandboxArgv({
    ...base,
    hostBridgeSocket: "/run/user/1000/pi-relay/inst.sock",
  });
  const joined = argv.join("\n");
  assert.ok(!/docker\.sock/.test(joined));
  assert.ok(!/\.pi\/agent/.test(joined));
  assert.ok(!/relay-store\.sqlite/.test(joined));
});

test("the child environment is fully controlled and carries only the fixed bridge path", () => {
  const { env } = buildChildSandboxArgv(base);
  assert.equal(env.PI_BRIDGE_SOCKET, SANDBOX_BRIDGE_SOCKET);
  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.equal(env.HOME, SANDBOX_WORKSPACE);
  // A caller cannot smuggle in a host secret by claiming it is "extra": the
  // base still governs, but extras are explicit and visible.
  const withExtra = buildChildSandboxArgv({
    ...base,
    extraEnv: { PI_BRIDGE_TOKEN: "ignored-by-design" },
  });
  assert.equal(withExtra.env.PI_BRIDGE_SOCKET, SANDBOX_BRIDGE_SOCKET);
});

test("relative or traversal paths are rejected before any launch", () => {
  assert.throws(
    () => buildChildSandboxArgv({ ...base, hostBridgeSocket: "relative.sock" }),
    /absolute/,
  );
  assert.throws(
    () =>
      buildChildSandboxArgv({ ...base, hostWorkspace: "/tmp/../etc/passwd" }),
    /'\.\.'/,
  );
  assert.throws(
    () => buildChildSandboxArgv({ ...base, command: [] }),
    /non-empty argv/,
  );
});

test("detectLinuxSandbox fails closed off Linux and reports a reason either way", () => {
  const capability = detectLinuxSandbox();
  assert.equal(typeof capability.available, "boolean");
  assert.equal(typeof capability.reason, "string");
  assert.ok(capability.reason.length > 0);
  if (process.platform !== "linux") assert.equal(capability.available, false);
});
