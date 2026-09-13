import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import orchestrator from "./index.ts";
import { OrchestratorClient } from "./client.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
// @ts-expect-error The separately versioned runtime intentionally publishes JS, not TS declarations.
import { Daemon } from "../../../orchestrator/src/daemon.js";

type RegisteredTool = { execute: (...args: any[]) => Promise<any> };

function fakePi(entries: any[] = []) {
  const tools = new Map<string, RegisteredTool>();
  const events = new Map<string, (event: unknown, ctx: any) => Promise<void>>();
  const messages: any[] = [];
  const renderers = new Map<string, unknown>();
  const api: any = {
    on(name: string, handler: any) {
      events.set(name, handler);
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerEntryRenderer(type: string, renderer: unknown) {
      renderers.set(type, renderer);
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
    renderers,
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
    assert.match(
      JSON.stringify(pi.entries),
      /Which result should I use/,
      "the durable presentation contains the question before acknowledgement",
    );
    assert.ok(pi.renderers.has("orchestrator-presentation"));
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
    assert.match(JSON.stringify(reopened.entries), /selected result is ready/);

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

test("a session-file presentation survives exit before acknowledgement and retries without a duplicate entry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-orchestrator-persistence-"));
  const clients = {
    "global-pi": { role: "global", project: null, token: "g".repeat(20) },
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
  });
  const original = { ...process.env };
  try {
    const started = await daemon.start();
    const runtime = new OrchestratorClient({
      socketPath: started.socketPath,
      clientId: "global-pi",
      token: clients["global-pi"].token,
    });
    const task = await runtime.submit("taskCreate", randomUUID(), {
      goal: "recover",
      acceptance: ["done"],
    });
    daemon.server.runtime.notifyEvent("reports.question", task.body.taskId, {
      questionId: "recover-question",
      prompt: "Persist me",
      canContinue: false,
    });
    process.env.ZZC_ORCHESTRATOR_PROFILE = "global";
    process.env.ZZC_ORCHESTRATOR_SOCKET = started.socketPath;
    process.env.ZZC_ORCHESTRATOR_CLIENT_ID = "global-pi";
    process.env.ZZC_ORCHESTRATOR_TOKEN = clients["global-pi"].token;

    const session = SessionManager.create("/workspace", join(dir, "sessions"));
    const crashed = fakePi();
    crashed.ctx.sessionManager = session;
    crashed.api.appendEntry = (type: string, data: unknown) => {
      session.appendCustomEntry(type, data);
      if (type === "orchestrator-presentation")
        throw new Error("simulated exit after durable presentation");
    };
    crashed.api.sendMessage = () => {
      throw new Error(
        "streaming follow-up must not be required for presentation",
      );
    };
    orchestrator(crashed.api);
    await crashed.start();
    assert.equal(
      ((await runtime.notifications()).body.notifications as unknown[]).length,
      1,
    );
    const path = session.getSessionFile();
    assert.ok(path);

    const reopenedSession = SessionManager.open(path!);
    const reopened = fakePi();
    reopened.ctx.sessionManager = reopenedSession;
    reopened.api.appendEntry = (type: string, data: unknown) =>
      reopenedSession.appendCustomEntry(type, data);
    orchestrator(reopened.api);
    await reopened.start();
    assert.equal(
      ((await runtime.notifications()).body.notifications as unknown[]).length,
      0,
      "recovery retries the pending acknowledgement",
    );
    const entries = reopenedSession
      .getEntries()
      .filter((entry) => entry.type === "custom");
    assert.equal(
      entries.filter(
        (entry: any) => entry.customType === "orchestrator-presentation",
      ).length,
      1,
      "stable notification identity prevents a second presentation entry",
    );
    assert.match(JSON.stringify(entries), /Persist me/);
  } finally {
    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
    for (const key of Object.keys(process.env))
      if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  }
});

test("recovery persists an event cursor and rebuilds pending input from a stale-cursor snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-orchestrator-cursor-"));
  const clients = {
    "global-pi": { role: "global", project: null, token: "g".repeat(20) },
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
  });
  const original = { ...process.env };
  try {
    const started = await daemon.start();
    const runtime = new OrchestratorClient({
      socketPath: started.socketPath,
      clientId: "global-pi",
      token: clients["global-pi"].token,
    });
    const task = await runtime.submit("taskCreate", randomUUID(), {
      goal: "cursor",
      acceptance: ["done"],
    });
    process.env.ZZC_ORCHESTRATOR_PROFILE = "global";
    process.env.ZZC_ORCHESTRATOR_SOCKET = started.socketPath;
    process.env.ZZC_ORCHESTRATOR_CLIENT_ID = "global-pi";
    process.env.ZZC_ORCHESTRATOR_TOKEN = clients["global-pi"].token;

    const first = fakePi();
    orchestrator(first.api);
    await first.start();
    const cursor = Math.max(
      ...first.entries.map((entry: any) => entry.data?.cursor ?? 0),
    );
    assert.ok(
      cursor > 0,
      "event consumption writes the advanced cursor into the durable projection",
    );

    daemon.server.runtime.compactEventsBefore(cursor);
    const planned = await runtime.submit("runPlan", randomUUID(), {
      taskId: task.body.taskId,
      purpose: "execution",
      assessment: {
        type: "coding",
        complexity: "routine",
        risk: "normal",
        reason: "snapshot test",
      },
    });
    daemon.store.startExecution(
      String(planned.body.id),
      { name: "worker", paneId: "p1", kind: "pi", serverKey: "local" },
      "work",
    );
    daemon.reportInbox.publish({
      runId: planned.body.id,
      reportId: "snapshot-question",
      taskId: task.body.taskId,
      revision: daemon.store.getRun(planned.body.id).revision,
      kind: "question",
      payload: { prompt: "Recover this input", canContinue: false },
    });
    daemon.reportInbox.scan();
    const stale = fakePi();
    orchestrator(stale.api);
    await stale.start();
    const projection = stale.entries.find(
      (entry: any) => entry.customType === "orchestrator-projection",
    );
    assert.equal(projection.data.cursor >= cursor, true);
    assert.deepEqual(projection.data.pendingQuestions, [
      {
        id: "snapshot-question",
        prompt: "Recover this input",
        canContinue: false,
      },
    ]);
  } finally {
    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
    for (const key of Object.keys(process.env))
      if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  }
});
