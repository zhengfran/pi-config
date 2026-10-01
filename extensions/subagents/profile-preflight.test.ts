import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { verifiedProfileHarnesses } from "./src/profile-preflight.ts";
import { parseProfileMarkdown, type AgentProfile } from "./src/profiles.ts";
import type { RoutingState } from "./src/routing.ts";

const markdown = `---
version: 1
name: analyst
task_kind: code_review
harness:
  pi:
    model: openai-codex/gpt-test
  claude: {}
  codex: {}
---
Review safely.
`;
const parsed = parseProfileMarkdown(markdown);
if (!parsed.ok) throw new Error(parsed.error);
const profile: AgentProfile = {
  ...parsed.profile,
  scope: "user",
  sourcePath: "/test/analyst.md",
};
const state: RoutingState = {
  environment: "personal",
  configPath: "/test/config",
  freshnessMinutes: 5,
  cachePath: "/test/cache",
  cacheState: "missing",
  quotas: {},
};
const registry = (models: Array<{ provider: string; id: string }>) =>
  ({
    getAvailable: () => models,
    find: () => undefined,
    getAll: () => models,
  }) as unknown as ExtensionContext["modelRegistry"];

function eligible(
  overrides: Partial<Parameters<typeof verifiedProfileHarnesses>[0]> = {},
) {
  return verifiedProfileHarnesses({
    profile,
    taskKind: "code_review",
    state,
    modelRegistry: registry([{ provider: "openai-codex", id: "gpt-test" }]),
    claudeAuthenticated: true,
    ...overrides,
  });
}

test("profile preflight excludes unverified Codex nested agents and permits only proven Pi model", () => {
  assert.deepEqual([...eligible()].sort(), ["claude", "pi"]);
});

test("a later authenticated Pi candidate is not excluded by an invalid first entry", () => {
  const withCandidates = {
    ...state,
    models: {
      code_review: [
        { harness: "pi" as const, model: "openai-codex/missing" },
        { harness: "pi" as const, model: "openai-codex/gpt-test" },
      ],
    },
  };
  const noHint = { ...profile, harness: { pi: {} } };
  assert.deepEqual(
    [...eligible({ profile: noHint, state: withCandidates })],
    ["pi"],
  );
});

test("missing Claude login excludes it before ranking", () => {
  assert.deepEqual([...eligible({ claudeAuthenticated: false })], ["pi"]);
});

test("Pi does not assume an unchecked SDK default model when none is inherited", () => {
  const noHint = { ...profile, harness: { pi: {} } };
  assert.equal(eligible({ profile: noHint }).size, 0);
});

test("missing Pi model credentials fail closed before ranking", () => {
  assert.deepEqual([...eligible({ modelRegistry: registry([]) })], ["claude"]);
});

test("explicit unverified Claude model hint fails closed instead of falling back", () => {
  assert.deepEqual(
    [...eligible({ override: "claude", explicitModel: "not-validated" })],
    ["pi"],
  );
});

test("unverified read-only boundary rejects every harness", () => {
  assert.equal(
    eligible({ profile: { ...profile, requires: ["filesystem_read_only"] } })
      .size,
    0,
  );
});
