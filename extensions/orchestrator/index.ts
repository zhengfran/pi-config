import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { OrchestratorClient, ORCHESTRATOR_PROTOCOL } from "./client.ts";
import {
  newPresentationState,
  notificationText,
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
    if (
      entry.type !== "custom" ||
      entry.customType !== "orchestrator-presentation"
    )
      continue;
    const data = entry.data as
      | Partial<{ notificationId: number; cursor: number; questionId: string }>
      | undefined;
    if (typeof data?.notificationId === "number")
      state.presented.add(data.notificationId);
    if (typeof data?.cursor === "number")
      state.cursor = Math.max(state.cursor, data.cursor);
    if (typeof data?.questionId === "string")
      state.pendingQuestionIds.add(data.questionId);
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
    if (state.presented.has(notification.id)) continue;
    const questionId =
      typeof notification.payload.questionId === "string"
        ? notification.payload.questionId
        : undefined;
    // Append first: this gives the local session a durable identity before the
    // daemon acknowledgement can suppress replay after a crash/reopen.
    pi.appendEntry("orchestrator-presentation", {
      notificationId: notification.id,
      questionId,
      cursor: state.cursor,
      protocol: ORCHESTRATOR_PROTOCOL,
    });
    state.presented.add(notification.id);
    if (questionId) state.pendingQuestionIds.add(questionId);
    pi.sendMessage(
      {
        customType: "orchestrator-notification",
        content: notificationText(notification),
        display: true,
        details: { notificationId: notification.id, kind: notification.kind },
      },
      { deliverAs: "followUp", triggerTurn: false },
    );
    const ack = await client.acknowledge(notification.id);
    if (ack.status !== 200)
      throw new Error(
        `Notification ${notification.id} presentation was retained locally but acknowledgement failed.`,
      );
    presented.push(notificationText(notification));
  }
  const events = await client.events(state.cursor);
  if (events.status === 409) {
    const snapshot = await client.snapshot();
    if (snapshot.status !== 200)
      throw new Error(
        "Daemon requested resnapshot but snapshot is unavailable.",
      );
    state.cursor = Number(snapshot.body.cursor ?? state.cursor);
  } else if (events.status === 200) {
    state.cursor = Number(
      events.body.cursor ?? events.body.nextCursor ?? state.cursor,
    );
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
