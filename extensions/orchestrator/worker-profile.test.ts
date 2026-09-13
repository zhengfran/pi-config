import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("pi-worker removes inherited orchestration credentials and disables extension discovery", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worker-profile-"));
  try {
    const probe = join(dir, "probe.sh");
    writeFileSync(
      probe,
      '#!/bin/sh\nprintf \'profile=%s socket=%s client=%s token=%s\\n\' "$ZZC_ORCHESTRATOR_PROFILE" "$ZZC_ORCHESTRATOR_SOCKET" "$ZZC_ORCHESTRATOR_CLIENT_ID" "$ZZC_ORCHESTRATOR_TOKEN"\nprintf \'%s\\n\' "$@"\n',
    );
    chmodSync(probe, 0o755);
    const result = spawnSync(
      process.execPath,
      ["profiles/pi-worker.mjs", "--model", "provider/model"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          PI_WORKER_BINARY: probe,
          ZZC_ORCHESTRATOR_PROFILE: "project",
          ZZC_ORCHESTRATOR_SOCKET: "/private/socket",
          ZZC_ORCHESTRATOR_CLIENT_ID: "project-pi",
          ZZC_ORCHESTRATOR_TOKEN: "secret-token",
        },
      },
    );
    assert.equal(
      result.status,
      0,
      result.stderr ?? "worker profile did not start",
    );
    assert.equal(
      result.stdout.split("\n")[0],
      "profile= socket= client= token=",
    );
    assert.deepEqual(result.stdout.trim().split("\n").slice(1), [
      "--no-extensions",
      "--model",
      "provider/model",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
