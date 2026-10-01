import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  chmodSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { RelayOwnership } from "./src/relay/ownership.ts";

test("one relay owns the directory, lock survives process death without stale PID cleanup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-relay-lock-"));
  chmodSync(dir, 0o700);
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `import { RelayOwnership } from ${JSON.stringify(new URL("./src/relay/ownership.ts", import.meta.url).href)}; RelayOwnership.acquire(${JSON.stringify(dir)}); console.log("ready"); setInterval(() => {}, 1000);`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("lock child timed out")),
        5000,
      );
      child.stdout?.once("data", (chunk: Buffer) => {
        clearTimeout(timer);
        chunk.toString().includes("ready")
          ? resolve()
          : reject(new Error("child did not acquire lock"));
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`child exited: ${code}`));
      });
    });
    assert.throws(
      () => RelayOwnership.acquire(dir),
      /SQLITE_BUSY|database is locked/,
    );
    child.kill("SIGKILL");
    await once(child, "exit");
    const next = RelayOwnership.acquire(dir);
    next.close();
    next.close();
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects world-readable directory and symlinked lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-relay-permissions-"));
  try {
    chmodSync(dir, 0o755);
    assert.throws(() => RelayOwnership.acquire(dir), /not private/);
    chmodSync(dir, 0o700);
    writeFileSync(join(dir, "target"), "");
    symlinkSync(join(dir, "target"), join(dir, "owner.sqlite"));
    assert.throws(() => RelayOwnership.acquire(dir), /not private/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
