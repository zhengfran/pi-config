import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefaultPackageManager,
  DefaultResourceLoader,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageSource = "git:github.com/zhengfran/pi-herdr-agents";
const settings = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
// Inspect Pi's managed checkout without installing or updating it during tests.
const installedPackages = new DefaultPackageManager({
  cwd: root,
  agentDir: getAgentDir(),
  settingsManager: SettingsManager.inMemory({ packages: [packageSource] }),
});
const packageRoot = installedPackages.getInstalledPath(packageSource, "user");
assert.ok(
  packageRoot,
  `Install the package first: pi install ${packageSource}`,
);
const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-subagent-config-"));
after(() => rmSync(temporaryRoot, { recursive: true, force: true }));

function fixture(name: string) {
  const agentDir = join(temporaryRoot, name, "agent");
  const cwd = join(temporaryRoot, name, "project");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(agentDir, "extensions", "subagents"), { recursive: true });
  symlinkSync(join(root, "agents"), join(agentDir, "agents"), "dir");
  // Deliberately fatal if auto-discovery accidentally loads the deprecated entry.
  writeFileSync(
    join(agentDir, "extensions", "subagents", "index.ts"),
    'throw new Error("deprecated subagents must not load"); export default () => {};',
  );
  return { agentDir, cwd };
}

test("portable settings select only the Herdr Git package and exclude the legacy entry", () => {
  assert.deepEqual(
    settings.packages.filter((source: string) =>
      /pi-(?:interactive-subagents|herdr-agents)/.test(source),
    ),
    [packageSource],
  );
  assert.equal(settings.defaultProvider, "openai-codex");
  assert.equal(settings.defaultModel, "gpt-5.6-sol");
  assert.ok(settings.extensions.includes("-extensions/subagents/index.ts"));
  assert.ok(!JSON.stringify(settings).includes("/tmp/"));
  const manifest = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  );
  assert.deepEqual(manifest.pi.extensions, [
    "./pi-extension/subagents/index.ts",
  ]);
  assert.ok(manifest.peerDependencies["@earendil-works/pi-coding-agent"]);
});

test("Pi discovery disables the deprecated extension and loads one interactive toolset", async () => {
  const { agentDir, cwd } = fixture("discovery");
  const settingsManager = SettingsManager.inMemory(
    {
      packages: [packageRoot],
      extensions: settings.extensions,
    },
    { projectTrusted: false },
  );
  const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  const resources = await manager.resolve();
  const deprecated = resources.extensions.find(
    (resource) =>
      resource.path === join(agentDir, "extensions", "subagents", "index.ts"),
  );
  assert.ok(
    deprecated,
    "legacy entry must be discovered before the filter excludes it",
  );
  assert.equal(deprecated.enabled, false);

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const { extensions, errors } = loader.getExtensions();
  assert.deepEqual(errors, []);
  assert.equal(extensions.length, 1);
  assert.deepEqual([...extensions[0].tools.keys()].sort(), [
    "subagent",
    "subagent_interrupt",
    "subagent_resume",
    "subagent_send",
    "subagent_stop",
    "subagents_list",
    "subagents_write_task_models",
    "worktree_list",
    "worktree_remove",
  ]);
  assert.ok(extensions[0].commands.has("subagent"));
  assert.ok(!extensions[0].tools.has("subagent_spawn"));
  assert.ok(!extensions[0].tools.has("subagent_message"));

  // Exercise the actual package's profile discovery, without spawning a child.
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousCwd = process.cwd();
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.chdir(cwd);
  try {
    const list = extensions[0].tools.get("subagents_list")!.definition;
    const result = await Reflect.apply(list.execute, undefined, []);
    const roles = result.details.agents.map(
      (agent: {
        name: string;
        model: string;
        thinking: string;
        source: string;
      }) => ({
        name: agent.name,
        model: agent.model,
        thinking: agent.thinking,
        source: agent.source,
      }),
    );
    assert.deepEqual(
      roles.sort((a: { name: string }, b: { name: string }) =>
        a.name.localeCompare(b.name),
      ),
      [
        {
          name: "adversarial-reviewer",
          model: undefined,
          thinking: "high",
          source: "package",
        },
        {
          name: "planner",
          model: undefined,
          thinking: undefined,
          source: "package",
        },
        {
          name: "poteto",
          model: undefined,
          thinking: undefined,
          source: "package",
        },
        {
          name: "researcher",
          model: "openai-codex/gpt-6-luna",
          thinking: "medium",
          source: "global",
        },
        {
          name: "reviewer",
          model: undefined,
          thinking: undefined,
          source: "package",
        },
        {
          name: "scout",
          model: "openai-codex/gpt-6-luna",
          thinking: "low",
          source: "global",
        },
        {
          name: "visual-tester",
          model: undefined,
          thinking: undefined,
          source: "package",
        },
        {
          name: "worker",
          model: "openai-codex/gpt-6-sol",
          thinking: "high",
          source: "global",
        },
      ],
    );
  } finally {
    process.chdir(previousCwd);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("explicit child control extension loads with global discovery disabled", async () => {
  const { agentDir, cwd } = fixture("child");
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }),
    noExtensions: true,
    additionalExtensionPaths: [
      join(packageRoot, "pi-extension/subagents/subagent-done.ts"),
    ],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const { extensions, errors } = loader.getExtensions();
  assert.deepEqual(errors, []);
  assert.deepEqual(
    extensions.flatMap((extension) => [...extension.tools.keys()]).sort(),
    ["caller_ping", "subagent_done"],
  );
});
