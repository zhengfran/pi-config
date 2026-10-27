import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import * as acp from "@agentclientprotocol/sdk";

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () =>
    controller.abort(new Error(`Cancelled by ${signal}`)),
  );
}

let child;
let connection;
let sessionId;
let stderr = "";
let output = "";
let supportsClose = false;
let closed;

const cancelled = new Promise((_, reject) => {
  controller.signal.addEventListener(
    "abort",
    () => reject(controller.signal.reason),
    { once: true },
  );
});
cancelled.catch(() => {});
const request = (method, params) =>
  Promise.race([connection.agent.request(method, params), cancelled]);

try {
  const agentDir =
    process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const configPath = join(agentDir, "dsh-acp.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (
    typeof config.command !== "string" ||
    !config.command.trim() ||
    !Array.isArray(config.args) ||
    config.args.some((arg) => typeof arg !== "string")
  ) {
    throw new Error(`${configPath} requires command and a string-array args`);
  }
  let prompt = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) prompt += chunk;
  if (!prompt.trim()) throw new Error("Task on stdin must not be empty");

  child = spawn(config.command, config.args, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.on("error", (error) => controller.abort(error));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text) => {
    stderr = (stderr + text).slice(-8192);
  });
  closed = new Promise((resolve) => child.once("close", resolve));
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout),
  );
  connection = acp
    .client({ name: "pi-dsh-acp" })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      const update = params.update;
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content.type === "text"
      ) {
        output += update.content.text;
      }
    })
    .onRequest(acp.methods.client.session.requestPermission, () => {
      process.stderr.write(
        "dsh-acp: denied a permission request; interactive approval is unavailable\n",
      );
      return { outcome: { outcome: "cancelled" } };
    })
    .connect(stream);

  const startup = setTimeout(
    () => controller.abort(new Error("ACP startup timed out")),
    30000,
  );
  try {
    const initialized = await request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "pi-dsh-acp", version: "1" },
    });
    if (initialized.protocolVersion !== acp.PROTOCOL_VERSION)
      throw new Error("ACP version mismatch");
    supportsClose =
      initialized.agentCapabilities?.sessionCapabilities?.close != null;
    const session = await request(acp.methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers: [],
    });
    sessionId = session.sessionId;
  } finally {
    clearTimeout(startup);
  }

  const result = await request(acp.methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text: prompt }],
  });
  if (result.stopReason !== "end_turn")
    throw new Error(`DSH stopped with ${result.stopReason}`);
  if (!output.trim()) throw new Error("DSH returned no assistant text");
  process.stdout.write(output.trim() + "\n");
} catch (error) {
  process.stderr.write(
    `dsh-acp: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  if (stderr.trim()) process.stderr.write(stderr.trim() + "\n");
  process.exitCode = 1;
} finally {
  if (connection && sessionId) {
    if (controller.signal.aborted) {
      await connection.agent
        .notify(acp.methods.agent.session.cancel, { sessionId })
        .catch(() => {});
    }
    if (supportsClose) {
      await Promise.race([
        connection.agent
          .request(acp.methods.agent.session.close, { sessionId })
          .catch(() => {}),
        delay(1000, undefined, { ref: false }),
      ]);
    }
  }
  connection?.close();
  child?.stdin.end();
  if (child && child.exitCode === null && child.signalCode === null) {
    await Promise.race([closed, delay(3000, undefined, { ref: false })]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([closed, delay(1000, undefined, { ref: false })]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await closed;
      }
    }
  }
}
