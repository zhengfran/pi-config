/**
 * Offline unit tests for the profiled-role wiring added to the pi, Claude,
 * and Codex backends (Wayfinder 07).
 *
 * These exercise only the pure option/param builders each backend exports —
 * no pi session, Claude query(), or Codex app-server process is started, so
 * this suite never launches a live external agent. Per the profile-capability
 * contract (profile-capability-contract-2026-09-26.md):
 *   - the role is *appended* to each backend's base system/developer
 *     instructions, never replacing them;
 *   - an unprofiled (legacy) task must build byte-for-byte the same options
 *     as before profiles existed;
 *   - tool hints are additional narrowing only, never asserted here as the
 *     `filesystem_read_only` enforcement boundary itself.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ProfileLoadout } from "./src/domain.ts";
import { profileAppendSystemPromptOverride } from "./src/backends/pi.ts";
import { profileClaudeQueryOptions } from "./src/backends/claude.ts";
import { profileThreadStartParams } from "./src/backends/codex.ts";

function loadout(overrides: Partial<ProfileLoadout> = {}): ProfileLoadout {
  return {
    name: "reviewer",
    profileHash: "sha256:test",
    roleText: "Review the requested change. Never claim to have edited it.",
    roleDelivery: "any",
    requiredCapabilities: [],
    allowedRecipients: ["parent"],
    groupId: "group-1",
    trustedSource: "global",
    ...overrides,
  };
}

// --- pi: DefaultResourceLoader appendSystemPromptOverride -------------------

test("pi: unprofiled spawn builds no append-system-prompt override", () => {
  assert.equal(profileAppendSystemPromptOverride(undefined), undefined);
});

test("pi: profiled spawn appends the role after the existing base blocks", () => {
  const override = profileAppendSystemPromptOverride(loadout().roleText);
  assert.ok(override);
  const base = ["APPEND_SYSTEM.md contents", "another discovered block"];
  const result = override!(base);
  // Base blocks are preserved, in order, untouched -- the role is appended,
  // never a replacement (contract: "appends role identity rather than
  // replacing the harness's system safety instructions").
  assert.deepEqual(result, [...base, loadout().roleText]);
  assert.deepEqual(base, [
    "APPEND_SYSTEM.md contents",
    "another discovered block",
  ]);
});

test("pi: profiled override is pure and stable across calls with an empty base", () => {
  const override = profileAppendSystemPromptOverride("Be terse.");
  assert.ok(override);
  assert.deepEqual(override!([]), ["Be terse."]);
  assert.deepEqual(override!([]), ["Be terse."]);
});

// --- Claude: query() systemPrompt preset append + tool hints ----------------

test("Claude: unprofiled spawn adds no query() options", () => {
  assert.deepEqual(profileClaudeQueryOptions(undefined), {});
});

test("Claude: profiled spawn appends the role to the claude_code preset and snapshots it", () => {
  const options = profileClaudeQueryOptions(loadout());
  assert.deepEqual(options.systemPrompt, {
    type: "preset",
    preset: "claude_code",
    append: loadout().roleText,
    snapshot: true,
  });
  // No tool hints supplied -> no tools/allowedTools keys at all (never an
  // empty-array narrowing that would look like "no tools").
  assert.equal("tools" in options, false);
  assert.equal("allowedTools" in options, false);
});

test("Claude: profile tool hints are forwarded as independent copies", () => {
  const tools = ["Read", "Grep"] as const;
  const allowedTools = ["Read", "Glob", "Grep"] as const;
  const options = profileClaudeQueryOptions(loadout({ tools, allowedTools }));
  // SDK allowedTools only auto-approves; its tools option narrows the set.
  assert.deepEqual(options.tools, allowedTools);
  assert.deepEqual(options.allowedTools, allowedTools);
  // Defensive copies: mutating the returned arrays must not reach back into
  // the immutable ProfileLoadout snapshot.
  assert.notEqual(options.tools, allowedTools);
  assert.notEqual(options.allowedTools, allowedTools);
});

test("Claude: snapshot:true is always set for a profiled spawn (resolved-loadout immutability)", () => {
  const options = profileClaudeQueryOptions(
    loadout({ roleDelivery: "privileged_required" }),
  );
  assert.equal((options.systemPrompt as { snapshot?: boolean }).snapshot, true);
});

// --- Codex: thread/start developerInstructions ------------------------------

test("Codex: unprofiled spawn adds no thread/start params", () => {
  assert.deepEqual(profileThreadStartParams(undefined), {});
});

test("Codex: profiled spawn appends the role via developerInstructions only", () => {
  const params = profileThreadStartParams(loadout());
  assert.deepEqual(params, { developerInstructions: loadout().roleText });
  // No silent permission escalation: the params never carry
  // approvalPolicy/sandbox overrides alongside the role.
  assert.equal("approvalPolicy" in params, false);
  assert.equal("sandbox" in params, false);
});

test("Codex: developerInstructions never encodes tool hints (no proven per-child allowlist)", () => {
  const params = profileThreadStartParams(
    loadout({ tools: ["read"], allowedTools: ["Read"] }),
  );
  assert.deepEqual(params, { developerInstructions: loadout().roleText });
});
