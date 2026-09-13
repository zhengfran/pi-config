export interface RuntimeNotification {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
}

export interface PresentationState {
  presented: Set<number>;
  cursor: number;
  pendingQuestionIds: Set<string>;
}

export function newPresentationState(): PresentationState {
  return { presented: new Set(), cursor: 0, pendingQuestionIds: new Set() };
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
