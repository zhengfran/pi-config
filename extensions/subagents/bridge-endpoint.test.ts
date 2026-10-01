import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RelayBridge } from "./src/relay/bridge-endpoint.ts";
import { RelayStore } from "./src/relay/store.ts";
import type { SandboxCapability } from "./src/relay/linux-sandbox.ts";

const AVAILABLE: SandboxCapability = { available: true, reason: "test-stub" };

function privateDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(dir, 0o700);
  return dir;
}

/** Send one JSON request over a bridge socket and resolve its single JSON reply. */
function bridgeRequest(
  socketPath: string,
  request: unknown,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const peer = createConnection(socketPath);
    let text = "";
    peer.setEncoding("utf8");
    peer.on("connect", () => peer.write(`${JSON.stringify(request)}\n`));
    peer.on("data", (chunk: string) => {
      text += chunk;
      const nl = text.indexOf("\n");
      if (nl >= 0) {
        peer.end();
        try {
          resolve(JSON.parse(text.slice(0, nl)));
        } catch (error) {
          reject(error);
        }
      }
    });
    peer.on("error", reject);
  });
}

async function withFixture(
  run: (ctx: {
    store: RelayStore;
    bridge: RelayBridge;
    a: { instanceId: string; fence: number; socket: string };
    b: { instanceId: string; fence: number; socket: string };
  }) => Promise<void>,
): Promise<void> {
  const stateDir = privateDir("pi-bridge-state-");
  const runtimeDir = privateDir("pi-bridge-runtime-");
  const store = new RelayStore(stateDir);
  const bridge = new RelayBridge(store, runtimeDir, AVAILABLE);
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
    await run({
      store,
      bridge,
      a: { instanceId: ba.instanceId, fence: ba.fence, socket: aSock },
      b: { instanceId: bb.instanceId, fence: bb.fence, socket: bSock },
    });
  } finally {
    bridge.close();
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true });
  }
}

test("a connection is authenticated by its socket, not by any request field", async () => {
  await withFixture(async ({ a }) => {
    const who = await bridgeRequest(a.socket, { op: "whoami" });
    assert.equal(who.ok, true);
    assert.deepEqual(
      (who.identity as { instanceId: string }).instanceId,
      a.instanceId,
    );
  });
});

test("a child on A's socket that claims to be B is still recorded as A", async () => {
  await withFixture(async ({ store, a, b }) => {
    const reply = await bridgeRequest(a.socket, {
      op: "enqueue",
      // Forged identity fields that MUST be ignored:
      sender: {
        role: "instance",
        instanceId: b.instanceId,
        groupId: "g",
        fence: b.fence,
      },
      from: b.instanceId,
      recipient: { alias: "b" },
      kind: "message",
      body: "hello from the real A",
      idempotencyKey: "k1",
    });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    const messageId = (reply.result as { messageId: string }).messageId;
    const envelope = store.getEnvelope(messageId);
    assert.ok(envelope);
    // The durable sender identity is A (the socket owner), never the forged B.
    assert.equal(envelope!.senderIdentity, a.instanceId);
    assert.notEqual(envelope!.senderIdentity, b.instanceId);
  });
});

test("a child cannot address a recipient outside its loadout allowlist", async () => {
  await withFixture(async ({ store, a }) => {
    // A's loadout allows only "b"; create an unlisted third instance "c".
    const rc = store.reserve({
      groupId: "g",
      alias: "c",
      loadout: { role: "worker", allowedRecipients: [] },
    });
    store.bind({
      instanceId: rc.instanceId,
      expectedFence: rc.fence,
      runId: "run-c",
    });
    const reply = await bridgeRequest(a.socket, {
      op: "enqueue",
      recipient: { instanceId: rc.instanceId },
      kind: "message",
      body: "unauthorized",
      idempotencyKey: "k2",
    });
    assert.equal(reply.ok, false);
    assert.match(String(reply.code), /invalid_state|not_found/);
  });
});

test("settleResult over the bridge writes the socket owner's own result only", async () => {
  await withFixture(async ({ store, a }) => {
    const reply = await bridgeRequest(a.socket, {
      op: "settleResult",
      runId: "run-a",
      result: { text: "done" },
      idempotencyKey: "r1",
    });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    const results = store.listResults("g");
    assert.equal(results.length, 1);
    assert.equal(results[0].instanceId, a.instanceId);
  });
});

test("re-minting for a rotated fence revokes the old socket", async () => {
  await withFixture(async ({ store, bridge, a }) => {
    // Release then re-reserve/bind to advance the fence, then re-mint.
    const released = store.release({
      instanceId: a.instanceId,
      expectedFence: a.fence,
      reason: "test rotation",
    });
    const oldSocket = a.socket;
    // A fresh mint with a new fence must revoke and unlink the old socket file.
    bridge.mint({
      groupId: "g",
      instanceId: a.instanceId,
      fence: released.fence,
    });
    await bridge.waitUntilReady(a.instanceId);
    await assert.rejects(
      bridgeRequest(oldSocket, { op: "whoami" }),
      /ENOENT|ECONNREFUSED/,
    );
  });
});

test("a stale bridge identity cannot write after the instance is rebound at a new fence", async () => {
  await withFixture(async ({ store, bridge, a }) => {
    const staleSocket = a.socket; // minted at the original fence
    // Ownership changes: release, re-reserve is not needed — reconcile via a
    // fresh bind after the slot frees, advancing the fence to a new writer.
    const released = store.release({
      instanceId: a.instanceId,
      expectedFence: a.fence,
      reason: "ownership handoff",
    });
    // The old socket is still open until the relay re-mints; but the store must
    // reject any write carrying the stale fence, because a.fence is no longer
    // the current writer. Prove it directly against the still-live old socket
    // BEFORE re-minting revokes it.
    const reply = await bridgeRequest(staleSocket, {
      op: "enqueue",
      recipient: { alias: "b" },
      kind: "message",
      body: "stale writer",
      idempotencyKey: "stale1",
    });
    assert.equal(reply.ok, false);
    assert.match(String(reply.code), /fence_mismatch|invalid_state/);
    const staleRead = await bridgeRequest(staleSocket, { op: "listMine" });
    assert.equal(staleRead.ok, false, "a stale socket must not read its inbox");
    assert.equal(staleRead.code, "fence_mismatch");
    const staleIdentity = await bridgeRequest(staleSocket, { op: "whoami" });
    assert.equal(staleIdentity.ok, false);
    assert.equal(staleIdentity.code, "fence_mismatch");
    // Release advances the fence; no socket may read or write until an
    // authorized native reconciliation binds a new writer.
    assert.ok(released.fence > a.fence);
  });
});

test("the bridge refuses to construct without a proven confinement boundary", () => {
  const stateDir = privateDir("pi-bridge-failclosed-");
  const runtimeDir = privateDir("pi-bridge-failclosed-rt-");
  const store = new RelayStore(stateDir);
  try {
    assert.throws(
      () =>
        new RelayBridge(store, runtimeDir, {
          available: false,
          reason: "user namespaces disabled",
        }),
      /confinement boundary/,
    );
  } finally {
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});
