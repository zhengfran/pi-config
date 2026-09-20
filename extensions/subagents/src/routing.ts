import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BackendName, ReasoningEffort } from "./domain.ts";
import { REASONING_EFFORTS } from "./domain.ts";

export const TASK_KINDS = [
  "general",
  "quick",
  "code_research",
  "planning",
  "code_review",
  "large_refactor",
  "test_authoring",
  "isolated_implementation",
  "algorithmic",
] as const;

/**
 * Corporate toolchain access is orthogonal to the kind of work. Kiro is the
 * only harness with these connectors. `github_ix` means only the company host
 * github-ix.int.automotive-wan.com, never public GitHub such as github.com.
 */
export const CORPORATE_ACCESS_REQUIREMENTS = [
  "jira",
  "confluence",
  "github_ix",
] as const;

export type TaskKind = (typeof TASK_KINDS)[number];
export type CorporateAccessRequirement =
  (typeof CORPORATE_ACCESS_REQUIREMENTS)[number];
export type TaskCategory =
  "general" | "analysis" | "sustained_change" | "bounded_change";
export type RoutingEnvironment = "corporate" | "personal";
export type UsageProvider = "claude" | "codex" | "copilot" | "kiro";

export const TASK_KIND_CATEGORIES = {
  general: "general",
  quick: "general",
  code_research: "analysis",
  planning: "analysis",
  code_review: "analysis",
  large_refactor: "sustained_change",
  test_authoring: "sustained_change",
  isolated_implementation: "bounded_change",
  algorithmic: "bounded_change",
} as const satisfies Readonly<Record<TaskKind, TaskCategory>>;

export const TASK_KIND_REASONING_EFFORTS = {
  general: "medium",
  quick: "low",
  code_research: "medium",
  planning: "high",
  code_review: "high",
  large_refactor: "xhigh",
  test_authoring: "high",
  isolated_implementation: "medium",
  algorithmic: "xhigh",
} as const satisfies Readonly<Record<TaskKind, ReasoningEffort>>;

type WindowKind = "five_hour" | "weekly" | "monthly" | "model" | "other";

export interface QuotaWindow {
  readonly id: string;
  readonly label: string;
  readonly kind: WindowKind;
  readonly remainingPercent?: number;
  readonly resetsAt?: string;
}

export interface ProviderQuota {
  readonly provider: UsageProvider;
  readonly observedAt: string;
  readonly ageMs: number;
  readonly fresh: boolean;
  readonly window?: QuotaWindow;
}

export interface RoutingState {
  readonly environment: RoutingEnvironment;
  readonly configPath: string;
  readonly configError?: string;
  readonly freshnessMinutes: number;
  readonly cachePath: string;
  readonly cacheState: "loaded" | "missing" | "invalid" | "insecure";
  readonly cacheError?: string;
  readonly quotas: Partial<Record<UsageProvider, ProviderQuota>>;
  /** Machine-local harness/model/effort candidates by task kind. */
  readonly models?: TaskModelDefaults;
}

/**
 * One explicitly configured way to run a task kind. Candidates for a task kind
 * share a preference group: quota reorders them when every available one has
 * fresh, comparable data, otherwise the configured order stands.
 */
export interface TaskModelCandidate {
  readonly harness: BackendName;
  /** Harness-specific model hint; omitted keeps that harness's own default. */
  readonly model?: string;
  /** Effort for this candidate; omitted falls back to the task-kind default. */
  readonly effort?: ReasoningEffort;
}

export type TaskModelDefaults = Readonly<
  Partial<Record<TaskKind, ReadonlyArray<TaskModelCandidate>>>
>;

export interface RoutingRequest {
  readonly taskKind: TaskKind;
  readonly requiredAccess?: ReadonlyArray<CorporateAccessRequirement>;
  readonly reasoningEffort?: ReasoningEffort;
  readonly override?: BackendName;
  readonly available: ReadonlySet<BackendName>;
  readonly parentProvider?: string;
}

export interface CandidateAssessment {
  readonly harness: BackendName;
  readonly provider?: UsageProvider;
  readonly quota?: ProviderQuota;
  /** Configured model hint this candidate would spawn with. */
  readonly model?: string;
  /** Configured effort for this candidate, before the task-kind default. */
  readonly effort?: ReasoningEffort;
}

export interface RoutingDecision {
  readonly harness: BackendName;
  readonly taskKind: TaskKind;
  readonly requiredAccess: ReadonlyArray<CorporateAccessRequirement>;
  readonly reasoningEffort: ReasoningEffort;
  readonly environment: RoutingEnvironment;
  readonly mode: "automatic" | "override";
  readonly tier: number;
  readonly quotaCompared: boolean;
  readonly candidates: ReadonlyArray<CandidateAssessment>;
  readonly reason: string;
  /** Configured model hint for this task kind and harness, when one applies. */
  readonly harnessModel?: string;
}

export interface RoutingPaths {
  readonly agentDir: string;
  readonly cachePath?: string;
  readonly now?: number;
}

const PROVIDERS = ["claude", "codex", "copilot", "kiro"] as const;
const DEFAULT_FRESHNESS_MINUTES = 5;
const WINDOW_KIND_RANK: Record<WindowKind, number> = {
  five_hour: 0,
  weekly: 1,
  monthly: 2,
  model: 3,
  other: 4,
};

const CORPORATE_ACCESS_HARNESSES: Record<
  CorporateAccessRequirement,
  ReadonlySet<BackendName>
> = {
  jira: new Set(["kiro"]),
  confluence: new Set(["kiro"]),
  github_ix: new Set(["kiro"]),
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function parseEnvironment(value: unknown): RoutingEnvironment | undefined {
  return value === "corporate" || value === "personal" ? value : undefined;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

/** Pi needs a provider-qualified id because a bare id can be ambiguous. */
function isPiModelHint(model: string): boolean {
  return /^[^/\s]+\/\S+$/.test(model);
}

/**
 * Kiro hints are "agent:model", "agent:" or "model". Kiro serves only Claude
 * models plus its own "auto" picker, so a named model must be one of those; an
 * agent-only hint keeps Kiro's default.
 */
function isKiroModelHint(model: string): boolean {
  const separator = model.indexOf(":");
  const name = (separator === -1 ? model : model.slice(separator + 1)).trim();
  if (separator !== -1 && model.slice(0, separator).trim() === "") return false;
  if (name === "") return separator !== -1;
  return /^claude/i.test(name) || name.toLowerCase() === "auto";
}

const MODEL_HINTS: Record<
  BackendName,
  { valid: (model: string) => boolean; shape: string }
> = {
  pi: { valid: isPiModelHint, shape: '"provider/model-id"' },
  kiro: {
    valid: isKiroModelHint,
    shape: 'a Claude model or "auto", as "agent:model", "agent:" or "model"',
  },
  claude: { valid: (model) => /^\S+$/.test(model), shape: "a model alias" },
  codex: { valid: (model) => /^\S+$/.test(model), shape: "a model slug" },
};

function parseCandidate(value: unknown): TaskModelCandidate | undefined {
  const entry = record(value);
  const harness = entry?.harness;
  if (
    typeof harness !== "string" ||
    !(BACKEND_ORDER as ReadonlyArray<string>).includes(harness)
  ) {
    return undefined;
  }
  const name = harness as BackendName;
  const model = entry?.model;
  if (model !== undefined) {
    if (typeof model !== "string" || !MODEL_HINTS[name].valid(model)) {
      return undefined;
    }
  }
  const effort = entry?.effort;
  if (
    effort !== undefined &&
    !(REASONING_EFFORTS as ReadonlyArray<unknown>).includes(effort)
  ) {
    return undefined;
  }
  return {
    harness: name,
    ...(typeof model === "string" ? { model } : {}),
    ...(effort ? { effort: effort as ReasoningEffort } : {}),
  };
}

/**
 * Keep valid entries and report the rest, so one typo does not discard the
 * whole map. A task kind whose candidates are all invalid falls back to the
 * built-in tiers, same as an unlisted one.
 */
function parseTaskModels(value: unknown): {
  models?: TaskModelDefaults;
  error?: string;
} {
  if (value === undefined) return {};
  const entries = record(value);
  if (!entries) return { error: "models must be an object; ignored" };
  const models: Partial<Record<TaskKind, ReadonlyArray<TaskModelCandidate>>> =
    {};
  const rejected: string[] = [];
  for (const [taskKind, listed] of Object.entries(entries)) {
    if (
      !(TASK_KINDS as ReadonlyArray<string>).includes(taskKind) ||
      !Array.isArray(listed)
    ) {
      rejected.push(taskKind);
      continue;
    }
    const candidates: TaskModelCandidate[] = [];
    for (const [index, item] of listed.entries()) {
      const candidate = parseCandidate(item);
      if (candidate) candidates.push(candidate);
      else rejected.push(`${taskKind}[${index}]`);
    }
    if (candidates.length > 0) models[taskKind as TaskKind] = candidates;
  }
  return {
    ...(Object.keys(models).length > 0 ? { models } : {}),
    ...(rejected.length > 0
      ? {
          error: `models entries need a known task kind and a list of {harness, model?, effort?}; ignored: ${rejected.join(", ")}`,
        }
      : {}),
  };
}

async function loadEnvironment(configPath: string): Promise<{
  environment: RoutingEnvironment;
  models?: TaskModelDefaults;
  error?: string;
}> {
  try {
    const root = record(await readJson(configPath));
    const environment = parseEnvironment(root?.environment);
    if (root?.version !== 1 || !environment) {
      return {
        environment: "personal",
        error:
          'routing config must contain version 1 and environment "corporate" or "personal"',
      };
    }
    const { models, error } = parseTaskModels(root.models);
    return {
      environment,
      ...(models ? { models } : {}),
      ...(error ? { error } : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        environment: "personal",
        error: "routing config is missing; defaulting to personal",
      };
    }
    return {
      environment: "personal",
      error: "routing config could not be read; defaulting to personal",
    };
  }
}

async function loadFreshnessMinutes(agentDir: string): Promise<number> {
  try {
    const root = record(
      await readJson(join(agentDir, "subscription-usage.json")),
    );
    const value = finite(root?.refreshIntervalMinutes);
    return value !== undefined && value >= 1 && value <= 1440
      ? value
      : DEFAULT_FRESHNESS_MINUTES;
  } catch {
    return DEFAULT_FRESHNESS_MINUTES;
  }
}

function parseWindow(value: unknown, now: number): QuotaWindow | undefined {
  const raw = record(value);
  if (!raw || typeof raw.id !== "string" || typeof raw.label !== "string") {
    return undefined;
  }
  const kind =
    raw.kind === "five_hour" ||
    raw.kind === "weekly" ||
    raw.kind === "monthly" ||
    raw.kind === "model" ||
    raw.kind === "other"
      ? raw.kind
      : undefined;
  if (!kind) return undefined;

  const resetsAt = typeof raw.resetsAt === "string" ? raw.resetsAt : undefined;
  if (resetsAt) {
    const reset = Date.parse(resetsAt);
    if (!Number.isFinite(reset) || reset <= now) return undefined;
  }

  let remainingPercent: number | undefined;
  if (raw.unlimited === true) {
    remainingPercent = 100;
  } else {
    const usedPercent = finite(raw.usedPercent);
    const remaining = finite(raw.remaining);
    const limit = finite(raw.limit);
    if (usedPercent !== undefined && usedPercent >= 0 && usedPercent <= 100) {
      remainingPercent = clampPercent(100 - usedPercent);
    } else if (
      remaining !== undefined &&
      limit !== undefined &&
      limit > 0 &&
      remaining >= 0 &&
      remaining <= limit
    ) {
      remainingPercent = clampPercent((remaining / limit) * 100);
    }
  }

  return {
    id: raw.id,
    label: raw.label,
    kind,
    remainingPercent,
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function shortestWindow(
  windows: unknown[],
  now: number,
): QuotaWindow | undefined {
  const parsed = windows
    .map((value) => parseWindow(value, now))
    .filter((value) => value !== undefined);
  return parsed.sort((left, right) => {
    const rank = WINDOW_KIND_RANK[left.kind] - WINDOW_KIND_RANK[right.kind];
    if (rank !== 0) return rank;
    const remaining =
      (left.remainingPercent ?? Infinity) -
      (right.remainingPercent ?? Infinity);
    return remaining || left.id.localeCompare(right.id);
  })[0];
}

function parseQuota(
  provider: UsageProvider,
  value: unknown,
  now: number,
  freshnessMs: number,
): ProviderQuota | undefined {
  const snapshot = record(value);
  if (
    !snapshot ||
    snapshot.provider !== provider ||
    typeof snapshot.observedAt !== "string" ||
    !Array.isArray(snapshot.windows)
  ) {
    return undefined;
  }
  const observed = Date.parse(snapshot.observedAt);
  if (!Number.isFinite(observed)) return undefined;
  const ageMs = Math.max(0, now - observed);
  return {
    provider,
    observedAt: snapshot.observedAt,
    ageMs,
    fresh: observed <= now + 60_000 && ageMs <= freshnessMs,
    window: shortestWindow(snapshot.windows, now),
  };
}

async function cacheIsPrivate(path: string): Promise<boolean> {
  if (process.platform === "win32") return true;
  const info = await stat(path);
  const ownerMatches =
    typeof process.getuid !== "function" || info.uid === process.getuid();
  return info.isFile() && ownerMatches && (info.mode & 0o077) === 0;
}

function defaultCachePath(): string {
  return join(
    process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
    "pi-subscription-usage",
    "snapshots.json",
  );
}

export async function loadRoutingState(
  paths: RoutingPaths,
): Promise<RoutingState> {
  const now = paths.now ?? Date.now();
  const configPath = join(paths.agentDir, "subagent-routing.json");
  const cachePath = paths.cachePath ?? defaultCachePath();
  const [{ environment, models, error: configError }, freshnessMinutes] =
    await Promise.all([
      loadEnvironment(configPath),
      loadFreshnessMinutes(paths.agentDir),
    ]);
  const base = {
    environment,
    ...(models ? { models } : {}),
    configPath,
    ...(configError ? { configError } : {}),
    freshnessMinutes,
    cachePath,
  };

  try {
    if (!(await cacheIsPrivate(cachePath))) {
      return {
        ...base,
        cacheState: "insecure",
        cacheError: "usage cache is not owner-only",
        quotas: {},
      };
    }
    const root = record(await readJson(cachePath));
    const snapshots = record(root?.snapshots);
    if (root?.version !== 1 || !snapshots) {
      return {
        ...base,
        cacheState: "invalid",
        cacheError: "usage cache has an unsupported or invalid format",
        quotas: {},
      };
    }
    const freshnessMs = freshnessMinutes * 60_000;
    const quotas: Partial<Record<UsageProvider, ProviderQuota>> = {};
    for (const provider of PROVIDERS) {
      const quota = parseQuota(provider, snapshots[provider], now, freshnessMs);
      if (quota) quotas[provider] = quota;
    }
    return { ...base, cacheState: "loaded", quotas };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...base, cacheState: "missing", quotas: {} };
    }
    return {
      ...base,
      cacheState: "invalid",
      cacheError: "usage cache could not be read",
      quotas: {},
    };
  }
}

export function taskFitTiers(
  taskKind: TaskKind,
  environment: RoutingEnvironment,
): ReadonlyArray<ReadonlyArray<BackendName>> {
  const category = TASK_KIND_CATEGORIES[taskKind];
  if (category === "sustained_change") {
    return environment === "corporate"
      ? [
          ["claude", "pi"],
          ["codex", "kiro"],
        ]
      : [
          ["claude", "pi"],
          ["codex", "kiro"],
        ];
  }
  if (category === "bounded_change") {
    // Corporate keeps Kiro first for its own allowance; personal prefers Codex.
    return environment === "corporate"
      ? [
          ["kiro", "pi"],
          ["codex", "claude"],
        ]
      : [
          ["codex", "pi"],
          ["claude", "kiro"],
        ];
  }
  if (category === "general" || category === "analysis") {
    return [["pi", "claude", "kiro"], ["codex"]];
  }
  return [["pi"]];
}

export function harnessSupportsRequiredAccess(
  harness: BackendName,
  requiredAccess: ReadonlyArray<CorporateAccessRequirement>,
): boolean {
  return requiredAccess.every((requirement) =>
    CORPORATE_ACCESS_HARNESSES[requirement].has(harness),
  );
}

function requiredAccessLabel(
  requiredAccess: ReadonlyArray<CorporateAccessRequirement>,
): string {
  return requiredAccess.length > 0 ? requiredAccess.join(", ") : "none";
}

function providerForHarness(
  harness: BackendName,
  parentProvider: string | undefined,
): UsageProvider | undefined {
  if (harness === "pi") {
    return parentProvider === "github-copilot" ? "copilot" : undefined;
  }
  return harness;
}

function configuredCandidates(
  request: RoutingRequest,
  state: RoutingState,
): ReadonlyArray<TaskModelCandidate> {
  return state.models?.[request.taskKind] ?? [];
}

function assessCandidate(
  harness: BackendName,
  request: RoutingRequest,
  state: RoutingState,
  configured?: TaskModelCandidate,
): CandidateAssessment {
  // A configured Pi model draws on its own provider's allowance, not the parent's.
  const piModel = harness === "pi" ? configured?.model : undefined;
  const provider = providerForHarness(
    harness,
    piModel ? piModel.slice(0, piModel.indexOf("/")) : request.parentProvider,
  );
  return {
    harness,
    ...(provider ? { provider, quota: state.quotas[provider] } : {}),
    ...(configured?.model ? { model: configured.model } : {}),
    ...(configured?.effort ? { effort: configured.effort } : {}),
  };
}

/** Quota order within one preference group; ties keep the configured order. */
function rankByQuota(candidates: ReadonlyArray<CandidateAssessment>): {
  ranked: ReadonlyArray<CandidateAssessment>;
  quotaCompared: boolean;
} {
  const quotaCompared =
    candidates.length > 1 &&
    candidates.every(
      (candidate) => comparableRemaining(candidate) !== undefined,
    );
  if (!quotaCompared) return { ranked: candidates, quotaCompared };
  const ranked = candidates
    .map((candidate, order) => ({ candidate, order }))
    .sort(
      (left, right) =>
        (comparableRemaining(right.candidate) ?? -1) -
          (comparableRemaining(left.candidate) ?? -1) ||
        left.order - right.order,
    )
    .map(({ candidate }) => candidate);
  return { ranked, quotaCompared };
}

function comparableRemaining(
  candidate: CandidateAssessment,
): number | undefined {
  const quota = candidate.quota;
  return quota?.fresh ? quota.window?.remainingPercent : undefined;
}

function formatQuota(candidate: CandidateAssessment): string {
  const remaining = comparableRemaining(candidate);
  if (remaining === undefined) return "quota unavailable";
  return `${candidate.quota?.window?.label ?? "allowance"} ${remaining.toFixed(1)}% remaining`;
}

export function routeSubagent(
  request: RoutingRequest,
  state: RoutingState,
): RoutingDecision {
  const requiredAccess = [...new Set(request.requiredAccess ?? [])];
  const taskEffort = TASK_KIND_REASONING_EFFORTS[request.taskKind];
  const reasoningEffort = request.reasoningEffort ?? taskEffort;
  const accessReason =
    requiredAccess.length > 0
      ? `; required corporate access: ${requiredAccessLabel(requiredAccess)}`
      : "";
  if (request.override) {
    if (!request.available.has(request.override)) {
      throw new Error(
        `Requested subagent harness "${request.override}" is unavailable.`,
      );
    }
    if (!harnessSupportsRequiredAccess(request.override, requiredAccess)) {
      throw new Error(
        `Requested subagent harness "${request.override}" cannot provide required corporate access: ${requiredAccessLabel(requiredAccess)}.`,
      );
    }
    const configured = configuredCandidates(request, state).find(
      (entry) => entry.harness === request.override,
    );
    const candidate = assessCandidate(
      request.override,
      request,
      state,
      configured,
    );
    return {
      harness: request.override,
      taskKind: request.taskKind,
      requiredAccess,
      reasoningEffort:
        request.reasoningEffort ?? candidate.effort ?? taskEffort,
      environment: state.environment,
      mode: "override",
      tier: 0,
      quotaCompared: false,
      candidates: [candidate],
      reason: `explicit user override selected ${request.override}${accessReason}`,
      ...(candidate.model ? { harnessModel: candidate.model } : {}),
    };
  }

  // Explicitly configured candidates form one preference group and win over
  // the built-in tiers; an unlisted task kind falls back to them.
  const eligible = configuredCandidates(request, state).filter(
    (entry) =>
      request.available.has(entry.harness) &&
      harnessSupportsRequiredAccess(entry.harness, requiredAccess),
  );
  if (eligible.length > 0) {
    const { ranked, quotaCompared } = rankByQuota(
      eligible.map((entry) =>
        assessCandidate(entry.harness, request, state, entry),
      ),
    );
    const selected = ranked[0];
    if (selected) {
      const label = `${selected.harness}${selected.model ? ` (${selected.model})` : ""}`;
      return {
        harness: selected.harness,
        taskKind: request.taskKind,
        requiredAccess,
        reasoningEffort:
          request.reasoningEffort ?? selected.effort ?? taskEffort,
        environment: state.environment,
        mode: "automatic",
        tier: 1,
        quotaCompared,
        candidates: ranked,
        reason: quotaCompared
          ? `configured models for ${request.taskKind}${accessReason}; ${label} has the highest shortest-window allowance (${formatQuota(selected)})`
          : ranked.length === 1
            ? `configured models for ${request.taskKind}${accessReason}; ${label} is the only eligible available candidate (${formatQuota(selected)})`
            : `configured models for ${request.taskKind}${accessReason}; quota data is incomplete, so configured order selected ${label}`,
        ...(selected.model ? { harnessModel: selected.model } : {}),
      };
    }
  }

  const tiers = taskFitTiers(request.taskKind, state.environment);
  for (let index = 0; index < tiers.length; index += 1) {
    const available = tiers[index]?.filter(
      (name) =>
        request.available.has(name) &&
        harnessSupportsRequiredAccess(name, requiredAccess),
    );
    if (!available || available.length === 0) continue;
    const { ranked, quotaCompared } = rankByQuota(
      available.map((name) => assessCandidate(name, request, state)),
    );
    const selected = ranked[0];
    if (!selected) continue;
    return {
      harness: selected.harness,
      taskKind: request.taskKind,
      requiredAccess,
      reasoningEffort,
      environment: state.environment,
      mode: "automatic",
      tier: index + 1,
      quotaCompared,
      candidates: ranked,
      reason: quotaCompared
        ? `${state.environment} task-fit tier ${index + 1}${accessReason}; ${selected.harness} has the highest shortest-window allowance (${formatQuota(selected)})`
        : ranked.length === 1
          ? `${state.environment} task-fit tier ${index + 1}${accessReason}; ${selected.harness} is the only eligible available candidate (${formatQuota(selected)})`
          : `${state.environment} task-fit tier ${index + 1}${accessReason}; quota data is incomplete, so fixed order selected ${selected.harness}`,
    };
  }

  const accessConstraint =
    requiredAccess.length > 0
      ? ` with required corporate access "${requiredAccessLabel(requiredAccess)}"`
      : "";
  throw new Error(
    `No available subagent harness can handle task kind "${request.taskKind}"${accessConstraint} in ${state.environment} mode.`,
  );
}

function ageLabel(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000);
  return minutes < 1 ? "<1m" : `${minutes}m`;
}

export function routingDiagnosticLines(options: {
  readonly state: RoutingState;
  readonly available: ReadonlySet<BackendName>;
  readonly parentProvider?: string;
}): string[] {
  const { state, available, parentProvider } = options;
  const lines = [
    `Environment: ${state.environment}`,
    `Config: ${state.configPath}${state.configError ? ` (${state.configError})` : ""}`,
    `Usage cache: ${state.cacheState} · ${state.cachePath}`,
    `Freshness: ${state.freshnessMinutes}m${state.cacheError ? ` · ${state.cacheError}` : ""}`,
    `Parent provider: ${parentProvider ?? "unknown"}`,
    `Available harnesses: ${BACKEND_ORDER.map((name) => `${name}=${available.has(name) ? "yes" : "no"}`).join(" · ")}`,
    "",
    "Shortest-window allowance:",
  ];
  for (const provider of PROVIDERS) {
    const quota = state.quotas[provider];
    if (!quota) {
      lines.push(`  ${provider}: unavailable`);
      continue;
    }
    const remaining = quota.window?.remainingPercent;
    lines.push(
      `  ${provider}: ${quota.fresh ? "fresh" : "stale"} ${ageLabel(quota.ageMs)} · ${quota.window?.label ?? "no window"}${remaining === undefined ? " · remaining unknown" : ` · ${remaining.toFixed(1)}% remaining`}`,
    );
  }
  lines.push("", "Configured models by task kind (quota orders each list):");
  for (const taskKind of TASK_KINDS) {
    const configured = state.models?.[taskKind];
    lines.push(
      `  ${taskKind}: ${
        configured && configured.length > 0
          ? configured
              .map(
                (candidate) =>
                  `${candidate.harness}/${candidate.model ?? "default"} ${candidate.effort ?? TASK_KIND_REASONING_EFFORTS[taskKind]}`,
              )
              .join(" · ")
          : "built-in tiers"
      }`,
    );
  }
  lines.push("", "Task kinds by category:");
  for (const category of [
    "general",
    "analysis",
    "sustained_change",
    "bounded_change",
  ] as const) {
    const kinds = TASK_KINDS.filter(
      (taskKind) => TASK_KIND_CATEGORIES[taskKind] === category,
    );
    lines.push(`  ${category}: ${kinds.join(", ")}`);
  }
  lines.push("", "Task-fit tiers (before access filtering):");
  for (const taskKind of TASK_KINDS) {
    const tiers = taskFitTiers(taskKind, state.environment)
      .map((tier) => `[${tier.join(", ")}]`)
      .join(" → ");
    lines.push(
      `  ${taskKind}: thinking=${TASK_KIND_REASONING_EFFORTS[taskKind]} · ${tiers}`,
    );
  }
  lines.push(
    "",
    "Corporate access requirements (Kiro-only):",
    "  jira: company Jira",
    "  confluence: company Confluence",
    "  github_ix: only github-ix.int.automotive-wan.com (not public GitHub)",
  );
  lines.push("", "Effective automatic decisions (no required access):");
  for (const taskKind of TASK_KINDS) {
    try {
      const decision = routeSubagent(
        { taskKind, available, parentProvider },
        state,
      );
      const model = decision.harnessModel ? ` (${decision.harnessModel})` : "";
      lines.push(
        `  ${taskKind}: ${decision.harness}${model} · ${decision.reason}`,
      );
    } catch (error) {
      lines.push(
        `  ${taskKind}: unavailable · ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  lines.push("", "Effective required-access decisions (general task):");
  for (const requirement of CORPORATE_ACCESS_REQUIREMENTS) {
    try {
      const decision = routeSubagent(
        {
          taskKind: "general",
          requiredAccess: [requirement],
          available,
          parentProvider,
        },
        state,
      );
      lines.push(`  ${requirement}: ${decision.harness}`);
    } catch (error) {
      lines.push(
        `  ${requirement}: unavailable · ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  lines.push(
    "",
    "Quota reorders a tier only when every available candidate in that tier has fresh, comparable data.",
    "A selected harness is not retried on another backend if spawn fails.",
  );
  return lines;
}

const BACKEND_ORDER: ReadonlyArray<BackendName> = [
  "pi",
  "claude",
  "codex",
  "kiro",
];
