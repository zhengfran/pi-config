/**
 * Kiro backend — real implementation over `kiro-cli chat --no-interactive`.
 *
 * Unlike the claude and codex backends, kiro-cli exposes no event protocol:
 * one invocation takes a prompt, streams markdown to stdout, and exits. So a
 * "session" here is not a live process — it is a transcript plus whichever
 * child process is currently running. Each run spawns a fresh child; context
 * is carried forward by prepending the prior transcript to the next prompt,
 * because kiro-cli can only resume by a session id it never reports back.
 *
 * Two hazards drive most of this file:
 *
 * 1. kiro-cli authenticates through AWS SSO. With no stored login it starts an
 *    interactive device-code flow and waits for a browser confirmation that a
 *    headless child can never provide — it hangs indefinitely rather than
 *    exiting. `available` pre-checks kiro-cli's own credential store, and
 *    every run additionally watches its output for the login banner so a
 *    session that loses auth mid-flight fails fast instead of wedging.
 * 2. Output is a TUI stream, not a data stream: spinners, cursor moves, and
 *    colour codes are interleaved with the actual answer. Everything is
 *    stripped before it reaches the normalized event stream.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import type { Cause, Scope } from "effect";
import { Effect, Queue, Stream } from "effect";
import type { SubagentBackend, SubagentSession } from "../backend.ts";
import type {
  QueuedMessage,
  RunOutcome,
  SpawnTask,
  SubagentEvent,
  SubagentMeta,
} from "../domain.ts";
import { SendError, SpawnError } from "../domain.ts";

const FORCE_KILL_AFTER_MS = 2_000;
const PREVIEW_MAX_LENGTH = 1_024;
/** Transcript carried into a follow-up run; bounded so context can't grow without limit. */
const MAX_CARRIED_TRANSCRIPT_CHARS = 24_000;
const MAX_STDERR_CHARS = 4_096;

/**
 * Substrings that mean kiro-cli has dropped into an interactive SSO login.
 * Matched case-insensitively against stripped stdout+stderr.
 */
const LOGIN_PROMPT_MARKERS = [
  "confirm the following code in the browser",
  "view.awsapps.com/start",
  "device?user_code=",
  "not logged in",
  "please run `kiro-cli login`",
  "please run 'kiro-cli login'",
] as const;

const AUTH_HINT =
  "kiro-cli is not authenticated. Run `kiro-cli login` in a terminal and complete the browser step, then retry.";

// --- Binary + auth helpers ---------------------------------------------------

let cachedKiroBinary: string | null | undefined;

function executable(file: string) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve once on first use; availability checks after that are allocation-only. */
function resolveKiroBinary() {
  if (cachedKiroBinary !== undefined) return cachedKiroBinary ?? undefined;
  const names =
    process.platform === "win32"
      ? ["kiro-cli.exe", "kiro-cli.cmd"]
      : ["kiro-cli"];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (executable(candidate)) {
        cachedKiroBinary = candidate;
        return candidate;
      }
    }
  }
  cachedKiroBinary = null;
  return undefined;
}

/**
 * Best-effort check for a usable login. kiro-cli does not use the AWS CLI's
 * `~/.aws/sso/cache`; it keeps OIDC material in its own SQLite store under
 * `auth_kv`.
 *
 * This only has to catch the common "never logged in" case cheaply. It is
 * deliberately permissive in every ambiguous direction — an unreadable store,
 * a schema change, or an access token past `expires_at` but holding a refresh
 * token all report available — because the run-time login-banner watchdog is
 * the real safety net. A false positive costs one fast-failing run; a false
 * negative would make the backend permanently unreachable.
 */
function kiroLoginPresent() {
  const dataHome =
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  const dbPath = path.join(dataHome, "kiro-cli", "data.sqlite3");
  if (!fs.existsSync(dbPath)) return false;

  let record: string | undefined;
  try {
    // node:sqlite is still flagged experimental, so it is required lazily:
    // a runtime without it must not take the whole extension down.
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (
        p: string,
        o?: { readOnly?: boolean },
      ) => {
        prepare: (sql: string) => { get: (...p: string[]) => unknown };
        close: () => void;
      };
    };
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare("select value from auth_kv where key = ?")
        .get("kirocli:odic:token") as { value?: unknown } | undefined;
      if (row === undefined) return false;
      record = typeof row.value === "string" ? row.value : undefined;
    } finally {
      db.close();
    }
  } catch {
    // Locked, missing, or a schema we don't recognise: let the run proceed
    // and let the watchdog decide.
    return true;
  }
  if (record === undefined) return true;

  try {
    const token = JSON.parse(record) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_at?: unknown;
    };
    if (typeof token.access_token !== "string") return false;
    // Access tokens live about an hour; kiro-cli refreshes them itself, so an
    // expired one is only fatal when there is nothing to refresh with.
    if (typeof token.refresh_token === "string") return true;
    if (typeof token.expires_at !== "string") return true;
    const expiry = Date.parse(token.expires_at);
    return Number.isNaN(expiry) ? true : expiry > Date.now();
  } catch {
    return true;
  }
}

// --- Output normalization ----------------------------------------------------

/** CSI sequences: colours, cursor moves, the cursor-hide kiro-cli emits. */
const CSI_PATTERN = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
/** OSC sequences (window titles), terminated by BEL or ST. */
const OSC_PATTERN = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;
/** Any remaining lone escape, e.g. a sequence split across two chunks. */
const LONE_ESCAPE_PATTERN = /\u001B[@-_]?/g;
/** C0 controls except tab and newline, which are meaningful in markdown. */
const CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
/** Braille/block spinner frames kiro-cli paints while waiting. */
const SPINNER_PATTERN = /[\u25B0\u25B1\u2800-\u28FF]/g;
/**
 * kiro-cli opens its answer with a colourised "> " marker
 * (`ESC[38;5;141m> ESC[0m`). Stripping ANSI generically would leave a bare
 * "> " that reads as a markdown blockquote in the delivered result, so it is
 * matched with its escapes still attached — content can't forge that.
 */
const RESPONSE_MARKER_PATTERN = /^\u001B\[[0-9;]*m>\s\u001B\[[0-9;]*m/;

/** Banner kiro-cli always prints to stderr under --trust-all-tools. */
const TRUST_BANNER_MARKERS = [
  "all tools are now trusted",
  "agents can sometimes do unexpected things",
  "kiro.dev/docs/cli/chat/security",
] as const;

/** Pick a real error line, skipping the unconditional trust banner. */
function errorDetail(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .find(
      (line) =>
        line.length > 0 &&
        !TRUST_BANNER_MARKERS.some((marker) =>
          line.toLowerCase().includes(marker),
        ),
    )
    ?.slice(0, PREVIEW_MAX_LENGTH);
}

function stripTerminalNoise(value: string) {
  return value
    .replace(CSI_PATTERN, "")
    .replace(OSC_PATTERN, "")
    .replace(LONE_ESCAPE_PATTERN, "")
    .replace(SPINNER_PATTERN, "")
    .replace(CONTROL_PATTERN, "")
    .replace(/\r/g, "");
}

function boundedError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    4096,
  );
}

function looksLikeLoginPrompt(value: string) {
  const haystack = value.toLowerCase();
  return LOGIN_PROMPT_MARKERS.some((marker) => haystack.includes(marker));
}

/**
 * `model` is the generic per-backend hint. For kiro it accepts an optional
 * agent prefix, because agent selection (which MCP connectors are wired up)
 * matters more here than model choice:
 *
 *   "aumo-work:"            -> agent only, default model
 *   "aumo-work:claude-4.5"  -> agent + model
 *   "claude-4.5"            -> model only, default agent
 */
function parseModelHint(hint: string | undefined) {
  if (!hint) return {};
  const separator = hint.indexOf(":");
  if (separator === -1) return { model: hint };
  const agent = hint.slice(0, separator).trim();
  const model = hint.slice(separator + 1).trim();
  return {
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
  };
}

// --- The session -------------------------------------------------------------

const makeKiroSession = (
  task: SpawnTask,
): Effect.Effect<SubagentSession, SpawnError, Scope.Scope> =>
  Effect.gen(function* () {
    const binary = resolveKiroBinary();
    if (!binary) {
      return yield* new SpawnError({
        message: "kiro-cli executable was not found on PATH.",
      });
    }
    if (!kiroLoginPresent()) {
      return yield* new SpawnError({ message: AUTH_HINT });
    }

    const { agent, model } = parseModelHint(task.model);

    const events = yield* Queue.make<SubagentEvent, Cause.Done>();
    const emit = (event: SubagentEvent) => {
      Queue.offerUnsafe(events, event);
    };

    const state = {
      closed: false,
      closing: false,
      activeRun: false,
      interruptRequested: false,
      runSerial: 0,
      child: undefined as ChildProcessWithoutNullStreams | undefined,
      childExited: true,
      stdout: "",
      stderr: "",
      finalText: "",
      pendingPrompts: [] as string[],
      /** Prior turns, replayed into follow-up prompts since kiro-cli can't resume. */
      history: [] as Array<{ role: "user" | "assistant"; text: string }>,
      meta: {
        backend: "kiro",
        modelLabel: agent ? `${agent}${model ? `/${model}` : ""}` : model,
      } satisfies SubagentMeta as SubagentMeta,
    };

    const queuedView = (): ReadonlyArray<QueuedMessage> =>
      state.pendingPrompts.map((text) => ({
        text,
        kind: "follow-up" as const,
      }));

    /**
     * kiro-cli has no resume-by-handle we can drive, so continuity is
     * reconstructed textually. Oldest turns are dropped first when the
     * carried transcript exceeds the budget.
     */
    const composePrompt = (text: string) => {
      if (state.history.length === 0) return text;
      const lines: string[] = [];
      let budget = MAX_CARRIED_TRANSCRIPT_CHARS;
      for (let index = state.history.length - 1; index >= 0; index -= 1) {
        const turn = state.history[index];
        if (!turn) continue;
        const rendered = `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text}`;
        if (rendered.length > budget) break;
        budget -= rendered.length;
        lines.unshift(rendered);
      }
      return [
        "Earlier turns of this conversation, for context:",
        "",
        ...lines,
        "",
        "---",
        "",
        text,
      ].join("\n");
    };

    const settleRun = (outcome: RunOutcome) => {
      if (!state.activeRun) return;
      state.activeRun = false;
      state.runSerial += 1;
      if (outcome._tag === "Completed") {
        state.history.push({ role: "assistant", text: outcome.finalText });
      }
      emit({ _tag: "RunSettled", outcome });
      const next = state.pendingPrompts.shift();
      if (next !== undefined) {
        emit({ _tag: "QueueChanged", queued: queuedView() });
        startRun(next);
      }
    };

    /** Fail the active run and kill the child; used for the SSO login trap. */
    const abortForAuth = () => {
      if (!state.activeRun) return;
      const child = state.child;
      settleRun({
        _tag: "Failed",
        errorText: AUTH_HINT,
        partialText: state.finalText || undefined,
      });
      if (child) void terminateChild(child, () => state.childExited);
    };

    const startRun = (text: string) => {
      if (state.closed) return;
      state.activeRun = true;
      state.stdout = "";
      state.stderr = "";
      state.finalText = "";
      state.interruptRequested = false;
      state.history.push({ role: "user", text });
      emit({ _tag: "RunStarted" });
      emit({ _tag: "UserMessage", text });

      const args = [
        "chat",
        "--no-interactive",
        // A subagent cannot answer per-tool approval prompts; the caller
        // already chose to launch an autonomous agent.
        "--trust-all-tools",
        // Raw output: terminal-width wrapping would corrupt code blocks.
        "--wrap",
        "never",
        ...(agent ? ["--agent", agent] : []),
        ...(model ? ["--model", model] : []),
        composePrompt(text),
      ];

      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(binary, args, {
          cwd: task.cwd,
          env: process.env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          // Own process group on POSIX so teardown reaches tools kiro-cli
          // spawned; a killed agent must not orphan a running command.
          detached: process.platform !== "win32",
        });
      } catch (error) {
        settleRun({ _tag: "Failed", errorText: boundedError(error) });
        return;
      }

      state.child = child;
      state.childExited = false;
      const serial = state.runSerial;

      // Closing stdin is what makes --no-interactive actually non-interactive:
      // any prompt kiro-cli still decides to show hits EOF and gives up
      // instead of blocking forever on a read.
      try {
        child.stdin.end();
      } catch {
        // Already closed; nothing to do.
      }

      child.stdout.setEncoding("utf8");
      let firstChunk = true;
      child.stdout.on("data", (chunk: string) => {
        if (serial !== state.runSerial) return;
        // The response marker only ever leads the very first chunk; matching
        // it before ANSI is stripped keeps genuine blockquotes in the answer
        // intact.
        const raw = firstChunk
          ? chunk.replace(RESPONSE_MARKER_PATTERN, "")
          : chunk;
        firstChunk = false;
        const clean = stripTerminalNoise(raw);
        state.stdout += clean;
        if (looksLikeLoginPrompt(state.stdout)) {
          abortForAuth();
          return;
        }
        if (clean.trim()) {
          emit({ _tag: "AssistantDelta", kind: "text", delta: clean });
        }
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        if (serial !== state.runSerial) return;
        state.stderr = `${state.stderr}${stripTerminalNoise(chunk)}`.slice(
          -MAX_STDERR_CHARS,
        );
        if (looksLikeLoginPrompt(state.stderr)) abortForAuth();
      });

      child.once("error", (error) => {
        if (serial !== state.runSerial) return;
        state.childExited = true;
        settleRun({
          _tag: "Failed",
          errorText: `kiro-cli failed to start: ${boundedError(error)}`,
        });
      });

      child.once("exit", (code, signal) => {
        state.childExited = true;
        if (serial !== state.runSerial) return;
        const finalText = state.stdout.trim();
        state.finalText = finalText;
        if (state.interruptRequested) {
          settleRun({
            _tag: "Interrupted",
            partialText: finalText || undefined,
          });
          return;
        }
        if (looksLikeLoginPrompt(`${state.stdout}\n${state.stderr}`)) {
          settleRun({
            _tag: "Failed",
            errorText: AUTH_HINT,
            partialText: finalText || undefined,
          });
          return;
        }
        if (code === 0) {
          emit({
            _tag: "AssistantMessage",
            parts: [{ type: "text", text: finalText }],
          });
          settleRun({ _tag: "Completed", finalText });
          return;
        }
        const detail = errorDetail(state.stderr) ?? errorDetail(state.stdout);
        settleRun({
          _tag: "Failed",
          errorText: `kiro-cli exited (${signal ?? `code ${code ?? "unknown"}`})${detail ? `: ${detail}` : ""}`,
          partialText: finalText || undefined,
        });
      });
    };

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        if (state.closing) return;
        state.closing = true;
        // Settle before marking closed so an in-flight run reports
        // Interrupted rather than being dropped silently.
        if (state.activeRun) {
          state.interruptRequested = true;
          settleRun({
            _tag: "Interrupted",
            partialText: state.stdout.trim() || undefined,
          });
        }
        state.closed = true;
        state.pendingPrompts = [];
        const child = state.child;
        if (child) await terminateChild(child, () => state.childExited);
        Queue.endUnsafe(events);
      }),
    );

    emit({ _tag: "MetaChanged", meta: state.meta });
    startRun(task.prompt);

    return {
      meta: Effect.sync(() => state.meta),
      events: Stream.fromQueue(events),
      send: (text) =>
        Effect.suspend((): Effect.Effect<void, SendError> => {
          if (state.closed) {
            return new SendError({ message: "Subagent session is closed." });
          }
          // steering: false — a running kiro-cli invocation cannot be
          // steered, so the text waits for the current run to settle.
          if (state.activeRun) {
            state.pendingPrompts.push(text);
            emit({ _tag: "QueueChanged", queued: queuedView() });
            return Effect.void;
          }
          return Effect.sync(() => startRun(text));
        }),
      interrupt: Effect.promise(async () => {
        if (state.closed || !state.activeRun) return;
        state.pendingPrompts = [];
        emit({ _tag: "QueueChanged", queued: [] });
        state.interruptRequested = true;
        const child = state.child;
        // No interrupt protocol exists; killing the process IS the interrupt.
        // The exit handler turns that into RunSettled(Interrupted).
        if (child) await terminateChild(child, () => state.childExited);
        else settleRun({ _tag: "Interrupted" });
      }),
    } satisfies SubagentSession;
  });

/** Signal the whole process group on POSIX so tools kiro-cli spawned die with it. */
function killTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
) {
  if (process.platform === "win32" && child.pid) {
    try {
      const killer = spawn(
        "taskkill",
        [
          "/pid",
          String(child.pid),
          "/T",
          ...(signal === "SIGKILL" ? ["/F"] : []),
        ],
        { stdio: "ignore", windowsHide: true },
      );
      const killDirect = () => {
        try {
          child.kill(signal);
        } catch {
          // Process may already be gone.
        }
      };
      killer.once("error", killDirect);
      killer.once("exit", (code) => {
        if (code !== 0) killDirect();
      });
      killer.unref();
      return;
    } catch {
      // Fall through to a direct signal when taskkill cannot be launched.
    }
  }
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Group may already be gone; fall through to the direct signal.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Process may already be gone.
  }
}

/** SIGTERM is normally enough; the second deadline covers a wedged login flow. */
function terminateChild(
  child: ChildProcessWithoutNullStreams,
  exited: () => boolean,
) {
  if (exited()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let lastTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      if (forceTimer) clearTimeout(forceTimer);
      if (lastTimer) clearTimeout(lastTimer);
      resolve();
    };
    child.once("exit", finish);
    killTree(child, "SIGTERM");
    forceTimer = setTimeout(() => {
      if (!exited()) killTree(child, "SIGKILL");
    }, FORCE_KILL_AFTER_MS);
    lastTimer = setTimeout(finish, FORCE_KILL_AFTER_MS + 500);
  });
}

export const kiroBackend: SubagentBackend = {
  name: "kiro",
  capabilities: {
    // One invocation = one turn; nothing can be steered mid-run.
    steering: false,
    modelSelection: true,
    // kiro-cli exposes no reasoning-effort control.
    reasoningEffort: false,
  },
  available: Effect.sync(
    () => resolveKiroBinary() !== undefined && kiroLoginPresent(),
  ),
  spawn: makeKiroSession,
};
