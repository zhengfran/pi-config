/**
 * Unit tests for the kiro backend. These deliberately do NOT drive a live
 * kiro-cli: the interesting behaviour is what happens when kiro-cli is
 * unusable, because an unauthenticated kiro-cli starts an interactive SSO
 * device-code login and never exits. A subagent that hangs there would hold a
 * concurrency slot forever, so failing fast is the contract worth pinning.
 *
 * Live coverage lives in kiro.live.test.ts (`npm run test:live`).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Effect, Exit } from "effect";
import { kiroBackend } from "./src/backends/kiro.ts";
import {
  BACKEND_NAMES,
  type ParentContext,
  type SpawnTask,
} from "./src/domain.ts";

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: false,
};

function task(prompt: string): SpawnTask {
  return { prompt, title: "kiro unit test", cwd: process.cwd(), parent };
}

/**
 * Mirrors the backend's own probe: kiro-cli keeps OIDC material in its private
 * SQLite store, not in the AWS CLI's ~/.aws/sso/cache.
 */
function kiroLoggedIn() {
  const dataHome =
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  const dbPath = path.join(dataHome, "kiro-cli", "data.sqlite3");
  if (!fs.existsSync(dbPath)) return false;
  try {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (
        p: string,
        o?: { readOnly?: boolean },
      ) => {
        prepare: (sql: string) => { get: (...p: string[]) => unknown };
        close: () => void;
      };
    };
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return (
        db
          .prepare("select value from auth_kv where key = ?")
          .get("kirocli:odic:token") !== undefined
      );
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

function deadline<A>(operation: Promise<A>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`kiro spawn exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

test("kiro is a registered backend name", () => {
  assert.ok(BACKEND_NAMES.includes("kiro"));
  assert.equal(kiroBackend.name, "kiro");
});

test("capabilities reflect what kiro-cli can actually do", () => {
  // One invocation is one turn: nothing can be steered mid-run, and there is
  // no reasoning-effort flag. Only --model is real.
  assert.deepEqual(kiroBackend.capabilities, {
    steering: false,
    modelSelection: true,
    reasoningEffort: false,
  });
});

test("available agrees with kiro-cli's credential store", async () => {
  const available = await Effect.runPromise(kiroBackend.available);
  assert.equal(typeof available, "boolean");
  // Without a stored login, kiro-cli would drop into an interactive device
  // flow, so the backend must report itself unavailable rather than be spawned.
  if (!kiroLoggedIn()) {
    assert.equal(available, false);
  }
});

test("spawn fails fast when unauthenticated instead of hanging", async (t) => {
  if (kiroLoggedIn()) {
    t.skip("kiro-cli is logged in; the fail-fast path is not exercised here");
    return;
  }
  const exit = await deadline(
    Effect.runPromiseExit(Effect.scoped(kiroBackend.spawn(task("say hi")))),
    5_000,
  );
  assert.ok(Exit.isFailure(exit), "spawn should fail without authentication");
  assert.match(JSON.stringify(exit.cause), /kiro-cli login/);
});
