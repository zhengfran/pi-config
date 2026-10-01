/**
 * bridge-endpoint.ts — per-instance authenticated relay bridge.
 *
 * Each confined child is handed exactly one Unix socket, bind mounted into its
 * mount namespace at {@link SANDBOX_BRIDGE_SOCKET}. The relay owns the other
 * end and records, on the trusted host side, which socket belongs to which
 * `{groupId, instanceId, fence}`. The sender identity comes from the socket
 * the connection reached, never a `sender`/`from` field in the request body.
 * A child confined in the tested namespace cannot reach its sibling's mounted
 * socket. An UNCONFINED same-UID host process can connect to either host path,
 * so only a trusted launcher that enforces confinement for every child can
 * make this a production trust boundary.
 *
 * This prototype rejects an unavailable {@link SandboxCapability}, but that
 * caller-supplied value is NOT an attestation of a particular child's launch.
 * Do not wire this bridge into live tools without a trusted executor.
 *
 * Scope: this is the authorized write path a confined bridge uses to reach the
 * durable {@link RelayStore}. It performs NO native harness I/O and is not
 * wired into the live Pi extension; it is exercised by the offline unit tests
 * and by the real-child security harness (`scripts/linux-child-bridge-security-check.sh`).
 */

import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDirectory } from "./ownership.ts";
import type { SandboxCapability } from "./linux-sandbox.ts";
import {
  RelayStore,
  RelayStoreError,
  type CallerIdentity,
  type EnvelopeKind,
  type RecipientRef,
} from "./store.ts";

/** Identity bound to a minted socket; supplied by the trusted launch path only. */
export interface BridgeIdentity {
  readonly groupId: string;
  readonly instanceId: string;
  readonly fence: number;
}

/** Largest single request accepted from a child bridge before the peer is dropped. */
const MAX_REQUEST_BYTES = 128 * 1024;
const PEER_IDLE_MS = 30_000;

interface BoundEndpoint {
  readonly identity: BridgeIdentity;
  readonly socketPath: string;
  readonly server: Server;
}

export class RelayBridge {
  private readonly store: RelayStore;
  private readonly runtimeDir: string;
  private readonly endpoints = new Map<string, BoundEndpoint>();
  private closed = false;

  /**
   * @param store durable relay store the bridge writes through.
   * @param runtimeDir private (0700) directory to hold per-instance sockets;
   *   MUST be separate from the store's state directory.
   * @param capability result of `detectLinuxSandbox()`; construction fails
   *   closed unless `available` is true.
   */
  constructor(
    store: RelayStore,
    runtimeDir: string,
    capability: SandboxCapability,
  ) {
    if (!capability.available) {
      throw new RelayStoreError(
        `Refusing to open a bridge without a proven confinement boundary: ${capability.reason}`,
        "sandbox_unavailable",
      );
    }
    ensurePrivateDirectory(runtimeDir);
    this.store = store;
    this.runtimeDir = runtimeDir;
  }

  /**
   * Create a per-instance socket for a freshly launched, confined child and
   * return the host path to bind-mount into its sandbox. The returned path is
   * the child's sole route to the relay. Re-minting for an instance whose
   * fence advanced revokes the previous socket first, so a stale child can
   * never keep writing after it lost ownership.
   */
  mint(identity: BridgeIdentity): { hostSocket: string } {
    this.assertOpen();
    if (
      !identity.groupId ||
      !identity.instanceId ||
      !Number.isInteger(identity.fence) ||
      identity.fence < 1
    ) {
      throw new RelayStoreError(
        "Bridge identity requires a group, instance and positive fence",
        "invalid_identity",
      );
    }
    const existing = this.endpoints.get(identity.instanceId);
    if (existing) this.revoke(identity.instanceId);

    // Socket file name is a fixed function of the (opaque, server-generated)
    // instance id and its fence; a child never chooses it and cannot enumerate
    // the private runtime dir. Encoding the fence means a rotated instance gets
    // a distinct node, so a stale child's bind mount is left pointing at an
    // unlinked, closed socket rather than at the new writer.
    const socketPath = join(
      this.runtimeDir,
      `${identity.instanceId}.${identity.fence}.sock`,
    );
    if (existsSync(socketPath)) {
      if (!lstatSync(socketPath).isSocket()) {
        throw new RelayStoreError(
          "Refusing to reuse a non-socket bridge path",
          "unsafe_socket",
        );
      }
      unlinkSync(socketPath);
    }

    const server = createServer((peer) => this.handlePeer(identity, peer));
    server.on("error", () => {
      /* a broken client socket must never crash the relay */
    });

    const endpoint: BoundEndpoint = { identity, socketPath, server };
    this.endpoints.set(identity.instanceId, endpoint);

    return this.listenSync(endpoint);
  }

  /** Close and remove an instance's socket (e.g. on release or fence rotation). */
  revoke(instanceId: string): void {
    const endpoint = this.endpoints.get(instanceId);
    if (!endpoint) return;
    this.endpoints.delete(instanceId);
    try {
      endpoint.server.close();
    } finally {
      if (
        existsSync(endpoint.socketPath) &&
        lstatSync(endpoint.socketPath).isSocket()
      ) {
        unlinkSync(endpoint.socketPath);
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const instanceId of [...this.endpoints.keys()]) {
      this.revoke(instanceId);
    }
  }

  private assertOpen(): void {
    if (this.closed)
      throw new RelayStoreError("Bridge is closed", "bridge_closed");
  }

  private listenSync(endpoint: BoundEndpoint): { hostSocket: string } {
    endpoint.server.listen(endpoint.socketPath);
    // Node binds the Unix socket synchronously enough for the file to exist on
    // the next tick; callers that need the socket immediately should await
    // `waitUntilReady`. Tighten permissions as soon as the node exists.
    if (existsSync(endpoint.socketPath)) chmodSync(endpoint.socketPath, 0o600);
    return { hostSocket: endpoint.socketPath };
  }

  /** Resolve once the given instance's socket is accepting connections. */
  waitUntilReady(instanceId: string): Promise<void> {
    const endpoint = this.endpoints.get(instanceId);
    if (!endpoint)
      return Promise.reject(
        new RelayStoreError(`No endpoint for ${instanceId}`, "not_found"),
      );
    if (endpoint.server.listening) {
      if (existsSync(endpoint.socketPath))
        chmodSync(endpoint.socketPath, 0o600);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      endpoint.server.once("listening", () => {
        if (existsSync(endpoint.socketPath))
          chmodSync(endpoint.socketPath, 0o600);
        resolve();
      });
      endpoint.server.once("error", reject);
    });
  }

  private handlePeer(identity: BridgeIdentity, peer: Socket): void {
    peer.setEncoding("utf8");
    peer.on("error", () => peer.destroy());
    peer.setTimeout(PEER_IDLE_MS, () => peer.destroy());
    let buffer = "";
    peer.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
        this.reply(peer, { ok: false, code: "too_large" });
        peer.destroy();
        return;
      }
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim().length > 0) this.dispatch(identity, peer, line);
        index = buffer.indexOf("\n");
      }
    });
  }

  private dispatch(identity: BridgeIdentity, peer: Socket, line: string): void {
    let request: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      )
        throw new Error("request must be a JSON object");
      request = parsed as Record<string, unknown>;
    } catch (error) {
      this.reply(peer, {
        ok: false,
        code: "bad_request",
        message: (error as Error).message,
      });
      return;
    }

    // The sender identity is ALWAYS the identity bound to this socket. Any
    // `sender`/`from`/`groupId`/`instanceId` in the request body is ignored,
    // so a child cannot claim to be another instance.
    const sender: CallerIdentity = {
      role: "instance",
      groupId: identity.groupId,
      instanceId: identity.instanceId,
      fence: identity.fence,
    };

    try {
      // Revocation must apply to reads as well as writes. Closing a listening
      // socket does not close connections accepted before a fence rotation.
      // Without this check, an old child can continue reading its inbox via
      // listMine even though enqueue/settleResult correctly reject its fence.
      const current = this.store.getInstance(identity.instanceId);
      if (
        !current ||
        current.groupId !== identity.groupId ||
        current.fence !== identity.fence ||
        current.status !== "bound"
      ) {
        throw new RelayStoreError(
          "Bridge identity is no longer the current bound writer",
          "fence_mismatch",
        );
      }
      const op = request.op;
      if (op === "whoami") {
        this.reply(peer, { ok: true, identity });
        return;
      }
      if (op === "enqueue") {
        const result = this.store.enqueue({
          sender,
          recipient: this.recipientOf(identity.groupId, request.recipient),
          kind: this.kindOf(request.kind),
          bodyUtf8: this.stringOf(request.body, "body"),
          idempotencyKey: this.stringOf(
            request.idempotencyKey,
            "idempotencyKey",
          ),
          inReplyTo:
            request.inReplyTo === undefined
              ? undefined
              : this.stringOf(request.inReplyTo, "inReplyTo"),
        });
        this.reply(peer, { ok: true, result });
        return;
      }
      if (op === "listMine") {
        this.reply(peer, {
          ok: true,
          items: this.store.listUnresolvedForRecipient(identity.instanceId),
        });
        return;
      }
      if (op === "settleResult") {
        const record = this.store.settleResult({
          instanceId: identity.instanceId,
          expectedFence: identity.fence,
          runId: this.stringOf(request.runId, "runId"),
          resultJson: request.result ?? null,
          idempotencyKey:
            request.idempotencyKey === undefined
              ? undefined
              : this.stringOf(request.idempotencyKey, "idempotencyKey"),
        });
        this.reply(peer, { ok: true, result: record });
        return;
      }
      this.reply(peer, { ok: false, code: "unknown_op" });
    } catch (error) {
      if (error instanceof RelayStoreError) {
        this.reply(peer, {
          ok: false,
          code: error.code,
          message: error.message,
        });
      } else {
        this.reply(peer, {
          ok: false,
          code: "error",
          message: (error as Error).message,
        });
      }
    }
  }

  private recipientOf(senderGroupId: string, value: unknown): RecipientRef {
    if (value === null || typeof value !== "object")
      throw new RelayStoreError("recipient is required", "bad_request");
    const ref = value as Record<string, unknown>;
    if (ref.parent === true) return { parent: true };
    if (typeof ref.instanceId === "string")
      return { instanceId: ref.instanceId };
    if (typeof ref.alias === "string")
      // Recipient group is forced to the sender's own group; a child cannot
      // address another group even by supplying a groupId in the request.
      return { groupId: senderGroupId, alias: ref.alias };
    throw new RelayStoreError("recipient is malformed", "bad_request");
  }

  private kindOf(value: unknown): EnvelopeKind {
    if (value === "message" || value === "question" || value === "reply")
      return value;
    throw new RelayStoreError(
      "kind must be message|question|reply",
      "bad_request",
    );
  }

  private stringOf(value: unknown, label: string): string {
    if (typeof value !== "string" || value.length === 0)
      throw new RelayStoreError(
        `${label} must be a non-empty string`,
        "bad_request",
      );
    return value;
  }

  private reply(peer: Socket, payload: unknown): void {
    if (peer.destroyed || !peer.writable) return;
    try {
      peer.write(`${JSON.stringify(payload)}\n`);
    } catch {
      peer.destroy();
    }
  }
}
