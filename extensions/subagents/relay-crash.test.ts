import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CapacityError, RelayStore } from "./src/relay/store.ts";

function crashedWorker(
  dir: string,
  action: string,
  maxDiskBytes?: number,
): Promise<void> {
  const url = new URL("./src/relay/store.ts", import.meta.url).href;
  const script = `
    import { RelayStore } from ${JSON.stringify(url)};
    import { DatabaseSync } from 'node:sqlite';
    const store = new RelayStore(${JSON.stringify(dir)}, { maxInstances: 2, ${maxDiskBytes ? `maxDiskBytes: ${maxDiskBytes}` : ""} });
    ${action}
    console.log('ready');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", script],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return new Promise<void>((resolve, reject) => {
    let output = "";
    let errors = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`worker timed out: ${output} ${errors}`));
    }, 5000);
    child.stderr?.on("data", (data: Buffer) => {
      errors += data.toString();
    });
    child.stdout?.on("data", (data: Buffer) => {
      output += data.toString();
      if (!output.includes("ready")) return;
      clearTimeout(timer);
      child.kill("SIGKILL");
      void once(child, "exit").then(() => resolve(), reject);
    });
    child.once("exit", (code) => {
      if (!output.includes("ready")) {
        clearTimeout(timer);
        reject(new Error(`worker exited before ready (${code}): ${errors}`));
      }
    });
  });
}

test("SIGKILL after committed reservation, message and result retains all three; admission is not freed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-relay-crash-"));
  try {
    await crashedWorker(
      dir,
      `
      const a = store.reserve({ groupId: 'g', alias: 'a', loadout: { role: 'worker' }, idempotencyKey: 'reserve-a' });
      const b = store.reserve({ groupId: 'g', alias: 'b', loadout: { role: 'worker' } });
      const active = store.bind({ instanceId: a.instanceId, expectedFence: a.fence, runId: 'run-a' });
      store.enqueue({ sender: { role: 'parent', groupId: 'g' }, recipient: { instanceId: b.instanceId }, kind: 'message', bodyUtf8: 'committed', idempotencyKey: 'send-1' });
      store.settleResult({ instanceId: a.instanceId, expectedFence: active.fence, runId: 'run-a', resultJson: { text: 'saved' } });
    `,
    );
    const recovered = new RelayStore(dir, { maxInstances: 2 });
    try {
      assert.equal(recovered.epoch, 2);
      assert.equal(recovered.resolveByAlias("g", "a")?.status, "unknown");
      assert.equal(recovered.resolveByAlias("g", "b")?.status, "unknown");
      assert.throws(
        () =>
          recovered.reserve({
            groupId: "g",
            alias: "c",
            loadout: { role: "worker" },
          }),
        CapacityError,
      );
      const b = recovered.resolveByAlias("g", "b")!;
      const first = recovered.listUnresolvedForRecipient(b.instanceId);
      assert.equal(first.length, 1);
      assert.equal(first[0]?.bodyUtf8, "committed");
      const retry = recovered.enqueue({
        sender: { role: "parent", groupId: "g" },
        recipient: { instanceId: b.instanceId },
        kind: "message",
        bodyUtf8: "committed",
        idempotencyKey: "send-1",
      });
      assert.equal(retry.messageId, first[0]?.messageId);
      assert.deepEqual(recovered.listResults("g")[0]?.result, {
        text: "saved",
      });
    } finally {
      recovered.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a hot journal after SIGKILL near the physical cap stays under budget and recovers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-relay-hot-journal-"));
  const budget = 1024 * 1024;
  const bytes = () =>
    [
      "owner.sqlite",
      "owner.sqlite-journal",
      "relay-store.sqlite",
      "relay-store.sqlite-journal",
    ].reduce(
      (total, name) =>
        total +
        (existsSync(join(dir, name))
          ? statSync(join(dir, name)).blocks * 512
          : 0),
      0,
    );
  try {
    await crashedWorker(
      dir,
      `
      const b = store.reserve({ groupId: 'g', alias: 'b', loadout: { role: 'worker' } });
      for (let i = 0; i < 50; i++) {
        try { store.enqueue({ sender: { role: 'parent', groupId: 'g' }, recipient: { instanceId: b.instanceId }, kind: 'message', bodyUtf8: 'x'.repeat(60*1024), idempotencyKey: 'k'+i }); }
        catch (error) { if (error.code !== 'capacity_exceeded') throw error; break; }
      }
      const db = new DatabaseSync(${JSON.stringify(join(dir, "relay-store.sqlite"))});
      db.exec('PRAGMA cache_spill=OFF; BEGIN IMMEDIATE');
      db.prepare("UPDATE envelopes SET body_utf8 = body_utf8 || ' '").run();
    `,
      budget,
    );
    assert.ok(
      bytes() <= budget,
      `hot-journal footprint ${bytes()} exceeds ${budget}`,
    );
    const recovered = new RelayStore(dir, { maxDiskBytes: budget });
    try {
      assert.ok(recovered.resolveByAlias("g", "b"));
      assert.ok(bytes() <= budget);
    } finally {
      recovered.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SIGKILL during an uncommitted SQLite transaction rolls it back before relay restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-relay-rollback-"));
  try {
    await crashedWorker(
      dir,
      `
      const db = new DatabaseSync(${JSON.stringify(join(dir, "relay-store.sqlite"))});
      db.exec('BEGIN IMMEDIATE');
      db.prepare("INSERT INTO meta (key, value) VALUES ('inflight', 'must_rollback')").run();
    `,
    );
    const store = new RelayStore(dir);
    store.close();
    const db = new DatabaseSync(join(dir, "relay-store.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(
        db.prepare("SELECT value FROM meta WHERE key = 'inflight'").get(),
        undefined,
      );
      assert.equal(
        (
          db.prepare("SELECT value FROM meta WHERE key = 'epoch'").get() as {
            value: string;
          }
        ).value,
        "2",
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
