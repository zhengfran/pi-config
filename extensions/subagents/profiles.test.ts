import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AgentProfileNotFoundError,
  discoverAgentProfiles,
  getAgentProfile,
  mergeRequiredAccess,
  parseProfileMarkdown,
  profileAllowsMessageTarget,
  requireAgentProfile,
  resolveProfileTaskKind,
} from "./src/profiles.ts";

const REVIEWER_PROFILE = `---
version: 1
name: reviewer
description: Review a change without modifying files
task_kind: code_review
required_access: []
requires: [filesystem_read_only]
message_to: [parent, peer:scout]
role_delivery: any
harness:
  pi:
    tools: [read, grep, find, ls]
  claude:
    allowed_tools: [Read, Glob, Grep]
  codex: {}
---
Review the requested change. Report evidence and risks; never claim to have edited it.
`;

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-profiles-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeProfile(dir: string, fileName: string, content: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, fileName), content, "utf8");
}

// --- parseProfileMarkdown: pure schema validation ----------------------------

test("parses a well-formed v1 profile with harness hints", () => {
  const result = parseProfileMarkdown(REVIEWER_PROFILE);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.profile.name, "reviewer");
  assert.equal(result.profile.taskKind, "code_review");
  assert.deepEqual(result.profile.requiredAccess, []);
  assert.deepEqual(result.profile.requires, ["filesystem_read_only"]);
  assert.deepEqual(result.profile.messageTo, ["parent", "peer:scout"]);
  assert.equal(result.profile.roleDelivery, "any");
  assert.deepEqual(result.profile.harness.pi?.tools, [
    "read",
    "grep",
    "find",
    "ls",
  ]);
  assert.deepEqual(result.profile.harness.claude?.allowedTools, [
    "Read",
    "Glob",
    "Grep",
  ]);
  assert.deepEqual(result.profile.harness.codex, {});
  assert.match(result.profile.roleBody, /Review the requested change/);
  assert.equal(typeof result.profile.contentHash, "string");
  assert.equal(result.profile.contentHash.length, 64);
});

test("parses inline YAML comments on v1 role settings", () => {
  const result = parseProfileMarkdown(
    REVIEWER_PROFILE.replace(
      "role_delivery: any",
      "role_delivery: any # default role delivery",
    ),
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.profile.roleDelivery, "any");
});

test("rejects prototype-polluting YAML keys instead of hiding security fields", () => {
  const content = REVIEWER_PROFILE.replace(
    "role_delivery: any",
    "role_delivery: any\n__proto__:\n  read_only: true",
  );
  const result = parseProfileMarkdown(content);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /forbidden key/);
});

test("rejects an unknown top-level field (fail closed on allowed keys)", () => {
  const content = REVIEWER_PROFILE.replace(
    "role_delivery: any",
    "role_delivery: any\nread_only: true",
  );
  const result = parseProfileMarkdown(content);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /unknown field/);
  assert.match(result.error, /read_only/);
});

test("rejects an unknown harness key", () => {
  const content = REVIEWER_PROFILE.replace(
    "  claude:\n    allowed_tools: [Read, Glob, Grep]",
    "  claude:\n    allowed_tools: [Read, Glob, Grep]\n    sandbox: strict",
  );
  const result = parseProfileMarkdown(content);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /harness\.claude/);
});

test("rejects an unknown harness backend name", () => {
  const content = REVIEWER_PROFILE.replace(
    "  codex: {}",
    "  codex: {}\n  gpt5: {}",
  );
  const result = parseProfileMarkdown(content);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /unknown backend/);
});

test("rejects an unknown task_kind enum value", () => {
  const content = REVIEWER_PROFILE.replace(
    "task_kind: code_review",
    "task_kind: yolo",
  );
  const result = parseProfileMarkdown(content);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /task_kind/);
});

test("rejects an unknown requires token", () => {
  const content = REVIEWER_PROFILE.replace(
    "requires: [filesystem_read_only]",
    "requires: [network_isolated]",
  );
  const result = parseProfileMarkdown(content);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /requires/);
});

test("rejects a message_to target that is not parent or peer:<name>", () => {
  const content = REVIEWER_PROFILE.replace(
    "message_to: [parent, peer:scout]",
    "message_to: [everyone]",
  );
  const result = parseProfileMarkdown(content);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /message_to/);
});

test("rejects a missing version and reports the best-effort name", () => {
  const content = REVIEWER_PROFILE.replace("version: 1\n", "");
  const result = parseProfileMarkdown(content);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /version/);
  assert.equal(result.name, "reviewer");
});

test("rejects a missing frontmatter fence", () => {
  const result = parseProfileMarkdown(
    "Just a plain markdown file, no frontmatter.\n",
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /frontmatter fence/);
});

test("rejects an empty role body", () => {
  const content = "---\nversion: 1\nname: reviewer\n---\n   \n";
  const result = parseProfileMarkdown(content);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /role body/);
});

test("rejects an invalid role_delivery enum value", () => {
  const content = REVIEWER_PROFILE.replace(
    "role_delivery: any",
    "role_delivery: sometimes",
  );
  const result = parseProfileMarkdown(content);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /role_delivery/);
  assert.equal(result.name, "reviewer");
});

// --- discoverAgentProfiles: filesystem discovery, trust, overrides ----------

test("discovers a user-scope profile with no project directory present", async () => {
  await withTempDir(async (root) => {
    const agentDir = join(root, "agent-home");
    const cwd = join(root, "project");
    await writeProfile(
      join(agentDir, "agents"),
      "reviewer.md",
      REVIEWER_PROFILE,
    );
    await mkdir(cwd, { recursive: true });

    const resolution = await discoverAgentProfiles({
      agentDir,
      cwd,
      projectTrusted: false,
    });

    assert.equal(resolution.profiles.size, 1);
    const profile = getAgentProfile(resolution, "reviewer");
    assert.ok(profile);
    assert.equal(profile?.scope, "user");
    assert.equal(
      resolution.diagnostics.some((d) => d.level === "error"),
      false,
    );
  });
});

test("ignores project profiles when trust is false, even though the dir exists", async () => {
  await withTempDir(async (root) => {
    const agentDir = join(root, "agent-home");
    const cwd = join(root, "project");
    await writeProfile(
      join(agentDir, "agents"),
      "reviewer.md",
      REVIEWER_PROFILE,
    );
    const overridden = REVIEWER_PROFILE.replace(
      "Review the requested change.",
      "PROJECT OVERRIDE: review the requested change.",
    );
    await writeProfile(join(cwd, ".pi", "agents"), "reviewer.md", overridden);

    const resolution = await discoverAgentProfiles({
      agentDir,
      cwd,
      projectTrusted: false,
    });

    const profile = getAgentProfile(resolution, "reviewer");
    assert.ok(profile);
    assert.equal(profile?.scope, "user");
    assert.match(profile?.roleBody ?? "", /^Review the requested change\./);
    assert.ok(
      resolution.diagnostics.some(
        (d) => d.level === "info" && /not trusted/.test(d.message),
      ),
    );
  });
});

test("a trusted valid project profile overrides the global one in entirety", async () => {
  await withTempDir(async (root) => {
    const agentDir = join(root, "agent-home");
    const cwd = join(root, "project");
    await writeProfile(
      join(agentDir, "agents"),
      "reviewer.md",
      REVIEWER_PROFILE,
    );
    const overridden = REVIEWER_PROFILE.replace(
      "message_to: [parent, peer:scout]",
      "message_to: [parent]",
    ).replace(
      "Review the requested change. Report evidence and risks; never claim to have edited it.",
      "PROJECT OVERRIDE role text.",
    );
    await writeProfile(join(cwd, ".pi", "agents"), "reviewer.md", overridden);

    const resolution = await discoverAgentProfiles({
      agentDir,
      cwd,
      projectTrusted: true,
    });

    const profile = getAgentProfile(resolution, "reviewer");
    assert.ok(profile);
    assert.equal(profile?.scope, "project");
    assert.deepEqual(profile?.messageTo, ["parent"]);
    assert.match(profile?.roleBody ?? "", /PROJECT OVERRIDE role text\./);
  });
});

test("a malformed trusted project override fails closed instead of falling back to global", async () => {
  await withTempDir(async (root) => {
    const agentDir = join(root, "agent-home");
    const cwd = join(root, "project");
    await writeProfile(
      join(agentDir, "agents"),
      "reviewer.md",
      REVIEWER_PROFILE,
    );
    const malformed = REVIEWER_PROFILE.replace(
      "role_delivery: any",
      "role_delivery: sometimes",
    );
    await writeProfile(join(cwd, ".pi", "agents"), "reviewer.md", malformed);

    const resolution = await discoverAgentProfiles({
      agentDir,
      cwd,
      projectTrusted: true,
    });

    assert.equal(getAgentProfile(resolution, "reviewer"), undefined);
    assert.ok(
      resolution.diagnostics.some(
        (d) =>
          d.level === "error" &&
          /malformed trusted project override/.test(d.message) &&
          /global profile of the same name is not used/.test(d.message),
      ),
    );
    assert.throws(
      () => requireAgentProfile(resolution, "reviewer"),
      AgentProfileNotFoundError,
    );
  });
});

test("malformed trusted override with inline comment cannot fall back to global", async () => {
  await withTempDir(async (root) => {
    const agentDir = join(root, "agent-home");
    const cwd = join(root, "project");
    await writeProfile(
      join(agentDir, "agents"),
      "reviewer.md",
      REVIEWER_PROFILE,
    );
    await writeProfile(
      join(cwd, ".pi", "agents"),
      "reviewer.md",
      REVIEWER_PROFILE.replace(
        "name: reviewer",
        "name: reviewer # tightened override\nread_only: true",
      ),
    );
    const resolution = await discoverAgentProfiles({
      agentDir,
      cwd,
      projectTrusted: true,
    });
    assert.equal(getAgentProfile(resolution, "reviewer"), undefined);
  });
});

test("malformed trusted override with quoted commented name and a different filename blocks global", async () => {
  await withTempDir(async (root) => {
    const agentDir = join(root, "agent-home");
    const cwd = join(root, "project");
    await writeProfile(
      join(agentDir, "agents"),
      "reviewer.md",
      REVIEWER_PROFILE,
    );
    await writeProfile(
      join(cwd, ".pi", "agents"),
      "strict-reviewer.md",
      REVIEWER_PROFILE.replace(
        "name: reviewer",
        'name: "reviewer" # strict',
      ).replace("  pi:", "\tpi:"),
    );
    const resolution = await discoverAgentProfiles({
      agentDir,
      cwd,
      projectTrusted: true,
    });
    assert.equal(getAgentProfile(resolution, "reviewer"), undefined);
    assert.ok(resolution.diagnostics.some((entry) => entry.level === "error"));
  });
});

test("duplicate names within one scope are both rejected", async () => {
  await withTempDir(async (root) => {
    const agentDir = join(root, "agent-home");
    const cwd = join(root, "project");
    await mkdir(cwd, { recursive: true });
    const other = REVIEWER_PROFILE.replace(
      "Review the requested change. Report evidence and risks; never claim to have edited it.",
      "A second file claiming the same name.",
    );
    await writeProfile(
      join(agentDir, "agents"),
      "reviewer.md",
      REVIEWER_PROFILE,
    );
    await writeProfile(join(agentDir, "agents"), "reviewer-2.md", other);

    const resolution = await discoverAgentProfiles({
      agentDir,
      cwd,
      projectTrusted: false,
    });

    assert.equal(getAgentProfile(resolution, "reviewer"), undefined);
    assert.ok(
      resolution.diagnostics.some((d) =>
        /duplicate agent profile name/.test(d.message),
      ),
    );
  });
});

test("rejects a symlink that escapes the project agent profile directory", async () => {
  await withTempDir(async (root) => {
    const agentDir = join(root, "agent-home");
    const cwd = join(root, "project");
    await mkdir(join(agentDir, "agents"), { recursive: true });

    const outsideDir = join(root, "outside");
    await mkdir(outsideDir, { recursive: true });
    const outsideFile = join(outsideDir, "evil.md");
    await writeFile(outsideFile, REVIEWER_PROFILE, "utf8");

    const projectAgentsDir = join(cwd, ".pi", "agents");
    await mkdir(projectAgentsDir, { recursive: true });
    await symlink(outsideFile, join(projectAgentsDir, "reviewer.md"));

    const resolution = await discoverAgentProfiles({
      agentDir,
      cwd,
      projectTrusted: true,
    });

    assert.equal(getAgentProfile(resolution, "reviewer"), undefined);
    assert.ok(
      resolution.diagnostics.some((d) => /symlink escapes/.test(d.message)),
    );
  });
});

test("user agent profile directory may be symlinked into dotconfig", async () => {
  await withTempDir(async (root) => {
    const agentDir = join(root, "agent-home");
    const cwd = join(root, "project");
    const deployed = join(root, "dotconfig-profiles");
    await writeProfile(deployed, "reviewer.md", REVIEWER_PROFILE);
    await mkdir(agentDir, { recursive: true });
    await mkdir(cwd);
    await symlink(deployed, join(agentDir, "agents"));
    const resolution = await discoverAgentProfiles({
      agentDir,
      cwd,
      projectTrusted: false,
    });
    assert.equal(getAgentProfile(resolution, "reviewer")?.scope, "user");
  });
});

test("trusted project profile directory cannot symlink outside its project", async () => {
  await withTempDir(async (root) => {
    const agentDir = join(root, "agent-home");
    const cwd = join(root, "project");
    const outside = join(root, "outside");
    await writeProfile(
      join(agentDir, "agents"),
      "reviewer.md",
      REVIEWER_PROFILE,
    );
    await writeProfile(outside, "reviewer.md", REVIEWER_PROFILE);
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await symlink(outside, join(cwd, ".pi", "agents"));
    await assert.rejects(
      discoverAgentProfiles({ agentDir, cwd, projectTrusted: true }),
      /escapes its configured scope/,
    );
  });
});

test("allows a symlink that stays within the agent profile directory", async () => {
  await withTempDir(async (root) => {
    const agentDir = join(root, "agent-home");
    const cwd = join(root, "project");
    await mkdir(cwd, { recursive: true });
    const agentsDir = join(agentDir, "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, "_reviewer-source.txt"),
      REVIEWER_PROFILE,
      "utf8",
    );
    await symlink(
      join(agentsDir, "_reviewer-source.txt"),
      join(agentsDir, "reviewer.md"),
    );

    const resolution = await discoverAgentProfiles({
      agentDir,
      cwd,
      projectTrusted: false,
    });

    const profile = getAgentProfile(resolution, "reviewer");
    assert.ok(profile);
    assert.equal(
      resolution.diagnostics.some((d) => d.level === "error"),
      false,
    );
  });
});

test("no profile with the requested name is an error, not a discarded-restriction spawn", async () => {
  await withTempDir(async (root) => {
    const agentDir = join(root, "agent-home");
    const cwd = join(root, "project");
    await mkdir(join(agentDir, "agents"), { recursive: true });
    await mkdir(cwd, { recursive: true });

    const resolution = await discoverAgentProfiles({
      agentDir,
      cwd,
      projectTrusted: false,
    });

    assert.equal(resolution.profiles.size, 0);
    assert.throws(
      () => requireAgentProfile(resolution, "ghost"),
      AgentProfileNotFoundError,
    );
  });
});

// --- resolution helpers -------------------------------------------------------

test("resolveProfileTaskKind takes the profile's task_kind when the call omits it", () => {
  const parsed = parseProfileMarkdown(REVIEWER_PROFILE);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const profile = {
    ...parsed.profile,
    scope: "user" as const,
    sourcePath: "reviewer.md",
  };
  assert.equal(resolveProfileTaskKind(profile), "code_review");
});

test("resolveProfileTaskKind rejects a call that supplies a different task_kind", () => {
  const parsed = parseProfileMarkdown(REVIEWER_PROFILE);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const profile = {
    ...parsed.profile,
    scope: "user" as const,
    sourcePath: "reviewer.md",
  };
  assert.throws(() => resolveProfileTaskKind(profile, "quick"), /conflicts/);
});

test("mergeRequiredAccess unions but never drops the profile's own required_access", () => {
  const parsed = parseProfileMarkdown(
    REVIEWER_PROFILE.replace("required_access: []", "required_access: [jira]"),
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const profile = {
    ...parsed.profile,
    scope: "user" as const,
    sourcePath: "reviewer.md",
  };
  assert.deepEqual([...mergeRequiredAccess(profile, ["confluence"])].sort(), [
    "confluence",
    "jira",
  ]);
  assert.deepEqual([...mergeRequiredAccess(profile)].sort(), ["jira"]);
});

test("profileAllowsMessageTarget checks the profile's own allowlist", () => {
  const parsed = parseProfileMarkdown(REVIEWER_PROFILE);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const profile = {
    ...parsed.profile,
    scope: "user" as const,
    sourcePath: "reviewer.md",
  };
  assert.equal(profileAllowsMessageTarget(profile, "parent"), true);
  assert.equal(profileAllowsMessageTarget(profile, "peer:scout"), true);
  assert.equal(profileAllowsMessageTarget(profile, "peer:other"), false);
});
