/**
 * Portable agent profiles — version-1 contract.
 *
 * Markdown files with versioned YAML frontmatter plus a Markdown role body.
 * User profiles live under `<agentDir>/agents/*.md`; project overrides live
 * under `<cwd>/.pi/agents/*.md`. Project profiles are only ever loaded when
 * the caller passes an already-resolved, persisted trust decision for that
 * cwd (a strict `boolean`, `=== true`) — this module never reads a trust
 * store or infers trust from `cwd` itself, per the profile-capability
 * contract (2026-09-26).
 *
 * Schema, allowed keys, name uniqueness and symlink containment all fail
 * closed: a malformed *trusted* project override makes that name
 * unavailable rather than silently falling back to the global profile of
 * the same name (see the contract's edge-case scenarios).
 *
 * No YAML dependency: v1's frontmatter shape (scalars, inline lists, one
 * level of nested mappings under `harness`) is small enough that this file
 * implements a strict, hand-rolled subset parser instead of adding one.
 */

import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BackendName, ReasoningEffort } from "./domain.ts";
import { BACKEND_NAMES, REASONING_EFFORTS } from "./domain.ts";
import type { CorporateAccessRequirement, TaskKind } from "./routing.ts";
import { CORPORATE_ACCESS_REQUIREMENTS, TASK_KINDS } from "./routing.ts";

// --- Public types ------------------------------------------------------------

export const ROLE_DELIVERIES = ["any", "privileged_required"] as const;
export type RoleDelivery = (typeof ROLE_DELIVERIES)[number];

/** Portable hard requirements a v1 profile can declare. Extend deliberately. */
export const REQUIRE_TOKENS = ["filesystem_read_only"] as const;
export type RequireToken = (typeof REQUIRE_TOKENS)[number];

/**
 * Hints and native mappings only — never a capability enforcement mechanism
 * by themselves. A caller must independently verify any boundary `requires`
 * demands before trusting a native tool list as a security boundary.
 */
export interface HarnessHint {
  readonly model?: string;
  readonly effort?: ReasoningEffort;
  /** pi `--tools` hint. */
  readonly tools?: ReadonlyArray<string>;
  /** claude `--allowedTools` hint. */
  readonly allowedTools?: ReadonlyArray<string>;
  /** claude `--disallowedTools` hint. */
  readonly disallowedTools?: ReadonlyArray<string>;
}

export interface ParsedProfile {
  readonly version: 1;
  readonly name: string;
  readonly description?: string;
  readonly taskKind?: TaskKind;
  readonly requiredAccess: ReadonlyArray<CorporateAccessRequirement>;
  readonly requires: ReadonlyArray<RequireToken>;
  readonly messageTo: ReadonlyArray<string>;
  readonly roleDelivery: RoleDelivery;
  readonly harness: Readonly<Partial<Record<BackendName, HarnessHint>>>;
  readonly roleBody: string;
  /** sha256 of the raw file content, for the resolved immutable loadout. */
  readonly contentHash: string;
}

export type ProfileScope = "user" | "project";

export interface AgentProfile extends ParsedProfile {
  readonly scope: ProfileScope;
  /** Real, symlink-resolved path this profile was loaded from. */
  readonly sourcePath: string;
}

export type ProfileParseResult =
  | { readonly ok: true; readonly profile: ParsedProfile }
  | { readonly ok: false; readonly error: string; readonly name?: string };

export type ProfileDiagnosticLevel = "error" | "info";

export interface ProfileDiagnostic {
  readonly level: ProfileDiagnosticLevel;
  readonly scope: ProfileScope;
  readonly path?: string;
  readonly message: string;
}

export interface DiscoverProfilesOptions {
  /** Pi's configured agent directory, e.g. `getAgentDir()`. */
  readonly agentDir: string;
  readonly cwd: string;
  /**
   * Explicit, already-persisted trust decision for `cwd` (or its containing
   * directory), resolved by the caller — e.g.
   * `projectTrustStore.get(cwd) === true`. Must be a real `boolean`; a
   * missing/`null` decision must be turned into `false` by the caller before
   * calling this function. This module does not consult a trust store,
   * `ctx.isProjectTrusted()`, or the mere presence of `.pi` itself.
   */
  readonly projectTrusted: boolean;
}

export interface ProfileResolution {
  /** Effective profiles by name: a trusted valid override replaces the global entry entirely. */
  readonly profiles: ReadonlyMap<string, AgentProfile>;
  readonly diagnostics: ReadonlyArray<ProfileDiagnostic>;
}

export class AgentProfileNotFoundError extends Error {
  constructor(name: string) {
    super(`No agent profile named "${name}" is available.`);
    this.name = "AgentProfileNotFoundError";
  }
}

// --- Strict YAML-subset parser -----------------------------------------------

type YamlScalar = string | number | boolean;
type YamlValue = YamlScalar | YamlValue[] | { [key: string]: YamlValue };
type YamlRecord = Record<string, YamlValue>;

interface YamlParseError {
  readonly error: string;
}

interface RawLine {
  readonly indent: number;
  readonly content: string;
  readonly lineNo: number;
}

function isRecord(value: YamlValue): value is YamlRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tokenizeFrontmatter(text: string): RawLine[] | YamlParseError {
  const lines: RawLine[] = [];
  for (const [index, raw] of text.split("\n").entries()) {
    if (raw.trim() === "") continue;
    if (raw.includes("\t")) {
      return {
        error: `line ${index + 1}: tabs are not allowed in frontmatter`,
      };
    }
    const indent = raw.length - raw.trimStart().length;
    if (indent % 2 !== 0) {
      return {
        error: `line ${index + 1}: indentation must be a multiple of two spaces`,
      };
    }
    lines.push({ indent, content: raw.trim(), lineNo: index + 1 });
  }
  return lines;
}

function parseScalar(text: string): YamlScalar {
  const trimmed = text.trim();
  if (trimmed.length >= 2) {
    const quoted =
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"));
    if (quoted) return trimmed.slice(1, -1);
  }
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return trimmed;
}

function parseInlineList(
  text: string,
): { value: YamlValue[] } | YamlParseError {
  const inner = text.slice(1, -1).trim();
  if (inner === "") return { value: [] };
  const parts = inner.split(",").map((part) => part.trim());
  if (parts.some((part) => part === "")) {
    return { error: "list has an empty item" };
  }
  return { value: parts.map(parseScalar) };
}

const KEY_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/;

/** YAML-style comments begin at an unquoted # preceded by whitespace. */
function withoutComment(text: string): string {
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "\\" && quote === '"') {
      i++;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = quote === char ? undefined : (quote ?? char);
    } else if (!quote && char === "#" && (i === 0 || /\s/.test(text[i - 1]!))) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text;
}

/** Parses one block of same-indent `key: value` lines, recursing into nested mappings. */
function parseBlock(
  lines: ReadonlyArray<RawLine>,
  start: number,
  indent: number,
): { value: YamlRecord; next: number } | YamlParseError {
  const result: YamlRecord = Object.create(null) as YamlRecord;
  let i = start;
  while (i < lines.length && lines[i]!.indent === indent) {
    const line = lines[i]!;
    const match = KEY_PATTERN.exec(line.content);
    if (!match) return { error: `line ${line.lineNo}: expected "key: value"` };
    const key = match[1]!;
    if (["__proto__", "constructor", "prototype"].includes(key)) {
      return { error: `line ${line.lineNo}: forbidden key "${key}"` };
    }
    const rest = withoutComment(match[2]!).trimEnd();
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      return { error: `line ${line.lineNo}: duplicate key "${key}"` };
    }
    if (rest === "") {
      const childLine = lines[i + 1];
      if (!childLine || childLine.indent <= indent) {
        return { error: `line ${line.lineNo}: key "${key}" has no value` };
      }
      if (childLine.indent !== indent + 2) {
        return {
          error: `line ${childLine.lineNo}: expected 2-space indent under "${key}"`,
        };
      }
      const nested = parseBlock(lines, i + 1, childLine.indent);
      if ("error" in nested) return nested;
      result[key] = nested.value;
      i = nested.next;
    } else if (rest === "{}") {
      result[key] = {};
      i += 1;
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      const list = parseInlineList(rest);
      if ("error" in list)
        return { error: `line ${line.lineNo}: ${list.error}` };
      result[key] = list.value;
      i += 1;
    } else if (rest.startsWith("{") || rest.startsWith("[")) {
      return {
        error: `line ${line.lineNo}: unsupported inline value for "${key}"`,
      };
    } else {
      result[key] = parseScalar(rest);
      i += 1;
    }
  }
  if (i < lines.length && lines[i]!.indent > indent) {
    return { error: `line ${lines[i]!.lineNo}: unexpected indentation` };
  }
  return { value: result, next: i };
}

function splitFrontmatter(
  raw: string,
): { frontmatter: string; body: string } | YamlParseError {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") {
    return { error: "file must start with a --- frontmatter fence" };
  }
  const endIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === "---",
  );
  if (endIndex === -1) {
    return { error: "frontmatter has no closing --- fence" };
  }
  const body = lines
    .slice(endIndex + 1)
    .join("\n")
    .trim();
  if (body === "") return { error: "role body is empty" };
  return { frontmatter: lines.slice(1, endIndex).join("\n"), body };
}

/** Best-effort `name` lookup for a file that otherwise fails to parse, so a
 *  malformed trusted override can still block its intended global name. */
function extractNameBestEffort(text: string): string | undefined {
  const match = /^name:\s*(.+)$/m.exec(text);
  if (!match) return undefined;
  const candidate = parseScalar(withoutComment(match[1]!));
  return typeof candidate === "string" && candidate.trim() !== ""
    ? candidate.trim()
    : undefined;
}

// --- Field validation ---------------------------------------------------------

const ALLOWED_TOP_KEYS = new Set([
  "version",
  "name",
  "description",
  "task_kind",
  "required_access",
  "requires",
  "message_to",
  "role_delivery",
  "harness",
]);

const NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const PEER_PATTERN = /^peer:[A-Za-z0-9_-]{1,64}$/;

const HARNESS_COMMON_KEYS = new Set(["model", "effort"]);
const HARNESS_EXTRA_KEYS: Readonly<Record<BackendName, ReadonlySet<string>>> = {
  pi: new Set(["tools"]),
  claude: new Set(["allowed_tools", "disallowed_tools"]),
  codex: new Set(),
  kiro: new Set(),
};

function parseStringArray<T extends string>(
  value: YamlValue | undefined,
  field: string,
  allowed: ReadonlyArray<T>,
): { value: ReadonlyArray<T> } | YamlParseError {
  if (value === undefined) return { value: [] };
  if (!Array.isArray(value))
    return { error: `field "${field}" must be a list` };
  const result: T[] = [];
  for (const item of value) {
    if (
      typeof item !== "string" ||
      !(allowed as ReadonlyArray<string>).includes(item)
    ) {
      return {
        error: `field "${field}" has an unrecognized value: ${String(item)}`,
      };
    }
    result.push(item as T);
  }
  return { value: result };
}

function parseMessageTo(
  value: YamlValue | undefined,
): { value: ReadonlyArray<string> } | YamlParseError {
  if (value === undefined) return { value: [] };
  if (!Array.isArray(value))
    return { error: 'field "message_to" must be a list' };
  const result: string[] = [];
  for (const item of value) {
    if (
      typeof item !== "string" ||
      !(item === "parent" || PEER_PATTERN.test(item))
    ) {
      return {
        error: `field "message_to" has an invalid target: ${String(item)}`,
      };
    }
    result.push(item);
  }
  return { value: result };
}

function parseToolList(
  value: YamlValue,
  field: string,
): { value: ReadonlyArray<string> } | YamlParseError {
  if (!Array.isArray(value))
    return { error: `field "${field}" must be a list` };
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") {
      return { error: `field "${field}" has an invalid entry` };
    }
    result.push(item);
  }
  return { value: result };
}

function parseHarness(
  value: YamlValue | undefined,
):
  | { value: Readonly<Partial<Record<BackendName, HarnessHint>>> }
  | YamlParseError {
  if (value === undefined) return { value: {} };
  if (!isRecord(value)) return { error: 'field "harness" must be a mapping' };
  const result: Partial<Record<BackendName, HarnessHint>> = {};
  for (const [harnessName, entryValue] of Object.entries(value)) {
    if (!(BACKEND_NAMES as ReadonlyArray<string>).includes(harnessName)) {
      return {
        error: `field "harness" has an unknown backend: ${harnessName}`,
      };
    }
    const backend = harnessName as BackendName;
    if (!isRecord(entryValue)) {
      return { error: `field "harness.${harnessName}" must be a mapping` };
    }
    const allowedKeys = new Set([
      ...HARNESS_COMMON_KEYS,
      ...HARNESS_EXTRA_KEYS[backend],
    ]);
    const unknown = Object.keys(entryValue).filter(
      (key) => !allowedKeys.has(key),
    );
    if (unknown.length > 0) {
      return {
        error: `field "harness.${harnessName}" has unknown key(s): ${unknown.join(", ")}`,
      };
    }
    const hint: {
      model?: string;
      effort?: ReasoningEffort;
      tools?: ReadonlyArray<string>;
      allowedTools?: ReadonlyArray<string>;
      disallowedTools?: ReadonlyArray<string>;
    } = {};
    if (entryValue.model !== undefined) {
      if (
        typeof entryValue.model !== "string" ||
        entryValue.model.trim() === ""
      ) {
        return {
          error: `field "harness.${harnessName}.model" must be a non-empty string`,
        };
      }
      hint.model = entryValue.model;
    }
    if (entryValue.effort !== undefined) {
      if (
        typeof entryValue.effort !== "string" ||
        !(REASONING_EFFORTS as ReadonlyArray<string>).includes(
          entryValue.effort,
        )
      ) {
        return {
          error: `field "harness.${harnessName}.effort" must be one of: ${REASONING_EFFORTS.join(", ")}`,
        };
      }
      hint.effort = entryValue.effort as ReasoningEffort;
    }
    if (backend === "pi" && entryValue.tools !== undefined) {
      const tools = parseToolList(entryValue.tools, "harness.pi.tools");
      if ("error" in tools) return tools;
      hint.tools = tools.value;
    }
    if (backend === "claude" && entryValue.allowed_tools !== undefined) {
      const tools = parseToolList(
        entryValue.allowed_tools,
        "harness.claude.allowed_tools",
      );
      if ("error" in tools) return tools;
      hint.allowedTools = tools.value;
    }
    if (backend === "claude" && entryValue.disallowed_tools !== undefined) {
      const tools = parseToolList(
        entryValue.disallowed_tools,
        "harness.claude.disallowed_tools",
      );
      if ("error" in tools) return tools;
      hint.disallowedTools = tools.value;
    }
    result[backend] = hint;
  }
  return { value: result };
}

function validateFields(
  fields: YamlRecord,
): { value: Omit<ParsedProfile, "roleBody" | "contentHash"> } | YamlParseError {
  const unknown = Object.keys(fields).filter(
    (key) => !ALLOWED_TOP_KEYS.has(key),
  );
  if (unknown.length > 0) {
    return { error: `unknown field(s): ${unknown.join(", ")}` };
  }

  if (fields.version !== 1) return { error: 'field "version" must be 1' };

  const name = fields.name;
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    return {
      error:
        'field "name" must be a non-empty string matching [A-Za-z0-9_-]{1,64}',
    };
  }

  let description: string | undefined;
  if (fields.description !== undefined) {
    if (typeof fields.description !== "string") {
      return { error: 'field "description" must be a string' };
    }
    description = fields.description;
  }

  let taskKind: TaskKind | undefined;
  if (fields.task_kind !== undefined) {
    if (
      typeof fields.task_kind !== "string" ||
      !(TASK_KINDS as ReadonlyArray<string>).includes(fields.task_kind)
    ) {
      return {
        error: `field "task_kind" must be one of: ${TASK_KINDS.join(", ")}`,
      };
    }
    taskKind = fields.task_kind as TaskKind;
  }

  const requiredAccess = parseStringArray(
    fields.required_access,
    "required_access",
    CORPORATE_ACCESS_REQUIREMENTS,
  );
  if ("error" in requiredAccess) return requiredAccess;

  const requires = parseStringArray(
    fields.requires,
    "requires",
    REQUIRE_TOKENS,
  );
  if ("error" in requires) return requires;

  const messageTo = parseMessageTo(fields.message_to);
  if ("error" in messageTo) return messageTo;

  let roleDelivery: RoleDelivery = "any";
  if (fields.role_delivery !== undefined) {
    if (
      typeof fields.role_delivery !== "string" ||
      !(ROLE_DELIVERIES as ReadonlyArray<string>).includes(fields.role_delivery)
    ) {
      return {
        error: `field "role_delivery" must be one of: ${ROLE_DELIVERIES.join(", ")}`,
      };
    }
    roleDelivery = fields.role_delivery as RoleDelivery;
  }

  const harness = parseHarness(fields.harness);
  if ("error" in harness) return harness;

  return {
    value: {
      version: 1,
      name,
      ...(description !== undefined ? { description } : {}),
      ...(taskKind !== undefined ? { taskKind } : {}),
      requiredAccess: requiredAccess.value,
      requires: requires.value,
      messageTo: messageTo.value,
      roleDelivery,
      harness: harness.value,
    },
  };
}

/** Pure parse of one profile file's content — no filesystem access. */
export function parseProfileMarkdown(raw: string): ProfileParseResult {
  const split = splitFrontmatter(raw);
  if ("error" in split) {
    return { ok: false, error: split.error, name: extractNameBestEffort(raw) };
  }
  const tokens = tokenizeFrontmatter(split.frontmatter);
  if ("error" in tokens) {
    return {
      ok: false,
      error: tokens.error,
      name: extractNameBestEffort(split.frontmatter),
    };
  }
  if (tokens.length === 0) {
    return { ok: false, error: "frontmatter is empty" };
  }
  if (tokens[0]!.indent !== 0) {
    return { ok: false, error: "frontmatter keys must start at column 0" };
  }
  const parsed = parseBlock(tokens, 0, 0);
  if ("error" in parsed) {
    return {
      ok: false,
      error: parsed.error,
      name: extractNameBestEffort(split.frontmatter),
    };
  }
  if (parsed.next !== tokens.length) {
    return { ok: false, error: "unexpected trailing content in frontmatter" };
  }
  const fields = validateFields(parsed.value);
  if ("error" in fields) {
    return {
      ok: false,
      error: fields.error,
      name:
        typeof parsed.value.name === "string" ? parsed.value.name : undefined,
    };
  }
  const contentHash = createHash("sha256").update(raw).digest("hex");
  return {
    ok: true,
    profile: { ...fields.value, roleBody: split.body, contentHash },
  };
}

// --- Filesystem discovery -----------------------------------------------------

interface ScopeReadResult {
  readonly valid: ReadonlyMap<string, AgentProfile>;
  /** Names that must not fall back to a lower-precedence scope (project only). */
  readonly blockedNames: ReadonlySet<string>;
  readonly diagnostics: ReadonlyArray<ProfileDiagnostic>;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function readScopeProfiles(
  dir: string,
  scope: ProfileScope,
  expectedRealDir: string,
): Promise<ScopeReadResult> {
  const diagnostics: ProfileDiagnostic[] = [];
  const valid = new Map<string, AgentProfile>();
  const blockedNames = new Set<string>();
  const rejectedNames = new Set<string>();

  let dirReal: string;
  try {
    dirReal = await realpath(dir);
    if (scope === "project" && dirReal !== expectedRealDir) {
      diagnostics.push({
        level: "error",
        scope,
        path: dir,
        message:
          "agent profile directory escapes its configured scope; rejected",
      });
      return { valid, blockedNames, diagnostics };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      diagnostics.push({
        level: "error",
        scope,
        path: dir,
        message: `could not read agent profile directory: ${(error as Error).message}`,
      });
    }
    return { valid, blockedNames, diagnostics };
  }

  let entries: string[];
  try {
    entries = (await readdir(dir))
      .filter((entry) => entry.endsWith(".md"))
      .sort();
  } catch (error) {
    diagnostics.push({
      level: "error",
      scope,
      path: dir,
      message: `could not list agent profile directory: ${(error as Error).message}`,
    });
    return { valid, blockedNames, diagnostics };
  }

  for (const entry of entries) {
    const filePath = join(dir, entry);
    const fallbackName = entry.slice(0, -3);

    const fail = (message: string, name: string = fallbackName) => {
      diagnostics.push({ level: "error", scope, path: filePath, message });
      // Filename is the author's apparent override target even if a malformed
      // `name:` differs. Never use a permissive global profile on that name.
      for (const blocked of new Set([
        fallbackName,
        name,
        name.replace(/\s+#.*$/, ""),
      ])) {
        blockedNames.add(blocked);
        rejectedNames.add(blocked);
        valid.delete(blocked);
      }
    };

    let content: string;
    try {
      const stats = await lstat(filePath);
      if (stats.isSymbolicLink()) {
        const real = await realpath(filePath);
        if (dirname(real) !== dirReal) {
          fail("symlink escapes the agent profile directory; rejected");
          continue;
        }
        content = await readFile(real, "utf8");
      } else if (stats.isFile()) {
        content = await readFile(filePath, "utf8");
      } else {
        fail("not a regular file or symlink; rejected");
        continue;
      }
    } catch (error) {
      fail(`could not read profile: ${(error as Error).message}`);
      continue;
    }

    const result = parseProfileMarkdown(content);
    if (!result.ok) {
      fail(result.error, result.name ?? fallbackName);
      continue;
    }

    const profile: AgentProfile = {
      ...result.profile,
      scope,
      sourcePath: filePath,
    };
    if (valid.has(profile.name) || rejectedNames.has(profile.name)) {
      diagnostics.push({
        level: "error",
        scope,
        path: filePath,
        message: `duplicate agent profile name "${profile.name}" in ${scope} scope; both rejected`,
      });
      valid.delete(profile.name);
      rejectedNames.add(profile.name);
      if (scope === "project") blockedNames.add(profile.name);
      continue;
    }
    valid.set(profile.name, profile);
  }

  return { valid, blockedNames, diagnostics };
}

/**
 * Discovers and resolves version-1 agent profiles from the user scope
 * (always) and the project scope (only when `options.projectTrusted` is
 * exactly `true`, a decision the caller must already have persisted).
 *
 * A trusted, valid project profile replaces a global profile of the same
 * name in entirety. A trusted but malformed/duplicate project profile makes
 * that name unavailable outright — it never silently falls back to the
 * global profile of the same name. An untrusted project scope contributes
 * no profiles at all; the global scope remains available with a diagnostic.
 */
export async function discoverAgentProfiles(
  options: DiscoverProfilesOptions,
): Promise<ProfileResolution> {
  const diagnostics: ProfileDiagnostic[] = [];
  const userDir = join(options.agentDir, "agents");
  let userRoot: string;
  try {
    userRoot = await realpath(options.agentDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      profiles: new Map(),
      diagnostics: [
        {
          level: "info",
          scope: "user",
          path: options.agentDir,
          message: "user agent directory does not exist; no profiles available",
        },
      ],
    };
  }
  const user = await readScopeProfiles(
    userDir,
    "user",
    join(userRoot, "agents"),
  );
  diagnostics.push(...user.diagnostics);
  const profiles = new Map(user.valid);

  const projectDir = join(options.cwd, ".pi", "agents");
  if (options.projectTrusted === true) {
    const projectRoot = await realpath(options.cwd);
    const project = await readScopeProfiles(
      projectDir,
      "project",
      join(projectRoot, ".pi", "agents"),
    );
    const unsafeDirectory = project.diagnostics.find(
      (entry) => entry.level === "error" && entry.path === projectDir,
    );
    if (unsafeDirectory) throw new Error(unsafeDirectory.message);
    diagnostics.push(...project.diagnostics);
    for (const name of project.blockedNames) {
      const hadGlobal = profiles.delete(name);
      diagnostics.push({
        level: "error",
        scope: "project",
        message: `agent profile "${name}" has a malformed trusted project override; it is unavailable${hadGlobal ? " (the global profile of the same name is not used)" : ""}`,
      });
    }
    for (const [name, profile] of project.valid) {
      profiles.set(name, profile);
    }
  } else if (await pathExists(projectDir)) {
    diagnostics.push({
      level: "info",
      scope: "project",
      path: projectDir,
      message: "project agent profiles ignored: project is not trusted",
    });
  }

  return { profiles, diagnostics };
}

// --- Resolution helpers for callers (e.g. index.ts) --------------------------

export function getAgentProfile(
  resolution: ProfileResolution,
  name: string,
): AgentProfile | undefined {
  return resolution.profiles.get(name);
}

/** Throws `AgentProfileNotFoundError` rather than falling back to an ad hoc spawn. */
export function requireAgentProfile(
  resolution: ProfileResolution,
  name: string,
): AgentProfile {
  const profile = resolution.profiles.get(name);
  if (!profile) throw new AgentProfileNotFoundError(name);
  return profile;
}

/**
 * A call may add restrictions but never loosen a profile: task_kind may be
 * omitted (comes from the profile) but a supplied one that disagrees is a
 * classification conflict, not a silent reclassification.
 */
export function resolveProfileTaskKind(
  profile: AgentProfile,
  requested?: TaskKind,
): TaskKind {
  if (profile.taskKind === undefined) {
    if (requested === undefined) {
      throw new Error(
        `Agent profile "${profile.name}" does not set task_kind; task_kind is required.`,
      );
    }
    return requested;
  }
  if (requested !== undefined && requested !== profile.taskKind) {
    throw new Error(
      `task_kind "${requested}" conflicts with agent profile "${profile.name}"'s task_kind "${profile.taskKind}".`,
    );
  }
  return profile.taskKind;
}

/** Union, never subtraction: a call can widen required_access, not narrow it. */
export function mergeRequiredAccess(
  profile: AgentProfile,
  requested: ReadonlyArray<CorporateAccessRequirement> = [],
): ReadonlyArray<CorporateAccessRequirement> {
  return [...new Set([...profile.requiredAccess, ...requested])];
}

/** `target` is `"parent"` or `"peer:<name>"`; the broker still checks the live instance/group. */
export function profileAllowsMessageTarget(
  profile: AgentProfile,
  target: string,
): boolean {
  return profile.messageTo.includes(target);
}

export function profileHarnessHint(
  profile: AgentProfile,
  backend: BackendName,
): HarnessHint | undefined {
  return profile.harness[backend];
}
