/**
 * Live tests for the kiro backend: these actually invoke kiro-cli and need a
 * completed `kiro-cli login`. Run with `npm run test:live`.
 *
 * The two things worth proving live are the ones that cannot be faked:
 * kiro-cli's colourised response marker is stripped out of the delivered
 * result, and multi-turn context survives even though every turn is a
 * separate process.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { kiroBackend } from "./src/backends/kiro.ts";
import type { ParentContext, SpawnTask } from "./src/domain.ts";
import { SubagentManager } from "./src/manager.ts";
import { createSubagentRuntime, runTool } from "./src/runtime.ts";

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: false,
};

function task(prompt: string): SpawnTask {
  return { prompt, title: "live kiro test", cwd: process.cwd(), parent };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function kiroAvailable() {
  return Effect.runPromise(kiroBackend.available);
}

/**
 * A restart flips status via the async event pump, so an immediate waitFor can
 * return before the new run is even visible. Poll the turn count instead.
 */
async function waitForTurns(
  view: { get: (id: string) => { turns: number; status: string } | undefined },
  id: string,
  turns: number,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = view.get(id);
    if ((snap?.turns ?? 0) >= turns && snap?.status !== "running") return;
    await sleep(500);
  }
  throw new Error(`kiro subagent did not reach ${turns} turn(s) in time`);
}

test("kiro backend completes a live run", { timeout: 180_000 }, async (t) => {
  if (!(await kiroAvailable())) {
    t.skip("kiro-cli is unavailable or not logged in");
    return;
  }
  const runtime = createSubagentRuntime();
  try {
    const manager = await runtime.runPromise(SubagentManager);
    const spawned = await runTool(
      runtime,
      manager.spawn("kiro", task("Reply with exactly: hello kiro")),
    );
    await runTool(runtime, manager.waitFor([spawned.id]));

    const done = manager.view.get(spawned.id);
    assert.equal(done?.status, "done");
    assert.equal(done?.meta.backend, "kiro");
    assert.match(done?.finalText ?? "", /hello kiro/i);
    // kiro-cli prefixes its answer with a colourised "> "; leaving it in would
    // hand the parent model a bogus markdown blockquote.
    assert.doesNotMatch(done?.finalText ?? "", /^>\s/);
  } finally {
    await runtime.dispose();
  }
});

test(
  "kiro carries context across turns despite one process per turn",
  { timeout: 240_000 },
  async (t) => {
    if (!(await kiroAvailable())) {
      t.skip("kiro-cli is unavailable or not logged in");
      return;
    }
    const runtime = createSubagentRuntime();
    try {
      const manager = await runtime.runPromise(SubagentManager);
      const spawned = await runTool(
        runtime,
        manager.spawn(
          "kiro",
          task(
            "Remember this: my favourite colour is teal. Reply with just: noted",
          ),
        ),
      );
      await runTool(runtime, manager.waitFor([spawned.id]));

      await runTool(
        runtime,
        manager.send(spawned.id, "What is my favourite colour? One word."),
      );
      await waitForTurns(manager.view, spawned.id, 2, 120_000);

      const after = manager.view.get(spawned.id);
      assert.equal(after?.status, "done");
      assert.equal(after?.turns, 2);
      // The second turn ran in a brand-new kiro-cli process, so this can only
      // pass if the carried transcript was replayed into the prompt.
      assert.match(after?.finalText ?? "", /teal/i);
    } finally {
      await runtime.dispose();
    }
  },
);
