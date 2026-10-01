import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startRelay } from "./src/relay/server.ts";
import { RelayStore } from "./src/relay/store.ts";

function request(socket: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const peer = createConnection(socket);
    let text = "";
    peer.setEncoding("utf8");
    peer.on("connect", () => peer.end(payload));
    peer.on("data", (chunk: string) => {
      text += chunk;
    });
    peer.on("end", () => resolve(text));
    peer.on("error", reject);
  });
}

test("SIGKILL of standalone socket owner leaves recoverable committed state and stale socket", async () => {
  const state = mkdtempSync(join(tmpdir(), "pi-relay-daemon-"));
  const runtime = mkdtempSync(
    join(
      process.platform === "darwin" ? "/tmp" : tmpdir(),
      "pi-relay-runtime-",
    ),
  );
  const socket = join(runtime, "relay.sock");
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      new URL("./src/relay/server.ts", import.meta.url).pathname,
      state,
      runtime,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("server startup timed out")),
        5000,
      );
      child.stdout?.once("data", (chunk: Buffer) => {
        clearTimeout(timer);
        chunk.toString().includes("listening")
          ? resolve()
          : reject(new Error("server did not start"));
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`server exited early: ${code}`));
      });
    });
    assert.ok(existsSync(socket));
    assert.equal(
      JSON.parse(await request(socket, "ping\n")).status,
      "bootstrap_only",
    );
    child.kill("SIGKILL");
    await once(child, "exit");
    assert.ok(existsSync(socket));
    const recovered = await startRelay(state, runtime);
    try {
      assert.equal(
        JSON.parse(await request(recovered.socket, "ping\n")).status,
        "bootstrap_only",
      );
    } finally {
      await recovered.close();
    }
    const store = new RelayStore(state);
    try {
      assert.equal(store.epoch, 3);
    } finally {
      store.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    rmSync(state, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("bootstrap socket is private and does not expose unauthenticated registry writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-relay-server-"));
  const runtime = mkdtempSync(
    join(process.platform === "darwin" ? "/tmp" : tmpdir(), "pi-relay-sock-"),
  );
  try {
    await assert.rejects(startRelay(dir, dir), /separate private directories/);
    const relay = await startRelay(dir, runtime);
    try {
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      assert.equal(statSync(relay.socket).mode & 0o777, 0o600);
      assert.equal(statSync(runtime).mode & 0o777, 0o700);
      await assert.rejects(
        startRelay(dir, runtime),
        /SQLITE_BUSY|database is locked/,
      );
      for (let i = 0; i < 10; i++) {
        const impatient = createConnection(relay.socket);
        await new Promise<void>((resolve) =>
          impatient.once("connect", resolve),
        );
        impatient.on("error", () => {});
        impatient.destroy();
      }
      const reply = await request(relay.socket, '{"action":"reserve"}\n');
      assert.deepEqual(JSON.parse(reply), {
        version: 1,
        status: "bootstrap_only",
      });
    } finally {
      await relay.close();
    }
    const restarted = await startRelay(dir, runtime);
    await restarted.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});
