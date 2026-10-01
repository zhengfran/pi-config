import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RelayStore } from "./store.ts";
import { ensurePrivateDirectory } from "./ownership.ts";

/** Bootstrap/health transport only. No mutating endpoints are exposed until
 * per-instance isolation and authorization are proven against same-UID code. */
export async function startRelay(
  stateDirectory: string,
  runtimeDirectory: string,
): Promise<{ socket: string; close(): Promise<void> }> {
  if (resolve(stateDirectory) === resolve(runtimeDirectory)) {
    throw new Error(
      "Relay socket and durable state need separate private directories",
    );
  }
  ensurePrivateDirectory(runtimeDirectory);
  const socket = join(runtimeDirectory, "relay.sock");
  // macOS sockaddr_un paths can be limited to 104 bytes (including NUL).
  if (Buffer.byteLength(socket) >= 104)
    throw new Error("Relay socket path is too long");
  const store = new RelayStore(stateDirectory);
  let server: Server | undefined;
  try {
    if (existsSync(socket)) {
      if (!lstatSync(socket).isSocket())
        throw new Error("Refusing to unlink a non-socket path");
      // Only the holder of the lifetime lock can remove a stale socket. The
      // old server cannot still be the owner after its SQLite lock is gone.
      unlinkSync(socket);
    }
    server = createServer((peer) => {
      // A client can disconnect between end() and the write. Never let an
      // untrusted socket's EPIPE/ECONNRESET terminate the relay owner.
      peer.on("error", () => peer.destroy());
      peer.setTimeout(5000, () => peer.destroy()).unref();
      let size = 0;
      peer.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 4096) peer.destroy();
      });
      // Deliberately no calls into the registry from an unauthenticated peer.
      peer.on("end", () =>
        peer.end('{"version":1,"status":"bootstrap_only"}\n'),
      );
    });
    const active = server;
    await new Promise<void>((resolve, reject) => {
      active.once("error", reject);
      active.listen(socket, () => {
        active.off("error", reject);
        resolve();
      });
    });
    chmodSync(socket, 0o600);
    let closed = false;
    return {
      socket,
      async close() {
        if (closed) return;
        closed = true;
        try {
          await new Promise<void>((resolve, reject) =>
            active.close((err) => (err ? reject(err) : resolve())),
          );
        } finally {
          if (existsSync(socket) && lstatSync(socket).isSocket())
            unlinkSync(socket);
          store.close();
        }
      },
    };
  } catch (error) {
    server?.close();
    store.close();
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const stateDirectory = process.argv[2];
  const runtimeDirectory = process.argv[3];
  if (!stateDirectory || !runtimeDirectory) {
    console.error(
      "Usage: node --experimental-strip-types server.ts PRIVATE_STATE_DIRECTORY PRIVATE_RUNTIME_DIRECTORY",
    );
    process.exitCode = 2;
  } else {
    startRelay(stateDirectory, runtimeDirectory)
      .then((relay) => {
        console.log(`relay bootstrap listening: ${relay.socket}`);
        process.once(
          "SIGTERM",
          () => void relay.close().then(() => process.exit(0)),
        );
        process.once(
          "SIGINT",
          () => void relay.close().then(() => process.exit(0)),
        );
      })
      .catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
  }
}
