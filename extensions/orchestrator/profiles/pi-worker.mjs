#!/usr/bin/env node
// Launch a concrete-work Pi worker with no inherited orchestration credential
// and no auto-discovered extensions. The runtime also supplies --no-extensions
// for Herdr-managed pi launches; this wrapper is the usable profile boundary
// for direct/local worker starts where the shell would otherwise inherit them.
import { spawn } from "node:child_process";

const environment = { ...process.env };
for (const name of [
  "ZZC_ORCHESTRATOR_PROFILE",
  "ZZC_ORCHESTRATOR_SOCKET",
  "ZZC_ORCHESTRATOR_CLIENT_ID",
  "ZZC_ORCHESTRATOR_TOKEN",
]) {
  delete environment[name];
}

const executable = environment.PI_WORKER_BINARY || "pi";
const child = spawn(executable, ["--no-extensions", ...process.argv.slice(2)], {
  env: environment,
  stdio: "inherit",
});
child.on("error", (error) => {
  process.stderr.write(`pi-worker: ${error.message}\n`);
  process.exitCode = 127;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
