export interface RuntimeNotification {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
}

export interface StoredPresentation {
  notificationId: number;
  notification: RuntimeNotification;
  text: string;
}

export interface PendingQuestion {
  id: string;
  prompt: string;
  canContinue: boolean;
}

export interface PresentationState {
  presentations: Map<number, StoredPresentation>;
  acknowledged: Set<number>;
  cursor: number;
  pendingQuestions: Map<string, PendingQuestion>;
}

export function newPresentationState(): PresentationState {
  return {
    presentations: new Map(),
    acknowledged: new Set(),
    cursor: 0,
    pendingQuestions: new Map(),
  };
}

export function notificationText(notification: RuntimeNotification): string {
  const question = notification.payload.questionId;
  if (notification.kind === "reports.question") {
    return `Orchestrator question${question ? ` (${question})` : ""}: ${String(notification.payload.prompt ?? "Worker needs input.")}`;
  }
  if (notification.kind === "reports.result") {
    return `Orchestrator result: ${String(notification.payload.summary ?? notification.payload.result ?? "Worker reported a result.")}`;
  }
  if (notification.kind === "taskTransition") {
    const state = (
      notification.payload.outcome as Record<string, unknown> | undefined
    )?.state;
    return `Orchestrator task outcome: ${String(state ?? "state changed")}.`;
  }
  return `Orchestrator notification (${notification.kind}): ${JSON.stringify(notification.payload)}`;
}

export function pendingQuestion(
  notification: RuntimeNotification,
): PendingQuestion | null {
  if (notification.kind !== "reports.question") return null;
  const id = notification.payload.questionId;
  const prompt = notification.payload.prompt;
  if (typeof id !== "string" || typeof prompt !== "string") return null;
  return { id, prompt, canContinue: notification.payload.canContinue === true };
}
