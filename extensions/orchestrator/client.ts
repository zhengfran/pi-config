import { request } from "node:http";

export const ORCHESTRATOR_PROTOCOL = "v1";

export type RuntimeResponse = { status: number; body: Record<string, unknown> };

export class OrchestratorTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrchestratorTransportError";
  }
}

/** A dependency-free client for the runtime's private v1 Unix-socket API. */
export class OrchestratorClient {
  readonly options: {
    socketPath: string;
    clientId: string;
    token?: string;
    timeoutMs?: number;
  };

  constructor(options: {
    socketPath: string;
    clientId: string;
    token?: string;
    timeoutMs?: number;
  }) {
    if (!options.socketPath || !options.clientId) {
      throw new Error("Orchestrator client requires socketPath and clientId.");
    }
    this.options = options;
  }

  #request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<RuntimeResponse> {
    const payload =
      body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      let settled = false;
      const req = request(
        {
          socketPath: this.options.socketPath,
          method,
          path,
          agent: false,
          headers: {
            "x-zzc-client": this.options.clientId,
            connection: "close",
            ...(this.options.token
              ? { "x-zzc-token": this.options.token }
              : {}),
            ...(payload
              ? {
                  "content-type": "application/json",
                  "content-length": payload.length,
                }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            const text = Buffer.concat(chunks).toString("utf8");
            try {
              resolve({
                status: res.statusCode ?? 0,
                body: text ? JSON.parse(text) : {},
              });
            } catch {
              reject(
                new OrchestratorTransportError(
                  "Runtime returned malformed JSON.",
                ),
              );
            }
          });
          res.on("error", (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            reject(error);
          });
        },
      );
      const deadline = setTimeout(() => {
        if (settled) return;
        settled = true;
        req.destroy();
        reject(
          new OrchestratorTransportError(
            `${method} ${path} timed out; acceptance is unknown.`,
          ),
        );
      }, timeoutMs);
      req.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        reject(error);
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  submit(intent: string, requestId: string, payload: Record<string, unknown>) {
    return this.#request("POST", "/v1/intents", { intent, requestId, payload });
  }

  status() {
    return this.#request("GET", "/v1/status");
  }

  snapshot() {
    return this.#request("GET", "/v1/snapshot");
  }

  notifications() {
    return this.#request("GET", "/v1/notifications");
  }

  events(cursor: number) {
    return this.#request("GET", `/v1/events?cursor=${cursor}`);
  }

  acknowledge(id: number) {
    return this.#request("POST", `/v1/notifications/${id}/ack`);
  }
}
