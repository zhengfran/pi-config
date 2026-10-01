import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeSubagentMessage,
  resolveMessageTarget,
} from "./src/message-target.ts";
import type { SubagentSnapshot } from "./src/domain.ts";

const snap = (
  id: string,
  title: string,
  status: "running" | "done" | "error" = "running",
  origin: "model" | "btw" = "model",
) => ({ id, title, status, origin }) as SubagentSnapshot;

test("target selects an exact id or a unique name within the current model children", () => {
  const entries = [snap("sa-1", "worker"), snap("sa-2", "scout")];
  assert.equal(resolveMessageTarget(entries, " sa-1 ").id, "sa-1");
  assert.equal(resolveMessageTarget(entries, "scout").id, "sa-2");
  assert.throws(
    () => resolveMessageTarget(entries, "missing"),
    /Unknown subagent/,
  );
});

test("target never guesses for duplicate names or id-name collision", () => {
  assert.throws(
    () =>
      resolveMessageTarget(
        [snap("sa-1", "worker"), snap("sa-2", "worker")],
        "worker",
      ),
    /Ambiguous/,
  );
  assert.throws(
    () =>
      resolveMessageTarget(
        [snap("sa-1", "worker"), snap("sa-2", "sa-1")],
        "sa-1",
      ),
    /Ambiguous/,
  );
});

test("target excludes /btw and fails closed on errored or cancelled children", () => {
  assert.throws(
    () => resolveMessageTarget([snap("btw-1", "side", "done", "btw")], "btw-1"),
    /Unknown/,
  );
  assert.throws(
    () => resolveMessageTarget([snap("sa-1", "failed", "error")], "sa-1"),
    /cannot restart implicitly/,
  );
  assert.equal(
    resolveMessageTarget([snap("sa-2", "settled", "done")], "settled").status,
    "done",
  );
});

test("message length counts UTF-8 bytes; never truncates a live instruction", () => {
  assert.equal(normalizeSubagentMessage("  reply  "), "reply");
  assert.throws(() => normalizeSubagentMessage("  "), /nonempty/);
  assert.equal(normalizeSubagentMessage("x".repeat(65_536)).length, 65_536);
  assert.throws(() => normalizeSubagentMessage("☀".repeat(21_846)), /64 KiB/);
});
