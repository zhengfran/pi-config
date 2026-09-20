import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BackendName } from "./src/domain.ts";
import {
  SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SPAWN_PROMPT_GUIDELINES,
} from "./src/prompt.ts";
import {
  CORPORATE_ACCESS_REQUIREMENTS,
  loadRoutingState,
  routeSubagent,
  routingDiagnosticLines,
  TASK_KINDS,
  taskFitTiers,
  type ProviderQuota,
  type QuotaWindow,
  type RoutingEnvironment,
  type RoutingState,
  type UsageProvider,
} from "./src/routing.ts";

function quota(
  provider: UsageProvider,
  remainingPercent: number,
  fresh = true,
): ProviderQuota {
  return quotaWindows(provider, [["five_hour", remainingPercent]], fresh);
}

function quotaWindows(
  provider: UsageProvider,
  windows: ReadonlyArray<[QuotaWindow["kind"], number]>,
  fresh = true,
): ProviderQuota {
  const parsed = windows.map(([kind, remainingPercent]) => ({
    id: kind,
    label: kind,
    kind,
    remainingPercent,
  }));
  return {
    provider,
    observedAt: "2026-09-16T00:00:00.000Z",
    ageMs: fresh ? 0 : 3_600_000,
    fresh,
    windows: parsed,
    window: parsed[0],
  };
}

function state(
  environment: RoutingEnvironment,
  quotas: RoutingState["quotas"],
): RoutingState {
  return {
    environment,
    configPath: "/config/subagent-routing.json",
    freshnessMinutes: 5,
    cachePath: "/cache/snapshots.json",
    cacheState: "loaded",
    quotas,
  };
}

const all = new Set<BackendName>(["pi", "claude", "codex", "kiro"]);

test("task kind selects reasoning effort unless explicitly overridden", () => {
  const expected = {
    general: "medium",
    quick: "low",
    code_research: "medium",
    planning: "high",
    code_review: "high",
    large_refactor: "xhigh",
    test_authoring: "high",
    isolated_implementation: "medium",
    algorithmic: "xhigh",
  } as const;

  for (const taskKind of TASK_KINDS) {
    const decision = routeSubagent(
      { taskKind, available: all },
      state("corporate", {}),
    );
    assert.equal(decision.reasoningEffort, expected[taskKind]);
  }

  const overridden = routeSubagent(
    { taskKind: "algorithmic", reasoningEffort: "low", available: all },
    state("corporate", {}),
  );
  assert.equal(overridden.reasoningEffort, "low");
});

test("general tasks use shortest-window allowance within their fit tier", () => {
  const decision = routeSubagent(
    {
      taskKind: "general",
      available: all,
      parentProvider: "github-copilot",
    },
    state("corporate", {
      copilot: quota("copilot", 20),
      claude: quota("claude", 80),
      kiro: quota("kiro", 50),
    }),
  );

  assert.equal(decision.harness, "claude");
  assert.equal(decision.quotaCompared, true);
  assert.deepEqual(
    decision.candidates.map(({ harness }) => harness),
    ["claude", "kiro", "pi"],
  );
});

test("task fit wins over a lower-tier provider with more allowance", () => {
  const decision = routeSubagent(
    {
      taskKind: "large_refactor",
      available: all,
      parentProvider: "github-copilot",
    },
    state("corporate", {
      claude: quota("claude", 30),
      copilot: quota("copilot", 20),
      kiro: quota("kiro", 100),
    }),
  );

  assert.equal(decision.harness, "claude");
  assert.equal(decision.tier, 1);
  assert.deepEqual(taskFitTiers("large_refactor", "corporate"), [
    ["claude", "pi"],
    ["codex", "kiro"],
  ]);
});

test("incomplete quota data preserves deterministic fit order", () => {
  const decision = routeSubagent(
    {
      taskKind: "code_review",
      available: all,
      parentProvider: "github-copilot",
    },
    state("corporate", {
      copilot: quota("copilot", 5, false),
      claude: quota("claude", 90),
      kiro: quota("kiro", 100),
    }),
  );

  assert.equal(decision.harness, "pi");
  assert.equal(decision.quotaCompared, false);
});

test("corporate and personal isolated work use different fit tiers", () => {
  const quotas = {
    copilot: quota("copilot", 10),
    codex: quota("codex", 90),
    kiro: quota("kiro", 80),
  };
  const request = {
    taskKind: "isolated_implementation" as const,
    available: all,
    parentProvider: "github-copilot",
  };

  assert.equal(
    routeSubagent(request, state("corporate", quotas)).harness,
    "kiro",
  );
  assert.equal(
    routeSubagent(request, state("personal", quotas)).harness,
    "codex",
  );
});

test("corporate-system access is separate from task kind and requires Kiro", () => {
  assert.deepEqual(CORPORATE_ACCESS_REQUIREMENTS, [
    "jira",
    "confluence",
    "github_ix",
  ]);
  const taskKinds = new Set<string>(TASK_KINDS);
  assert.equal(taskKinds.has("jira"), false);
  assert.equal(taskKinds.has("confluence"), false);
  assert.equal(taskKinds.has("github_remote"), false);

  for (const requiredAccess of CORPORATE_ACCESS_REQUIREMENTS) {
    const selected = routeSubagent(
      {
        taskKind: "code_research",
        requiredAccess: [requiredAccess],
        available: all,
      },
      state("corporate", { kiro: quota("kiro", 1) }),
    );
    assert.equal(selected.harness, "kiro");
    assert.deepEqual(selected.requiredAccess, [requiredAccess]);
    assert.match(selected.reason, /only eligible available candidate/);
    assert.doesNotMatch(selected.reason, /quota data is incomplete/);
  }

  const lowerFitTier = routeSubagent(
    {
      taskKind: "large_refactor",
      requiredAccess: ["jira", "confluence"],
      available: all,
    },
    state("corporate", {}),
  );
  assert.equal(lowerFitTier.harness, "kiro");
  assert.equal(lowerFitTier.tier, 2);

  assert.throws(
    () =>
      routeSubagent(
        {
          taskKind: "code_review",
          requiredAccess: ["github_ix"],
          available: new Set(["pi", "claude"]),
        },
        state("corporate", {}),
      ),
    /required corporate access "github_ix"/,
  );
});

test("model guidance scopes github_ix to the internal company host", () => {
  const guidance = [
    SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.requiredAccess,
    ...SUBAGENT_SPAWN_PROMPT_GUIDELINES,
  ].join("\n");

  assert.match(guidance, /github-ix\.int\.automotive-wan\.com/);
  assert.match(guidance, /public GitHub/);
  assert.doesNotMatch(TASK_KINDS.join(","), /jira|confluence|github/);
});

test("public GitHub work does not imply internal GitHub access", () => {
  const selected = routeSubagent(
    {
      taskKind: "code_review",
      available: all,
      parentProvider: "github-copilot",
    },
    state("corporate", {
      copilot: quota("copilot", 20),
      claude: quota("claude", 80),
      kiro: quota("kiro", 50),
    }),
  );

  assert.equal(selected.harness, "claude");
  assert.deepEqual(selected.requiredAccess, []);
});

test("an explicit user override bypasses task fit but not availability or access", () => {
  const selected = routeSubagent(
    { taskKind: "code_research", override: "claude", available: all },
    state("corporate", {}),
  );
  assert.equal(selected.harness, "claude");
  assert.equal(selected.mode, "override");

  assert.throws(
    () =>
      routeSubagent(
        {
          taskKind: "general",
          requiredAccess: ["jira"],
          override: "claude",
          available: all,
        },
        state("corporate", {}),
      ),
    /cannot provide required corporate access: jira/,
  );

  assert.throws(
    () =>
      routeSubagent(
        {
          taskKind: "general",
          override: "codex",
          available: new Set(["pi"]),
        },
        state("personal", {}),
      ),
    /unavailable/,
  );
});

test("unavailable backends are filtered before quota ranking", () => {
  const decision = routeSubagent(
    {
      taskKind: "general",
      available: new Set(["claude", "kiro"]),
      parentProvider: "github-copilot",
    },
    state("corporate", {
      claude: quota("claude", 20),
      kiro: quota("kiro", 70),
    }),
  );
  assert.equal(decision.harness, "kiro");
});

test("Pi quota is comparable only for a GitHub Copilot parent", () => {
  const routingState = state("corporate", {
    copilot: quota("copilot", 100),
    claude: quota("claude", 10),
    kiro: quota("kiro", 5),
  });
  const copilot = routeSubagent(
    {
      taskKind: "general",
      available: all,
      parentProvider: "github-copilot",
    },
    routingState,
  );
  const anthropic = routeSubagent(
    {
      taskKind: "general",
      available: all,
      parentProvider: "anthropic",
    },
    routingState,
  );

  assert.equal(copilot.quotaCompared, true);
  assert.equal(anthropic.quotaCompared, false);
  assert.equal(anthropic.harness, "pi");
});

test("cache loader selects the shortest window and handles unlimited quota", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-routing-"));
  const agentDir = join(root, "agent");
  const cachePath = join(root, "cache", "snapshots.json");
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(root, "cache"), { recursive: true });
  await writeFile(
    join(agentDir, "subagent-routing.json"),
    '{"version":1,"environment":"corporate"}\n',
    { mode: 0o600 },
  );
  await writeFile(
    join(agentDir, "subscription-usage.json"),
    '{"refreshIntervalMinutes":10}\n',
    { mode: 0o600 },
  );
  await writeFile(
    cachePath,
    `${JSON.stringify({
      version: 1,
      snapshots: {
        claude: {
          provider: "claude",
          observedAt: "2026-09-16T12:00:00.000Z",
          windows: [
            {
              id: "weekly",
              label: "weekly",
              kind: "weekly",
              usedPercent: 10,
            },
            {
              id: "five_hour",
              label: "5-hour",
              kind: "five_hour",
              usedPercent: 75,
            },
          ],
        },
        copilot: {
          provider: "copilot",
          observedAt: "2026-09-16T12:00:00.000Z",
          windows: [
            {
              id: "chat",
              label: "chat",
              kind: "monthly",
              unlimited: true,
            },
          ],
        },
      },
    })}\n`,
    { mode: 0o600 },
  );
  await chmod(cachePath, 0o600);

  try {
    const loaded = await loadRoutingState({
      agentDir,
      cachePath,
      now: Date.parse("2026-09-16T12:05:00.000Z"),
    });
    assert.equal(loaded.environment, "corporate");
    assert.equal(loaded.freshnessMinutes, 10);
    assert.equal(loaded.cacheState, "loaded");
    assert.equal(loaded.quotas.claude?.window?.id, "five_hour");
    assert.equal(loaded.quotas.claude?.window?.remainingPercent, 25);
    assert.equal(loaded.quotas.copilot?.window?.remainingPercent, 100);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing or invalid routing config reports the personal fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-routing-config-"));
  const cachePath = join(root, "missing-cache.json");
  try {
    const missing = await loadRoutingState({ agentDir: root, cachePath });
    assert.equal(missing.environment, "personal");
    assert.match(missing.configError ?? "", /missing/);

    await writeFile(
      join(root, "subagent-routing.json"),
      '{"version":2,"environment":"corporate"}\n',
      { mode: 0o600 },
    );
    const invalid = await loadRoutingState({ agentDir: root, cachePath });
    assert.equal(invalid.environment, "personal");
    assert.match(invalid.configError ?? "", /version 1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("routing config keeps valid model candidates and reports rejected ones", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-routing-models-"));
  const cachePath = join(root, "missing-cache.json");
  try {
    await writeFile(
      join(root, "subagent-routing.json"),
      JSON.stringify({
        version: 1,
        environment: "corporate",
        models: {
          quick: [
            {
              harness: "pi",
              model: "github-copilot/gpt-5.6-luna",
              effort: "low",
            },
            { harness: "kiro", model: "claude-haiku-4.5", effort: "low" },
            { harness: "claude" },
          ],
          code_review: [
            { harness: "pi", model: "gpt-6-astra" },
            { harness: "kiro", model: "gpt-6-astra" },
            { harness: "codex", model: "gpt-5.6-terra", effort: "ludicrous" },
            { harness: "nonesuch", model: "x" },
          ],
          unknown_kind: [{ harness: "pi" }],
        },
      }),
      { mode: 0o600 },
    );
    const loaded = await loadRoutingState({ agentDir: root, cachePath });
    assert.deepEqual(loaded.models, {
      quick: [
        { harness: "pi", model: "github-copilot/gpt-5.6-luna", effort: "low" },
        { harness: "kiro", model: "claude-haiku-4.5", effort: "low" },
        { harness: "claude" },
      ],
    });
    // pi needs provider/id, kiro takes Claude models only, and the effort and
    // harness names must be known values.
    assert.match(
      loaded.configError ?? "",
      /code_review\[0\], code_review\[1\], code_review\[2\], code_review\[3\], unknown_kind/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configured candidates win over built-in tiers and carry model and effort", () => {
  const models = {
    code_review: [
      {
        harness: "kiro" as const,
        model: "claude-sonnet-5",
        effort: "high" as const,
      },
      {
        harness: "claude" as const,
        model: "sonnet-5",
        effort: "high" as const,
      },
      {
        harness: "codex" as const,
        model: "gpt-5.6-terra",
        effort: "high" as const,
      },
    ],
    quick: [
      {
        harness: "pi" as const,
        model: "github-copilot/gpt-5.6-luna",
        effort: "low" as const,
      },
    ],
  };
  const configured = {
    ...state("corporate", {
      claude: quota("claude", 90),
      codex: quota("codex", 20),
      copilot: quota("copilot", 10),
      kiro: quota("kiro", 50),
    }),
    models,
  };

  // Same group: the freshest-allowance candidate wins regardless of order.
  const review = routeSubagent(
    {
      taskKind: "code_review",
      available: all,
      parentProvider: "github-copilot",
    },
    configured,
  );
  assert.equal(review.harness, "claude");
  assert.equal(review.harnessModel, "sonnet-5");
  assert.equal(review.reasoningEffort, "high");
  assert.equal(review.quotaCompared, true);
  assert.match(review.reason, /configured models for code_review/);

  // An unavailable configured harness drops out of the group.
  const kiroOnly = routeSubagent(
    {
      taskKind: "code_review",
      available: new Set<BackendName>(["kiro"]),
      parentProvider: "github-copilot",
    },
    configured,
  );
  assert.equal(kiroOnly.harness, "kiro");
  assert.equal(kiroOnly.harnessModel, "claude-sonnet-5");

  // A Pi candidate draws on its configured model's provider allowance.
  const quick = routeSubagent(
    { taskKind: "quick", available: all, parentProvider: "anthropic" },
    configured,
  );
  assert.equal(quick.harness, "pi");
  assert.equal(quick.harnessModel, "github-copilot/gpt-5.6-luna");
  assert.equal(quick.reasoningEffort, "low");
  assert.equal(quick.candidates[0]?.provider, "copilot");

  // An explicit effort still overrides the configured one.
  const overridden = routeSubagent(
    {
      taskKind: "quick",
      reasoningEffort: "max",
      available: all,
      parentProvider: "anthropic",
    },
    configured,
  );
  assert.equal(overridden.reasoningEffort, "max");

  // Unlisted task kinds keep the built-in tiers and carry no model.
  const research = routeSubagent(
    {
      taskKind: "code_research",
      available: all,
      parentProvider: "github-copilot",
    },
    configured,
  );
  assert.equal(research.harnessModel, undefined);
  assert.match(research.reason, /task-fit tier/);

  // A harness override takes its model and effort from the configured entry.
  const override = routeSubagent(
    {
      taskKind: "code_review",
      override: "codex",
      available: all,
      parentProvider: "github-copilot",
    },
    configured,
  );
  assert.equal(override.harnessModel, "gpt-5.6-terra");
  assert.equal(override.reasoningEffort, "high");
});

test("quota comparison needs a shared window kind and prefers the five-hour one", () => {
  const models = {
    code_review: [
      { harness: "claude" as const, model: "opus" },
      { harness: "codex" as const, model: "gpt-6-astra" },
    ],
  };

  // claude reports five_hour + weekly, codex only weekly: compare on weekly.
  const weekly = routeSubagent(
    {
      taskKind: "code_review",
      available: all,
      parentProvider: "github-copilot",
    },
    {
      ...state("corporate", {
        claude: quotaWindows("claude", [
          ["five_hour", 90],
          ["weekly", 10],
        ]),
        codex: quotaWindows("codex", [["weekly", 80]]),
      }),
      models,
    },
  );
  assert.equal(weekly.harness, "codex");
  assert.equal(weekly.quotaCompared, true);
  assert.match(weekly.reason, /highest weekly allowance/);

  // Both report a five-hour window: it wins over the weekly one.
  const fiveHour = routeSubagent(
    {
      taskKind: "code_review",
      available: all,
      parentProvider: "github-copilot",
    },
    {
      ...state("corporate", {
        claude: quotaWindows("claude", [
          ["five_hour", 90],
          ["weekly", 10],
        ]),
        codex: quotaWindows("codex", [
          ["five_hour", 20],
          ["weekly", 80],
        ]),
      }),
      models,
    },
  );
  assert.equal(fiveHour.harness, "claude");
  assert.match(fiveHour.reason, /highest five-hour allowance/);

  // No shared kind: the configured order stands.
  const incomparable = routeSubagent(
    {
      taskKind: "code_review",
      available: all,
      parentProvider: "github-copilot",
    },
    {
      ...state("corporate", {
        claude: quotaWindows("claude", [["five_hour", 10]]),
        codex: quotaWindows("codex", [["weekly", 99]]),
      }),
      models,
    },
  );
  assert.equal(incomparable.harness, "claude");
  assert.equal(incomparable.quotaCompared, false);
  assert.match(incomparable.reason, /no shared window kind/);
});

test("routing diagnostics show policy, quota, and effective decisions", () => {
  const lines = routingDiagnosticLines({
    state: state("corporate", {
      copilot: quota("copilot", 20),
      claude: quota("claude", 80),
      kiro: quota("kiro", 50),
    }),
    available: all,
    parentProvider: "github-copilot",
  });
  const output = lines.join("\n");
  assert.match(output, /Environment: corporate/);
  assert.match(output, /Allowance by window/);
  assert.match(output, /Task kinds by category:/);
  assert.match(output, /analysis: code_research, planning, code_review/);
  assert.match(output, /Task-fit tiers \(before access filtering\):/);
  assert.match(output, /Corporate access requirements \(Kiro-only\):/);
  assert.match(output, /github-ix\.int\.automotive-wan\.com/);
  assert.match(output, /Effective automatic decisions \(no required access\):/);
  assert.match(output, /general: claude/);
  assert.match(output, /Effective required-access decisions/);
  assert.match(output, /jira: kiro/);
});

test("cache loader safely rejects stale, malformed, and insecure input", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "subagent-routing-bad-"));
  const agentDir = join(root, "agent");
  const cachePath = join(root, "snapshots.json");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "subagent-routing.json"),
    '{"version":1,"environment":"corporate"}\n',
    { mode: 0o600 },
  );
  await writeFile(
    cachePath,
    `${JSON.stringify({
      version: 1,
      snapshots: {
        kiro: {
          provider: "kiro",
          observedAt: "2026-09-16T10:00:00.000Z",
          windows: [
            {
              id: "credits",
              label: "credits",
              kind: "monthly",
              remaining: 80,
              limit: 100,
            },
          ],
        },
      },
    })}\n`,
    { mode: 0o600 },
  );

  try {
    const stale = await loadRoutingState({
      agentDir,
      cachePath,
      now: Date.parse("2026-09-16T12:00:00.000Z"),
    });
    assert.equal(stale.quotas.kiro?.fresh, false);
    assert.equal(stale.quotas.kiro?.window?.remainingPercent, 80);

    await writeFile(cachePath, '{"version":2,"snapshots":{}}\n', {
      mode: 0o600,
    });
    const invalid = await loadRoutingState({ agentDir, cachePath });
    assert.equal(invalid.cacheState, "invalid");

    if (process.platform === "win32") {
      t.diagnostic("owner-only mode checks are POSIX-only");
    } else {
      await writeFile(cachePath, '{"version":1,"snapshots":{}}\n', {
        mode: 0o600,
      });
      await chmod(cachePath, 0o644);
      const insecure = await loadRoutingState({ agentDir, cachePath });
      assert.equal(insecure.cacheState, "insecure");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
