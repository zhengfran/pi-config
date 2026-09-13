import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { OrchestratorClient, ORCHESTRATOR_PROTOCOL } from "./client.ts";
import {
  newPresentationState,
  notificationText,
  pendingQuestion,
  type PresentationState,
  type RuntimeNotification,
} from "./presentation.ts";

const PROFILE_ENV = "ZZC_ORCHESTRATOR_PROFILE";
const INTENTS = [
  "taskCreate",
  "taskRevise",
  "taskTransition",
  "taskCancel",
  "taskConstrain",
  "authorizationRecord",
  "runPlan",
  "runDispatch",
  "answerSubmit",
  "runControl",
  "reconcile",
  "executionResult",
  "verificationRecord",
  "blockResolve",
  "artifactRecord",
  "agentRegister",
] as const;
const IntentParameters = Type.Object({
  intent: Type.Union(INTENTS.map((value) => Type.Literal(value))),
  payload: Type.Record(Type.String(), Type.Unknown()),
  requestId: Type.Optional(Type.String()),
});
type IntentParameters = Static<typeof IntentParameters>;

function loadPersistedState(ctx: ExtensionContext): PresentationState {
  const state = newPresentationState();
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom") continue;
    const data = entry.data as Record<string, unknown> | undefined;
    if (
      entry.customType === "orchestrator-presentation" &&
      typeof data?.notificationId === "number" &&
      typeof data.text === "string" &&
      data.notification &&
      typeof data.notification === "object"
    ) {
      const notification = data.notification as RuntimeNotification;
      state.presentations.set(data.notificationId, {
        notificationId: data.notificationId,
        notification,
        text: data.text,
      });
      const question = pendingQuestion(notification);
      if (question) state.pendingQuestions.set(question.id, question);
    }
    if (
      entry.customType === "orchestrator-ack" &&
      typeof data?.notificationId === "number"
    ) {
      state.acknowledged.add(data.notificationId);
    }
    if (typeof data?.cursor === "number")
      state.cursor = Math.max(state.cursor, data.cursor);
    if (entry.customType === "orchestrator-projection") {
      const questions = data?.pendingQuestions;
      if (Array.isArray(questions)) {
        state.pendingQuestions.clear();
        for (const question of questions) {
          if (
            question &&
            typeof question === "object" &&
            typeof question.id === "string" &&
            typeof question.prompt === "string"
          ) {
            state.pendingQuestions.set(question.id, {
              id: question.id,
              prompt: question.prompt,
              canContinue: question.canContinue === true,
            });
          }
        }
      }
    }
    if (
      entry.customType === "orchestrator-input-resolved" &&
      typeof data?.questionId === "string"
    ) {
      state.pendingQuestions.delete(data.questionId);
    }
  }
  return state;
}

function profile(): "global" | "project" | null {
  const value = process.env[PROFILE_ENV];
  return value === "global" || value === "project" ? value : null;
}

function configuredClient(): OrchestratorClient {
  const socketPath = process.env.ZZC_ORCHESTRATOR_SOCKET;
  const clientId = process.env.ZZC_ORCHESTRATOR_CLIENT_ID;
  if (!socketPath || !clientId) {
    throw new Error(
      "Orchestrator profile is missing ZZC_ORCHESTRATOR_SOCKET or ZZC_ORCHESTRATOR_CLIENT_ID; no daemon connection was attempted.",
    );
  }
  return new OrchestratorClient({
    socketPath,
    clientId,
    token: process.env.ZZC_ORCHESTRATOR_TOKEN,
  });
}

async function syncPresentation(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  client: OrchestratorClient,
  state: PresentationState,
) {
  const status = await client.status();
  if (status.status !== 200)
    throw new Error(
      `Daemon status unavailable: ${String(status.body.message ?? status.body.error ?? status.status)}`,
    );
  const self = status.body.self as Record<string, unknown> | undefined;
  if (self?.role !== profile())
    throw new Error(
      `Configured profile ${profile()} does not match daemon role ${String(self?.role)}.`,
    );
  const notices = await client.notifications();
  if (notices.status !== 200)
    throw new Error(
      `Notifications unavailable: ${String(notices.body.message ?? notices.body.error ?? notices.status)}`,
    );
  const presented: string[] = [];
  for (const notification of (notices.body.notifications ??
    []) as RuntimeNotification[]) {
    let item = state.presentations.get(notification.id);
    if (!item) {
      // A custom entry is synchronously appended to Pi's session JSONL and
      // rendered below. Unlike sendMessage(followUp), it survives a process
      // exit while the agent is streaming, so it is the presentation record.
      item = {
        notificationId: notification.id,
        notification,
        text: notificationText(notification),
      };
      pi.appendEntry("orchestrator-presentation", {
        ...item,
        protocol: ORCHESTRATOR_PROTOCOL,
      });
      state.presentations.set(notification.id, item);
      const question = pendingQuestion(notification);
      if (question) state.pendingQuestions.set(question.id, question);
      presented.push(item.text);
    }
    // A durable presentation without an ack is intentionally retried on
    // every recovery. The runtime acknowledgement is idempotent.
    const ack = await client.acknowledge(notification.id);
    if (ack.status !== 200)
      throw new Error(
        `Notification ${notification.id} presentation was retained locally but acknowledgement failed.`,
      );
    if (!state.acknowledged.has(notification.id)) {
      pi.appendEntry("orchestrator-ack", {
        notificationId: notification.id,
        cursor: state.cursor,
        protocol: ORCHESTRATOR_PROTOCOL,
      });
      state.acknowledged.add(notification.id);
    }
  }
  const events = await client.events(state.cursor);
  if (events.status === 409) {
    let after: Record<string, unknown> | undefined;
    let baseCursor: number | undefined;
    let snapshot: Record<string, unknown> | undefined;
    const questions: Array<{
      id: string;
      prompt: string;
      canContinue: boolean;
    }> = [];
    do {
      const page = await client.snapshot({ after, baseCursor, limit: 200 });
      if (page.status !== 200)
        throw new Error(
          "Daemon requested resnapshot but snapshot is unavailable.",
        );
      snapshot = page.body;
      if (baseCursor === undefined) baseCursor = Number(page.body.cursor);
      for (const question of (page.body.questions ?? []) as Array<
        Record<string, unknown>
      >) {
        if (question.state !== "pending" || typeof question.id !== "string")
          continue;
        const payload = question.prompt as Record<string, unknown> | undefined;
        const prompt =
          typeof payload?.prompt === "string"
            ? payload.prompt
            : "Worker needs input.";
        questions.push({
          id: question.id,
          prompt,
          canContinue: question.canContinue === true,
        });
      }
      after = page.body.next as Record<string, unknown> | undefined;
    } while (after && Object.values(after).some((value) => value !== null));
    state.cursor = Number(snapshot?.cursor ?? state.cursor);
    state.pendingQuestions.clear();
    for (const question of questions)
      state.pendingQuestions.set(question.id, question);
    pi.appendEntry("orchestrator-projection", {
      cursor: state.cursor,
      pendingQuestions: [...state.pendingQuestions.values()],
      protocol: ORCHESTRATOR_PROTOCOL,
    });
  } else if (events.status === 200) {
    const cursor = Number(
      events.body.cursor ?? events.body.nextCursor ?? state.cursor,
    );
    if (cursor > state.cursor) {
      state.cursor = cursor;
      pi.appendEntry("orchestrator-cursor", {
        cursor,
        pendingQuestions: [...state.pendingQuestions.values()],
        protocol: ORCHESTRATOR_PROTOCOL,
      });
    }
  }
  return { presented, cursor: state.cursor, status: status.body };
}

export default function orchestrator(pi: ExtensionAPI) {
  if (!profile()) return; // Ordinary pi and workers never receive delegation tools or credentials.
  let state: PresentationState | undefined;
  let ctx: ExtensionContext | undefined;
  const getState = () => (state ??= loadPersistedState(ctx!));
  const sync = async () =>
    syncPresentation(pi, ctx!, configuredClient(), getState());

  pi.registerEntryRenderer<{
    notificationId?: number;
    text?: string;
  }>(
    "orchestrator-presentation",
    (entry, _options, theme) =>
      new Text(
        theme.fg(
          "accent",
          `orchestrator · ${entry.data?.text ?? "notification"}`,
        ),
        0,
        0,
      ),
  );

  pi.on("session_start", async (_event, session) => {
    ctx = session;
    state = loadPersistedState(session);
    try {
      await sync();
    } catch (error) {
      session.ui.notify(
        error instanceof Error ? error.message : String(error),
        "warning",
      );
    }
  });

  pi.registerTool({
    name: "orchestrator_intent",
    label: "Orchestrator Intent",
    description:
      "Submit a typed orchestration intent to the local daemon. The daemon owns authorization, scope, delegation depth, task state, and model eligibility; never invent a successful result from this tool.",
    promptSnippet:
      "orchestrator_intent — submit a validated task, assessment, answer, control, or reconciliation intent",
    parameters: IntentParameters,
    async execute(_id, params: IntentParameters) {
      const response = await configuredClient().submit(
        params.intent,
        params.requestId ?? randomUUID(),
        params.payload,
      );
      const text = JSON.stringify({
        protocol: ORCHESTRATOR_PROTOCOL,
        httpStatus: response.status,
        outcome: response.body,
      });
      if (
        params.intent === "answerSubmit" &&
        response.status === 200 &&
        typeof params.payload.questionId === "string"
      ) {
        pi.appendEntry("orchestrator-input-resolved", {
          questionId: params.payload.questionId,
          protocol: ORCHESTRATOR_PROTOCOL,
        });
        state?.pendingQuestions.delete(params.payload.questionId);
      }
      return {
        content: [{ type: "text" as const, text }],
        details: { response },
      };
    },
  });
  pi.registerTool({
    name: "orchestrator_sync",
    label: "Sync Orchestrator",
    description:
      "Recover and present durable daemon questions, results, blocked reasons, and lifecycle outcomes. Presentation is recorded before acknowledgement, so reconnect/restart does not duplicate it.",
    parameters: Type.Object({}),
    async execute() {
      const result = await sync();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result,
      };
    },
  });
  pi.registerCommand("orchestrator", {
    description:
      "Synchronize durable orchestration notifications from the configured daemon",
    handler: async (_args, commandCtx) => {
      ctx = commandCtx;
      state ??= loadPersistedState(commandCtx);
      const result = await sync();
      commandCtx.ui.notify(
        result.presented.length
          ? `Presented ${result.presented.length} orchestrator notification(s).`
          : "Orchestrator is synchronized.",
        "info",
      );
    },
  });
}
