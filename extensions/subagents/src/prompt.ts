/** All model-facing strings for the subagents tools. */

/** Describes subagent_spawn, including harnesses and the fixed concurrency cap. */
export const SUBAGENT_SPAWN_TOOL_DESCRIPTION =
  "Spawn a background subagent: a fully autonomous, headless agent with its own context window and normal host permissions. Classify the work with task_kind and separately declare any required corporate-system access; a deterministic router chooses the harness and default thinking level from task fit, access eligibility, backend availability, environment policy, and fresh subscription allowance. Set harness only when the user explicitly requests that harness. Fire-and-forget: this returns immediately with an id. The subagent's final output is queued back to you when it settles, or collect it explicitly with subagent_wait. Children cannot orchestrate more agents/workflows or ask the user, and cannot see this conversation, so the prompt must be self-contained. Only use trusted working directories. Max 4 subagents can be running at once across all harnesses.";

/** Adds background subagent delegation to the parent model's available-tools prompt. */
export const SUBAGENT_SPAWN_PROMPT_SNIPPET =
  "Spawn a background subagent with deterministic harness and thinking-level selection";

/** Guides the parent model to delegate standalone tasks and avoid unnecessary blocking waits. */
export const SUBAGENT_SPAWN_PROMPT_GUIDELINES = [
  "Use subagent_spawn to delegate self-contained tasks that can run in the background; give it a complete, standalone prompt.",
  "Choose task_kind by the work being done, not by the tool being accessed. Use required_access only for company Jira, company Confluence, or github-ix.int.automotive-wan.com; public GitHub does not require github_ix.",
  "Do not choose a harness yourself: omit harness unless the user explicitly requested Pi, Claude Code, Codex, or Kiro.",
  "Omit reasoning_effort to use the task-kind default; set it only when the user explicitly requests a thinking level.",
  "After subagent_spawn, keep working; results arrive automatically. Only call subagent_wait when you cannot proceed without the result.",
];

/** Model-facing schema descriptions for subagent_spawn task and execution options. */
export const SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS = {
  prompt:
    "Task prompt for the subagent. Must be self-contained: include all needed context, file paths, and what to report back.",
  name: "Short human-readable name for this subagent, shown in listings and the UI",
  taskKind:
    "Kind of work used for task-fit routing: quick for trivial lookups, edits, or summaries; code_research/planning/code_review for analysis (planning = designing an approach or architecture without editing); large_refactor/test_authoring for sustained changes, isolated_implementation/algorithmic for bounded changes, otherwise general. Remote systems are not task kinds.",
  requiredAccess:
    'Corporate systems the task must access. Values: "jira" for company Jira, "confluence" for company Confluence, and "github_ix" ONLY for the internal GitHub host github-ix.int.automotive-wan.com. Kiro is the only eligible harness. Omit for public GitHub (including github.com), local clones, and tasks that do not need these systems.',
  harness:
    'Optional explicit user override: "pi", "claude", "codex", or "kiro". Omit this unless the user explicitly requested a harness.',
  workingDir:
    "Trusted working directory for the autonomous child (default: current working directory)",
  model:
    'Model hint for an explicit harness override (pi: authenticated "provider/model-id" or an unambiguous available model id; claude: model alias like "sonnet"/"opus"; codex: model slug; kiro: "agent:model", "agent:", or a bare model slug, always a Claude model). Omit during automatic routing because model hints are harness-specific.',
  reasoningEffort:
    "Optional thinking override on the shared off/minimal/low/medium/high/xhigh/max scale. Defaults by task_kind: low for quick, medium for general/code_research/isolated_implementation, high for planning/code_review/test_authoring, and xhigh for large_refactor/algorithmic. Pi uses it directly, Codex clamps it to model support, Claude passes it as its effort level, and Kiro ignores it.",
};

/** Builds the subagent_spawn result that tells the parent model how to continue or inspect the child. */
export function buildSubagentSpawnResult(options: {
  id: string;
  title: string;
  harness: string;
  modelLabel: string;
  cwd: string;
  reasoningEffort: string;
  routingReason: string;
}) {
  return (
    `Spawned subagent ${options.id} "${options.title}" (${options.harness}: ${options.modelLabel}, thinking: ${options.reasoningEffort}, ${options.cwd}).\n` +
    `Routing: ${options.routingReason}.\n` +
    `It runs in the background. Its result will be delivered to you when it finishes, ` +
    `or use subagent_wait(ids: ["${options.id}"]) to block for it, subagent_cancel to stop it, subagent_check to peek, subagent_list to see all.`
  );
}

/** Describes explicit blocking collection of one or more subagent results. */
export const SUBAGENT_WAIT_TOOL_DESCRIPTION =
  "Block until all listed subagents have settled, then return their final outputs. Prefer letting results arrive automatically; use this only when you need a result before continuing.";

/** Model-facing schema description for the subagent ids to await. */
export const SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent ids to wait for, e.g. ["sa-1", "sa-2"]',
};

/** Describes aborting running subagents while retaining their partial transcripts. */
export const SUBAGENT_CANCEL_TOOL_DESCRIPTION =
  "Cancel one or more running subagents. This aborts their active work but preserves their partial session transcripts on disk.";

/** Model-facing schema description for the subagent ids to cancel. */
export const SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent ids to cancel, e.g. ["sa-1", "sa-2"]',
};

/** Describes nonblocking inspection of a subagent without consuming its result. */
export const SUBAGENT_CHECK_TOOL_DESCRIPTION =
  "Peek at a subagent's status and recent activity without blocking. Does not consume its result.";

/** Model-facing schema description for the subagent id to inspect. */
export const SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS = {
  id: "Subagent id",
};

/** Describes listing all tracked running and settled subagents. */
export const SUBAGENT_LIST_TOOL_DESCRIPTION =
  "List all subagents (running and finished) with their harness and status.";

/** Builds the child completion/failure wrapper injected into the parent model's context. */
export function buildSubagentResultMessage(options: {
  id: string;
  title: string;
  status: "running" | "done" | "error";
  errorText?: string;
  output: string;
}) {
  const verb = options.status === "error" ? "failed" : "finished";
  let text = `Subagent ${options.id} "${options.title}" ${verb}.`;
  if (options.errorText) text += `\nError: ${options.errorText}`;
  text += `\n\n${options.output}`;
  return text;
}
