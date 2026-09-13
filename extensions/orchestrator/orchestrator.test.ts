import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import orchestrator from "./index.ts";
import { OrchestratorClient } from "./client.ts";
// @ts-expect-error The separately versioned runtime intentionally publishes JS, not TS declarations.
import { Daemon } from "../../../orchestrator/src/daemon.js";

type RegisteredTool = { execute: (...args: any[]) => Promise<any> };

function fakePi(entries: any[] = []) {
  const tools = new Map<string, RegisteredTool>();
  const events = new Map<string, (event: unknown, ctx: any) => Promise<void>>();
  const messages: any[] = [];
  const api: any = {
    on(name: string, handler: any) {
      events.set(name, handler);
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    sendMessage(message: unknown) {
      messages.push(message);
    },
  };
  const ctx: any = {
    sessionManager: { getEntries: () => entries },
    ui: { notify() {} },
  };
  return {
    api,
    ctx,
    entries,
    messages,
    tools,
    async start() {
      await events.get("session_start")?.({}, ctx);
    },
  };
}

test("global extension presents a question before acknowledgement and does not register for worker/default pi", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-orchestrator-smoke-"));
  const clients = {
    "global-pi": { role: "global", project: null, token: "g".repeat(20) },
    "worker-pi": { role: "worker", project: "alpha", token: "w".repeat(20) },
  };
  const daemon = new Daemon({
    stateDir: dir,
    clients,
    catalog: [
      {
        id: "model",
        backend: "pi",
        tier: "medium",
        available: true,
        capabilities: ["code"],
      },
    ],
    capabilityGate: () => ({
      supported: false,
      reason: "live backend evidence is missing",
      capabilities: {},
    }),
  });
  const original = { ...process.env };
  try {
    const started = await daemon.start();
    const runtime = new OrchestratorClient({
      socketPath: started.socketPath,
      clientId: "global-pi",
      token: clients["global-pi"].token,
    });
    const created = await runtime.submit("taskCreate", randomUUID(), {
      goal: "answer me",
      acceptance: ["answered"],
    });
    assert.equal(created.status, 200);
    const planned = await runtime.submit("runPlan", randomUUID(), {
      taskId: created.body.taskId,
      purpose: "execution",
      assessment: {
        type: "coding",
        complexity: "routine",
        risk: "normal",
        reason: "smoke",
      },
    });
    daemon.store.startExecution(
      String(planned.body.id),
      { name: "worker", paneId: "p1", kind: "pi", serverKey: "local" },
      "work",
    );
    const questionId = randomUUID();
    daemon.reportInbox.publish({
      runId: planned.body.id,
      reportId: questionId,
      taskId: created.body.taskId,
      revision: daemon.store.getRun(planned.body.id).revision,
      kind: "question",
      payload: { prompt: "Which result should I use?" },
    });
    daemon.reportInbox.scan();

    process.env.ZZC_ORCHESTRATOR_PROFILE = "global";
    process.env.ZZC_ORCHESTRATOR_SOCKET = started.socketPath;
    process.env.ZZC_ORCHESTRATOR_CLIENT_ID = "global-pi";
    process.env.ZZC_ORCHESTRATOR_TOKEN = clients["global-pi"].token;
    const pi = fakePi();
    orchestrator(pi.api);
    assert.ok(pi.tools.has("orchestrator_intent"));
    await pi.start();
    assert.equal(
      pi.entries.length,
      1,
      "local presentation is written before daemon acknowledgement",
    );
    assert.match(pi.messages[0].content, /Which result should I use/);
    assert.equal(
      ((await runtime.notifications()).body.notifications as unknown[]).length,
      0,
      "acknowledged only after presentation",
    );

    // Reopen pi and restart the real daemon on the same durable namespace.
    await daemon.stop();
    const restarted = await daemon.start();
    process.env.ZZC_ORCHESTRATOR_SOCKET = restarted.socketPath;
    daemon.reportInbox.publish({
      runId: planned.body.id,
      reportId: randomUUID(),
      taskId: created.body.taskId,
      revision: daemon.store.getRun(planned.body.id).revision,
      kind: "result",
      payload: { summary: "The selected result is ready." },
    });
    daemon.reportInbox.scan();
    const reopened = fakePi(pi.entries);
    orchestrator(reopened.api);
    await reopened.start();
    assert.equal(
      reopened.messages.length,
      1,
      "new result is presented after reconnect/restart",
    );
    assert.match(reopened.messages[0].content, /selected result is ready/);
    assert.doesNotMatch(
      reopened.messages[0].content,
      /Which result should I use/,
    );

    const worker = new OrchestratorClient({
      socketPath: restarted.socketPath,
      clientId: "worker-pi",
      token: clients["worker-pi"].token,
    });
    assert.equal(
      (
        await worker.submit("taskCreate", randomUUID(), {
          goal: "forbidden",
          acceptance: ["no"],
        })
      ).status,
      403,
    );

    delete process.env.ZZC_ORCHESTRATOR_PROFILE;
    const ordinary = fakePi();
    orchestrator(ordinary.api);
    assert.equal(
      ordinary.tools.size,
      0,
      "worker/default profile has no orchestration or delegation tools",
    );
  } finally {
    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
    for (const key of Object.keys(process.env))
      if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  }
});
