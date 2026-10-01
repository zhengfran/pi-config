import type { SubagentSnapshot } from "./domain.ts";
import { isModelVisible } from "./by-the-way.ts";

export function normalizeSubagentMessage(text: string): string {
  const normalized = text.trim();
  if (!normalized || Buffer.byteLength(normalized, "utf8") > 64 * 1024) {
    throw new Error("Message must be nonempty and at most 64 KiB UTF-8.");
  }
  return normalized;
}

/** Resolve only this parent's tracked model children; never guess across aliases. */
export function resolveMessageTarget(
  snapshots: ReadonlyArray<SubagentSnapshot>,
  input: string,
): SubagentSnapshot {
  const target = input.trim();
  const visible = snapshots.filter(isModelVisible);
  const byId = visible.find((snap) => snap.id === target);
  const byName = visible.filter((snap) => snap.title === target);
  if (byId && byName.some((snap) => snap.id !== byId.id)) {
    throw new Error(
      `Ambiguous subagent target "${target}"; use a distinct id.`,
    );
  }
  if (!byId && byName.length > 1) {
    throw new Error(`Ambiguous subagent name "${target}"; use its exact id.`);
  }
  const snap = byId ?? byName[0];
  if (!snap) throw new Error(`Unknown subagent "${target}" in this session.`);
  if (snap.status === "error") {
    throw new Error(
      `Subagent "${snap.id}" failed or was cancelled; it cannot restart implicitly.`,
    );
  }
  return snap;
}
