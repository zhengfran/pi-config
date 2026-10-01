/**
 * RelayStore — durable registry + mailbox core for the subagents relay.
 *
 * Implements the SQLite-backed state described in
 * `06-durable-mailbox-contract` and `04-durable-owner-boundary`:
 * - a versioned registry of agent instances (reservation, immutable
 *   group-scoped alias, single-writer fencing, global admission cap);
 * - a per-recipient mailbox with idempotent enqueue, question/reply
 *   correlation, claim leases and an append-only receipt log that never
 *   redelivers native input once a `native_attempt_started` receipt exists;
 * - a durable, idempotent result inbox independent of message delivery.
 *
 * This module is an isolated storage core only. It does not open a socket,
 * mint or verify child bridge credentials, or perform any native harness
 * I/O. It is NOT evidence of anti-spoofing/isolation between same-user
 * children — that hard release gate is a separate, still-open concern
 * (see `06-durable-mailbox-contract`). Callers authenticate a caller
 * identity (`{groupId, instanceId, fence}` or the parent role) themselves;
 * this store only refuses writes that fail its own fencing/ACL checks.
 *
 * Concurrency model: this class assumes a single Node process/connection
 * owns the database file at a time (the separate `RelayOwnership` lock in
 * `./ownership.ts` is responsible for enforcing that across process
 * restarts). Within that process, every state-changing method opens its own
 * `BEGIN IMMEDIATE ... COMMIT` transaction, so concurrent synchronous calls
 * from the same process still serialize safely against SQLite.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  existsSync,
  statSync,
  openSync,
  closeSync,
  constants,
} from "node:fs";
import { RelayOwnership } from "./ownership.ts";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Base class for all RelayStore errors; every failure mode is named. */
export class RelayStoreError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
    this.name = new.target.name;
  }
}

export class MalformedLoadoutError extends RelayStoreError {
  constructor(message: string) {
    super(message, "malformed_loadout");
  }
}

export class CapacityError extends RelayStoreError {
  constructor(message: string) {
    super(message, "capacity_exceeded");
  }
}

export class AliasConflictError extends RelayStoreError {
  constructor(message: string) {
    super(message, "alias_conflict");
  }
}

export class IdempotencyConflictError extends RelayStoreError {
  constructor(message: string) {
    super(message, "idempotency_conflict");
  }
}

export class NotFoundError extends RelayStoreError {
  constructor(message: string) {
    super(message, "not_found");
  }
}

export class FenceMismatchError extends RelayStoreError {
  constructor(message: string) {
    super(message, "fence_mismatch");
  }
}

export class PayloadTooLargeError extends RelayStoreError {
  constructor(message: string) {
    super(message, "payload_too_large");
  }
}

export class ClaimBlockedError extends RelayStoreError {
  readonly reason: "in_flight" | "already_claimed" | "uncertain" | "suspended";

  constructor(
    message: string,
    reason: "in_flight" | "already_claimed" | "uncertain" | "suspended",
  ) {
    super(message, "claim_blocked");
    this.reason = reason;
  }
}

export class InvalidStateError extends RelayStoreError {
  constructor(message: string) {
    super(message, "invalid_state");
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InstanceStatus = "reserved" | "bound" | "released" | "unknown";

export interface InstanceRecord {
  readonly instanceId: string;
  readonly groupId: string;
  readonly alias: string;
  readonly loadout: unknown;
  readonly status: InstanceStatus;
  readonly runId: string | null;
  readonly nativeSessionId: string | null;
  /** Monotonically increasing single-writer fence token. */
  readonly fence: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReserveInput {
  readonly groupId: string;
  /** Group-scoped display alias; immutable once reserved. */
  readonly alias: string;
  /** Immutable per-child loadout snapshot; JSON-serializable. */
  readonly loadout: unknown;
  /** Stable retry key scoped to the group; safe to resend after a lost reply. */
  readonly idempotencyKey?: string;
}

export interface BindInput {
  readonly instanceId: string;
  readonly expectedFence: number;
  readonly runId: string;
  readonly nativeSessionId?: string | null;
}

export interface ReleaseInput {
  readonly instanceId: string;
  readonly expectedFence: number;
  /** Release only after external native evidence proves this executor stopped. */
  readonly reason: string;
  /** An explicit cancel suspends unresolved pre-native inbox items atomically. */
  readonly cancelled?: boolean;
}

/** Caller identity used to authorize a mailbox write; never a model-supplied field. */
export type CallerIdentity =
  | {
      readonly role: "instance";
      readonly groupId: string;
      readonly instanceId: string;
      readonly fence: number;
    }
  | { readonly role: "parent"; readonly groupId: string };

export type RecipientRef =
  | { readonly instanceId: string }
  | { readonly groupId: string; readonly alias: string }
  | { readonly parent: true };

export type EnvelopeKind = "message" | "question" | "reply";

export interface EnqueueInput {
  readonly sender: CallerIdentity;
  readonly recipient: RecipientRef;
  readonly kind: EnvelopeKind;
  readonly bodyUtf8: string;
  readonly idempotencyKey: string;
  /** Required when `kind === "reply"`; references the original question's message ID. */
  readonly inReplyTo?: string;
}

export interface EnqueueResult {
  readonly messageId: string;
  readonly recipientSeq: number;
  readonly status: "accepted";
}

export type ReceiptEvent =
  | "accepted"
  | "pending"
  | "delivery_claimed"
  | "native_attempt_started"
  | "delivered"
  | "processed"
  | "suspended"
  | "needs_reconciliation"
  | "discarded";

export interface ReceiptRecord {
  readonly id: number;
  readonly messageId: string;
  readonly event: ReceiptEvent;
  readonly attemptId: string | null;
  readonly nativeSessionId: string | null;
  readonly detail: unknown;
  readonly createdAt: string;
}

export interface EnvelopeRecord {
  readonly messageId: string;
  readonly groupId: string;
  readonly senderIdentity: string;
  readonly recipientId: string;
  readonly recipientSeq: number;
  readonly kind: EnvelopeKind;
  readonly bodyUtf8: string;
  readonly inReplyTo: string | null;
  readonly createdAt: string;
  readonly status: ReceiptEvent;
  readonly discardedAt: string | null;
}

export interface ClaimResult {
  readonly envelope: EnvelopeRecord;
  readonly attemptId: string;
  readonly leaseExpiresAt: string;
}

export interface SettleResultInput {
  readonly instanceId: string;
  readonly expectedFence: number;
  readonly runId: string;
  readonly resultJson: unknown;
  readonly idempotencyKey?: string;
}

export interface ResultRecord {
  readonly resultId: string;
  readonly instanceId: string;
  readonly runId: string;
  readonly groupId: string;
  readonly result: unknown;
  readonly createdAt: string;
  readonly collectedAt: string | null;
  readonly archivedAt: string | null;
}

export interface RelayStoreOptions {
  /** Default 64 KiB (spec default); configurable for tests/ops. */
  readonly maxBodyBytes?: number;
  /** Default 256 unresolved items per delegation group. */
  readonly maxUnresolvedPerGroup?: number;
  /** Logical retained payload cap, default 100 MiB. */
  readonly maxTotalBytes?: number;
  /** Physical DB + rollback journal + owner file cap, default 100 MiB. */
  readonly maxDiskBytes?: number;
  /** Default 4; the shared cross-session admission cap. */
  readonly maxInstances?: number;
  /** Default 5 minutes; claim lease duration before it may be reclaimed. */
  readonly claimLeaseMs?: number;
}

const SCHEMA_VERSION = 2;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_MAX_UNRESOLVED_PER_GROUP = 256;
const DEFAULT_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const PHYSICAL_OVERHEAD_BYTES = 128 * 1024;

/** A full DB plus a worst-case rollback journal (one P+8 record per old page). */
export function physicalPageCeiling(
  budgetBytes: number,
  pageSize: number,
): number {
  if (
    !Number.isSafeInteger(budgetBytes) ||
    !Number.isSafeInteger(pageSize) ||
    budgetBytes < 1024 * 1024 ||
    pageSize !== 4096
  ) {
    throw new CapacityError(
      "Relay physical budget requires >=1MiB and 4096-byte SQLite pages",
    );
  }
  return Math.floor(
    (budgetBytes - PHYSICAL_OVERHEAD_BYTES) / (2 * pageSize + 8),
  );
}
const DEFAULT_MAX_INSTANCES = 4;
const DEFAULT_CLAIM_LEASE_MS = 5 * 60 * 1000;
const MAX_LOADOUT_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_RECEIPT_DETAIL_BYTES = 4 * 1024;
const MAX_KEY_BYTES = 256;

/** Stable identity string for a mailbox sender, used for idempotency-key uniqueness. */
function senderIdentityOf(sender: CallerIdentity): string {
  return sender.role === "parent"
    ? `parent:${sender.groupId}`
    : sender.instanceId;
}

/** Deterministic JSON serialization (sorted object keys) so idempotent retries compare content, not key order. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      throw new Error("loadout must contain only plain JSON objects");
    }
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  if (
    typeof value === "undefined" ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint" ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    throw new Error(
      "loadout contains a value that cannot round-trip through JSON",
    );
  }
  return value;
}

export class RelayStore {
  private readonly db: DatabaseSync;
  private readonly owner: RelayOwnership;
  private readonly maxBodyBytes: number;
  private readonly maxUnresolvedPerGroup: number;
  private readonly maxTotalBytes: number;
  private readonly maxDiskBytes: number;
  private readonly maxInstances: number;
  private readonly claimLeaseMs: number;
  private readonly epochValue: number;
  private closed = false;

  constructor(rootDir: string, options: RelayStoreOptions = {}) {
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.maxUnresolvedPerGroup =
      options.maxUnresolvedPerGroup ?? DEFAULT_MAX_UNRESOLVED_PER_GROUP;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.maxDiskBytes = options.maxDiskBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.maxInstances = options.maxInstances ?? DEFAULT_MAX_INSTANCES;
    this.claimLeaseMs = options.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS;
    if (
      !Number.isSafeInteger(this.maxBodyBytes) ||
      this.maxBodyBytes < 1 ||
      this.maxBodyBytes > 256 * 1024 ||
      !Number.isSafeInteger(this.maxUnresolvedPerGroup) ||
      this.maxUnresolvedPerGroup < 1 ||
      this.maxUnresolvedPerGroup > 1024 ||
      !Number.isSafeInteger(this.maxInstances) ||
      this.maxInstances < 1 ||
      this.maxInstances > 4 ||
      !Number.isSafeInteger(this.maxTotalBytes) ||
      this.maxTotalBytes < 1 ||
      this.maxTotalBytes > 1024 * 1024 * 1024 ||
      !Number.isSafeInteger(this.claimLeaseMs) ||
      this.claimLeaseMs < 1 ||
      this.claimLeaseMs > 24 * 60 * 60 * 1000
    ) {
      throw new CapacityError(
        "Relay limits must be positive and within the supported hard ceilings",
      );
    }

    this.owner = RelayOwnership.acquire(rootDir);
    let opened: DatabaseSync | undefined;
    try {
      const stat = lstatSync(rootDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new RelayStoreError(
          "Relay store directory must be a real, non-symlinked directory",
          "unsafe_directory",
        );
      }
      if (process.getuid && stat.uid !== process.getuid()) {
        throw new RelayStoreError(
          "Relay store directory is not owned by the current user",
          "unsafe_directory",
        );
      }
      if ((stat.mode & 0o077) !== 0) {
        throw new RelayStoreError(
          "Relay store directory is not private (0700)",
          "unsafe_directory",
        );
      }

      const dbPath = join(rootDir, "relay-store.sqlite");
      try {
        const fd = openSync(
          dbPath,
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_WRONLY |
            constants.O_NOFOLLOW,
          0o600,
        );
        closeSync(fd);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      try {
        const prior = lstatSync(dbPath);
        if (
          !prior.isFile() ||
          prior.isSymbolicLink() ||
          prior.uid !== process.getuid?.() ||
          (prior.mode & 0o077) !== 0
        ) {
          throw new RelayStoreError(
            "Relay database file is not private",
            "unsafe_file",
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        let sidecar;
        try {
          sidecar = lstatSync(dbPath + suffix);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (
          suffix !== "-journal" ||
          !sidecar.isFile() ||
          sidecar.isSymbolicLink() ||
          sidecar.uid !== process.getuid?.()
        ) {
          throw new RelayStoreError(
            "Untrusted SQLite sidecar detected; refusing the store",
            "unsafe_journal",
          );
        }
        // A hot DELETE-mode journal must remain intact for SQLite recovery.
      }
      const files = [
        dbPath,
        dbPath + "-journal",
        join(rootDir, "owner.sqlite"),
        join(rootDir, "owner.sqlite-journal"),
      ];
      const allocated = files.reduce(
        (sum, file) =>
          sum + (existsSync(file) ? statSync(file).blocks * 512 : 0),
        0,
      );
      if (allocated > this.maxDiskBytes)
        throw new CapacityError(
          "Relay storage already exceeds the physical budget",
        );
      opened = new DatabaseSync(dbPath);
      this.db = opened;
      const priorMode = this.db.prepare("PRAGMA journal_mode").get() as {
        journal_mode: string;
      };
      if (priorMode.journal_mode.toLowerCase() !== "delete")
        throw new RelayStoreError(
          "Expected DELETE rollback journal, refusing an unknown mode",
          "unsafe_journal",
        );
      this.db.exec(
        "PRAGMA foreign_keys = ON; PRAGMA cache_spill = OFF; PRAGMA temp_store = MEMORY; PRAGMA busy_timeout = 2000",
      );
      const pageSize = (
        this.db.prepare("PRAGMA page_size").get() as { page_size: number }
      ).page_size;
      const limit = physicalPageCeiling(this.maxDiskBytes, pageSize);
      const currentPages = (
        this.db.prepare("PRAGMA page_count").get() as { page_count: number }
      ).page_count;
      if (currentPages > limit)
        throw new CapacityError(
          "Existing relay database exceeds the physical page ceiling",
        );
      const applied = (
        this.db.prepare(`PRAGMA max_page_count = ${limit}`).get() as {
          max_page_count: number;
        }
      ).max_page_count;
      if (applied !== limit)
        throw new CapacityError("Cannot apply the relay physical page ceiling");

      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.migrate();
        this.epochValue = this.bumpEpoch();
        this.reconcileOnOpen();
        this.db.exec("COMMIT");
      } catch (error) {
        this.rollback(error);
      }
    } catch (error) {
      opened?.close();
      this.owner.close();
      throw error;
    }
  }

  /** Durable server epoch; increments on every process start (fencing generation). */
  get epoch(): number {
    return this.epochValue;
  }

  get schemaVersion(): number {
    return SCHEMA_VERSION;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } finally {
      this.owner.close();
    }
  }

  // -------------------------------------------------------------------------
  // Schema / restart reconciliation
  // -------------------------------------------------------------------------

  private migrate(): void {
    const existing = this.db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as Array<{ name: string }>;
    if (
      existing.length > 0 &&
      !existing.some((table) => table.name === "meta")
    ) {
      throw new RelayStoreError(
        "Existing database has no relay schema marker",
        "schema_mismatch",
      );
    }
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    if (row && row.value !== "1" && row.value !== String(SCHEMA_VERSION)) {
      throw new RelayStoreError(
        `Relay store schema version ${row.value} does not match supported version ${SCHEMA_VERSION}`,
        "schema_mismatch",
      );
    }
    if (!row && existing.length > 0) {
      throw new RelayStoreError(
        "Existing relay database is missing a schema version",
        "schema_mismatch",
      );
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS instances (
        instance_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        alias TEXT NOT NULL,
        loadout_json TEXT NOT NULL,
        reserve_idempotency_key TEXT,
        status TEXT NOT NULL,
        run_id TEXT,
        native_session_id TEXT,
        fence INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (group_id, alias),
        UNIQUE (group_id, reserve_idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS envelopes (
        message_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        sender_identity TEXT NOT NULL,
        recipient_id TEXT NOT NULL,
        recipient_seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        body_utf8 TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        in_reply_to TEXT,
        sender_idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        claim_attempt_id TEXT,
        claim_lease_expires_at TEXT,
        claim_epoch INTEGER,
        discarded_at TEXT,
        UNIQUE (recipient_id, recipient_seq),
        UNIQUE (sender_identity, sender_idempotency_key)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_reply_unique ON envelopes(in_reply_to) WHERE kind = 'reply';

      CREATE TABLE IF NOT EXISTS receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        event TEXT NOT NULL,
        attempt_id TEXT,
        native_session_id TEXT,
        detail_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_receipts_message ON receipts (message_id, id);

      CREATE TABLE IF NOT EXISTS results (
        result_id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        result_json TEXT NOT NULL,
        idempotency_key TEXT,
        created_at TEXT NOT NULL,
        collected_at TEXT,
        archived_at TEXT,
        UNIQUE (instance_id, run_id)
      );
      CREATE TABLE IF NOT EXISTS result_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        result_id TEXT NOT NULL,
        event TEXT NOT NULL,
        detail_json TEXT,
        created_at TEXT NOT NULL
      );
    `);

    if (!row)
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)")
        .run(String(SCHEMA_VERSION));
    else if (row.value === "1")
      this.db
        .prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'")
        .run(String(SCHEMA_VERSION));
  }

  private bumpEpoch(): number {
    const tx = this.db.prepare("SELECT value FROM meta WHERE key = 'epoch'");
    const row = tx.get() as { value: string } | undefined;
    const next = row ? Number(row.value) + 1 : 1;
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES ('epoch', ?) ON CONFLICT(key) DO UPDATE SET value = ?",
      )
      .run(String(next), String(next));
    return next;
  }

  /**
   * On every start: instances that were mid-run (`bound`) or mid-launch
   * (`reserved`, launch outcome never confirmed) become `unknown` rather than
   * assumed dead or assumed alive — per 04-durable-owner-boundary. Envelopes
   * with a `native_attempt_started` receipt and no later `delivered` /
   * `processed` become durably uncertain and must never be auto-redelivered.
   */
  private reconcileOnOpen(): void {
    this.db
      .prepare(
        "UPDATE instances SET status = 'unknown', updated_at = ? WHERE status IN ('bound', 'reserved')",
      )
      .run(new Date().toISOString());

    const uncertain = this.db
      .prepare(
        `SELECT e.message_id AS message_id FROM envelopes e
           WHERE e.discarded_at IS NULL
             AND (SELECT r.event FROM receipts r WHERE r.message_id = e.message_id ORDER BY r.id DESC LIMIT 1)
               = 'native_attempt_started'`,
      )
      .all() as Array<{ message_id: string }>;
    for (const row of uncertain) {
      this.insertReceipt(row.message_id, "needs_reconciliation", {
        attemptId: null,
        nativeSessionId: null,
        detail: {
          reason:
            "relay restarted after native attempt started; delivery unproven",
        },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Registry
  // -------------------------------------------------------------------------

  /**
   * Reserve an agent instance slot. Enforces the shared, cross-session cap
   * (default 4) counting `reserved`/`bound`/`unknown` (uncertain) instances,
   * and fails closed on a missing/unserializable loadout. Idempotent retries
   * with the same `{groupId, idempotencyKey}` and identical alias/loadout
   * return the original reservation instead of creating a second one.
   */
  reserve(input: ReserveInput): InstanceRecord {
    if (
      !input.groupId ||
      !input.alias ||
      Buffer.byteLength(input.groupId) > MAX_KEY_BYTES ||
      Buffer.byteLength(input.alias) > MAX_KEY_BYTES ||
      (input.idempotencyKey !== undefined &&
        (input.idempotencyKey.length === 0 ||
          Buffer.byteLength(input.idempotencyKey) > MAX_KEY_BYTES))
    ) {
      throw new MalformedLoadoutError(
        "groupId and alias are required to reserve an instance",
      );
    }
    let loadoutJson: string;
    try {
      if (
        input.loadout === null ||
        typeof input.loadout !== "object" ||
        Array.isArray(input.loadout) ||
        Object.keys(input.loadout).length === 0
      ) {
        throw new Error("loadout must be a nonempty object");
      }
      const loadout = input.loadout as Record<string, unknown>;
      if (loadout.groupId !== undefined && loadout.groupId !== input.groupId) {
        throw new Error("loadout group does not match reservation group");
      }
      if (
        loadout.allowedRecipients !== undefined &&
        (!Array.isArray(loadout.allowedRecipients) ||
          !loadout.allowedRecipients.every(
            (value) => typeof value === "string",
          ))
      ) {
        throw new Error("allowedRecipients must be a list of names");
      }
      loadoutJson = canonicalJson(input.loadout);
      if (Buffer.byteLength(loadoutJson, "utf8") > MAX_LOADOUT_BYTES) {
        throw new Error("loadout exceeds 64 KiB");
      }
    } catch (error) {
      throw new MalformedLoadoutError(
        `Refusing to reserve instance with malformed loadout: ${(error as Error).message}`,
      );
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (input.idempotencyKey) {
        const existing = this.db
          .prepare(
            "SELECT * FROM instances WHERE group_id = ? AND reserve_idempotency_key = ?",
          )
          .get(input.groupId, input.idempotencyKey) as unknown as
          InstanceRow | undefined;
        if (existing) {
          if (
            existing.alias !== input.alias ||
            existing.loadout_json !== loadoutJson
          ) {
            throw new IdempotencyConflictError(
              `Reservation idempotency key ${input.idempotencyKey} was already used with a different alias/loadout`,
            );
          }
          this.db.exec("COMMIT");
          return toInstanceRecord(existing);
        }
      }

      const activeCount = (
        this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM instances WHERE status IN ('reserved','bound','unknown')",
          )
          .get() as { n: number }
      ).n;
      if (activeCount >= this.maxInstances) {
        throw new CapacityError(
          `Global instance admission cap reached (${this.maxInstances}); reject rather than over-admit`,
        );
      }

      const now = new Date().toISOString();
      const instanceId = randomUUID();
      try {
        this.db
          .prepare(
            `INSERT INTO instances
              (instance_id, group_id, alias, loadout_json, reserve_idempotency_key, status, run_id, native_session_id, fence, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'reserved', NULL, NULL, 1, ?, ?)`,
          )
          .run(
            instanceId,
            input.groupId,
            input.alias,
            loadoutJson,
            input.idempotencyKey ?? null,
            now,
            now,
          );
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new AliasConflictError(
            `Alias ${JSON.stringify(input.alias)} is already reserved in group ${input.groupId}`,
          );
        }
        throw error;
      }

      const created = this.db
        .prepare("SELECT * FROM instances WHERE instance_id = ?")
        .get(instanceId) as unknown as InstanceRow;
      this.db.exec("COMMIT");
      return toInstanceRecord(created);
    } catch (error) {
      this.rollback(error);
    }
  }

  /**
   * Commit a launch outcome (or an authorized reattach) for a reserved or
   * `unknown` instance. Requires the caller's last-known fence to match
   * exactly, and always advances the fence — a stale writer that lost
   * ownership can never bind again with its old token.
   */
  bind(input: BindInput): InstanceRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT * FROM instances WHERE instance_id = ?")
        .get(input.instanceId) as InstanceRow | undefined;
      if (!row) throw new NotFoundError(`No instance ${input.instanceId}`);
      if (row.fence !== input.expectedFence) {
        throw new FenceMismatchError(
          `Stale fence for instance ${input.instanceId}: expected ${row.fence}, caller had ${input.expectedFence}`,
        );
      }
      if (row.status !== "reserved" || !input.runId) {
        throw new InvalidStateError(
          `Instance ${input.instanceId} requires authorized native reconciliation before rebind (status: ${row.status})`,
        );
      }
      const newFence = row.fence + 1;
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE instances SET status = 'bound', run_id = ?, native_session_id = ?, fence = ?, updated_at = ?
           WHERE instance_id = ?`,
        )
        .run(
          input.runId,
          input.nativeSessionId ?? null,
          newFence,
          now,
          input.instanceId,
        );
      const updated = this.db
        .prepare("SELECT * FROM instances WHERE instance_id = ?")
        .get(input.instanceId) as unknown as InstanceRow;
      this.db.exec("COMMIT");
      return toInstanceRecord(updated);
    } catch (error) {
      this.rollback(error);
    }
  }

  /**
   * Explicitly release an instance's admission slot (frees the shared cap).
   * This never deletes the row: the alias and its history stay resolvable.
   */
  release(input: ReleaseInput): InstanceRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT * FROM instances WHERE instance_id = ?")
        .get(input.instanceId) as InstanceRow | undefined;
      if (!row) throw new NotFoundError(`No instance ${input.instanceId}`);
      if (row.fence !== input.expectedFence) {
        throw new FenceMismatchError(
          `Stale fence for instance ${input.instanceId}: expected ${row.fence}, caller had ${input.expectedFence}`,
        );
      }
      if (row.status === "unknown") {
        throw new InvalidStateError(
          "Uncertain instance cannot free admission without native reconciliation",
        );
      }
      const now = new Date().toISOString();
      this.db
        .prepare(
          "UPDATE instances SET status = 'released', fence = fence + 1, updated_at = ? WHERE instance_id = ?",
        )
        .run(now, input.instanceId);
      if (input.cancelled) {
        const queued = this.db
          .prepare(
            "SELECT message_id FROM envelopes WHERE recipient_id = ? AND discarded_at IS NULL ORDER BY recipient_seq",
          )
          .all(input.instanceId) as Array<{ message_id: string }>;
        for (const item of queued) {
          const status = this.currentStatus(item.message_id);
          if (
            status === "accepted" ||
            status === "pending" ||
            status === "delivery_claimed"
          ) {
            this.insertReceipt(item.message_id, "suspended", {
              attemptId: null,
              nativeSessionId: null,
              detail: { reason: input.reason },
            });
          }
          // Attempted/confirmed native input is never hidden as a safe pending item.
        }
      }
      const updated = this.db
        .prepare("SELECT * FROM instances WHERE instance_id = ?")
        .get(input.instanceId) as unknown as InstanceRow;
      this.db.exec("COMMIT");
      return toInstanceRecord(updated);
    } catch (error) {
      this.rollback(error);
    }
  }

  /** Resolve a stable instance by its immutable, group-scoped alias. Cross-group lookups always miss. */
  resolveByAlias(groupId: string, alias: string): InstanceRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM instances WHERE group_id = ? AND alias = ?")
      .get(groupId, alias) as InstanceRow | undefined;
    return row ? toInstanceRecord(row) : undefined;
  }

  getInstance(instanceId: string): InstanceRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM instances WHERE instance_id = ?")
      .get(instanceId) as InstanceRow | undefined;
    return row ? toInstanceRecord(row) : undefined;
  }

  // -------------------------------------------------------------------------
  // Mailbox
  // -------------------------------------------------------------------------

  /**
   * Atomically admit a message/question/reply. Authenticates the caller
   * identity (group + instance + fence, or the parent role) — never a
   * caller-supplied "from" field — resolves the recipient within the same
   * group, enforces size/backpressure limits, and de-duplicates retries by
   * `(senderIdentity, idempotencyKey)`: identical canonical payload+recipient
   * returns the original accepted receipt; a differing retry conflicts
   * instead of silently mutating history.
   */
  enqueue(input: EnqueueInput): EnqueueResult {
    if (
      !input.idempotencyKey ||
      Buffer.byteLength(input.idempotencyKey) > MAX_KEY_BYTES
    ) {
      throw new InvalidStateError("Message requires a bounded idempotency key");
    }
    const bodyBytes = Buffer.byteLength(input.bodyUtf8, "utf8");
    if (bodyBytes > this.maxBodyBytes) {
      throw new PayloadTooLargeError(
        `Message body is ${bodyBytes} bytes, exceeding the ${this.maxBodyBytes} limit`,
      );
    }
    if (input.kind === "reply" && !input.inReplyTo) {
      throw new RelayStoreError(
        "A reply must set inReplyTo to the original question's message ID",
        "invalid_reply",
      );
    }

    const senderIdentity = senderIdentityOf(input.sender);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (input.sender.role === "instance") {
        const sender = this.db
          .prepare("SELECT * FROM instances WHERE instance_id = ?")
          .get(input.sender.instanceId) as unknown as InstanceRow | undefined;
        if (!sender || sender.group_id !== input.sender.groupId) {
          throw new NotFoundError(
            `Unknown sender instance ${input.sender.instanceId} in group ${input.sender.groupId}`,
          );
        }
      }

      const groupId = input.sender.groupId;
      const recipient =
        "parent" in input.recipient && input.recipient.parent === true
          ? input.sender.role === "instance" &&
            (input.kind === "question" || input.kind === "reply")
            ? {
                instance_id: `parent:${groupId}`,
                group_id: groupId,
                alias: "__parent__",
              }
            : undefined
          : "instanceId" in input.recipient
            ? (this.db
                .prepare("SELECT * FROM instances WHERE instance_id = ?")
                .get(input.recipient.instanceId) as InstanceRow | undefined)
            : "alias" in input.recipient
              ? (this.db
                  .prepare(
                    "SELECT * FROM instances WHERE group_id = ? AND alias = ?",
                  )
                  .get(input.recipient.groupId, input.recipient.alias) as
                  InstanceRow | undefined)
              : undefined;
      if (!recipient || recipient.group_id !== groupId) {
        throw new NotFoundError(
          "Recipient does not exist in the sender's group",
        );
      }
      if (input.kind === "reply") {
        const question = this.db
          .prepare(
            "SELECT * FROM envelopes WHERE message_id = ? AND kind = 'question' AND discarded_at IS NULL",
          )
          .get(input.inReplyTo!) as EnvelopeRow | undefined;
        if (
          !question ||
          question.group_id !== groupId ||
          question.sender_identity !== recipient.instance_id ||
          question.recipient_id !== senderIdentity
        ) {
          throw new InvalidStateError(
            "Reply must target the original question's sender in this group",
          );
        }
        const prior = this.db
          .prepare(
            "SELECT 1 FROM envelopes WHERE in_reply_to = ? AND kind = 'reply'",
          )
          .get(input.inReplyTo!);
        if (
          prior &&
          !this.db
            .prepare(
              "SELECT 1 FROM envelopes WHERE sender_identity = ? AND sender_idempotency_key = ?",
            )
            .get(senderIdentity, input.idempotencyKey)
        ) {
          throw new IdempotencyConflictError(
            "Question already has a different reply",
          );
        }
      } else if (input.inReplyTo) {
        throw new InvalidStateError("Only replies may reference a question");
      }

      const existing = this.db
        .prepare(
          "SELECT * FROM envelopes WHERE sender_identity = ? AND sender_idempotency_key = ?",
        )
        .get(senderIdentity, input.idempotencyKey) as unknown as
        EnvelopeRow | undefined;
      if (existing) {
        if (
          existing.recipient_id !== recipient.instance_id ||
          existing.body_utf8 !== input.bodyUtf8 ||
          existing.kind !== input.kind ||
          existing.in_reply_to !== (input.inReplyTo ?? null)
        ) {
          throw new IdempotencyConflictError(
            `Idempotency key ${input.idempotencyKey} was already used for a different message`,
          );
        }
        this.db.exec("COMMIT");
        return {
          messageId: existing.message_id,
          recipientSeq: existing.recipient_seq,
          status: "accepted",
        };
      }

      // A lost commit response can be replayed after restart: return only the
      // same committed envelope above. Unknown/stale writers cannot create a
      // *new* envelope merely by reusing their old fence.
      if (input.sender.role === "instance") {
        const current = this.db
          .prepare("SELECT status, fence FROM instances WHERE instance_id = ?")
          .get(input.sender.instanceId) as {
          status: InstanceStatus;
          fence: number;
        };
        if (
          current.status !== "bound" ||
          current.fence !== input.sender.fence
        ) {
          throw new FenceMismatchError(
            `Sender ${input.sender.instanceId} is not the current bound writer`,
          );
        }
        const sender = this.db
          .prepare("SELECT loadout_json FROM instances WHERE instance_id = ?")
          .get(input.sender.instanceId) as { loadout_json: string };
        const allowed = (
          JSON.parse(sender.loadout_json) as { allowedRecipients?: unknown }
        ).allowedRecipients;
        if (
          !Array.isArray(allowed) ||
          !allowed.every((item) => typeof item === "string") ||
          !allowed.includes(recipient.alias)
        ) {
          throw new InvalidStateError(
            "Sender loadout does not authorize this recipient",
          );
        }
      }
      this.assertCapacity(groupId, bodyBytes);

      const nextSeq =
        ((
          this.db
            .prepare(
              "SELECT MAX(recipient_seq) AS n FROM envelopes WHERE recipient_id = ?",
            )
            .get(recipient.instance_id) as { n: number | null }
        ).n ?? 0) + 1;

      const messageId = randomUUID();
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO envelopes
            (message_id, group_id, sender_identity, recipient_id, recipient_seq, kind, body_utf8, body_hash,
             in_reply_to, sender_idempotency_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          messageId,
          groupId,
          senderIdentity,
          recipient.instance_id,
          nextSeq,
          input.kind,
          input.bodyUtf8,
          hashBody(input.bodyUtf8),
          input.inReplyTo ?? null,
          input.idempotencyKey,
          now,
        );
      this.insertReceipt(messageId, "accepted", {
        attemptId: null,
        nativeSessionId: null,
        detail: null,
      });
      this.db.exec("COMMIT");
      return { messageId, recipientSeq: nextSeq, status: "accepted" };
    } catch (error) {
      this.rollback(error);
    }
  }

  /**
   * Claim the lowest unresolved message for a recipient (strict per-recipient
   * ordering / head-of-line blocking): a suspended or uncertain
   * (`native_attempt_started` with no later evidence) message at the head
   * blocks any later one from being claimed instead of skipping ahead.
   */
  claim(
    recipientInstanceId: string,
    expectedFence: number,
  ): ClaimResult | { none: true } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const recipient = this.db
        .prepare("SELECT * FROM instances WHERE instance_id = ?")
        .get(recipientInstanceId) as InstanceRow | undefined;
      if (!recipient)
        throw new NotFoundError(`No instance ${recipientInstanceId}`);
      if (recipient.fence !== expectedFence || recipient.status !== "bound") {
        throw new FenceMismatchError(
          `Recipient ${recipientInstanceId} is not the current bound writer`,
        );
      }

      const head = this.db
        .prepare(
          `SELECT * FROM envelopes e WHERE recipient_id = ? AND discarded_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.message_id = e.message_id AND r.event = 'processed')
           ORDER BY recipient_seq ASC LIMIT 1`,
        )
        .get(recipientInstanceId) as unknown as EnvelopeRow | undefined;
      if (!head) {
        this.db.exec("COMMIT");
        return { none: true };
      }

      const status = this.currentStatus(head.message_id);
      if (
        status === "native_attempt_started" ||
        status === "needs_reconciliation" ||
        status === "delivered"
      ) {
        throw new ClaimBlockedError(
          `Message ${head.message_id} has an unproven native attempt; it must never be redelivered`,
          "uncertain",
        );
      }
      if (status === "suspended") {
        throw new ClaimBlockedError(
          `Message ${head.message_id} is suspended pending authorized resume`,
          "suspended",
        );
      }
      if (status === "delivery_claimed") {
        const leaseActive =
          head.claim_lease_expires_at &&
          head.claim_epoch === this.epochValue &&
          new Date(head.claim_lease_expires_at).getTime() > Date.now();
        if (leaseActive) {
          throw new ClaimBlockedError(
            `Message ${head.message_id} is already claimed by another bridge`,
            "already_claimed",
          );
        }
        // Lease expired (or relay restarted): safe to redeliver because no
        // native_attempt_started receipt exists yet for this message.
      }

      const attemptId = randomUUID();
      const leaseExpiresAt = new Date(
        Date.now() + this.claimLeaseMs,
      ).toISOString();
      this.db
        .prepare(
          "UPDATE envelopes SET claim_attempt_id = ?, claim_lease_expires_at = ?, claim_epoch = ? WHERE message_id = ?",
        )
        .run(attemptId, leaseExpiresAt, this.epochValue, head.message_id);
      this.insertReceipt(head.message_id, "delivery_claimed", {
        attemptId,
        nativeSessionId: null,
        detail: { recipientInstanceId },
      });
      const updated = this.db
        .prepare("SELECT * FROM envelopes WHERE message_id = ?")
        .get(head.message_id) as unknown as EnvelopeRow;
      this.db.exec("COMMIT");
      return {
        envelope: toEnvelopeRecord(updated, status),
        attemptId,
        leaseExpiresAt,
      };
    } catch (error) {
      this.rollback(error);
    }
  }

  /**
   * Durably record that native input is about to be attempted, BEFORE the
   * bridge calls the harness. This is the irreversible boundary: once
   * committed, this message can never be safely redelivered again — only
   * `markDelivered`/`markProcessed` (proven) or manual reconciliation
   * (`needs_reconciliation`, already applied automatically on restart) can
   * follow.
   */
  nativeAttemptStarted(
    messageId: string,
    attemptId: string,
    expectedFence: number,
    nativeSessionId: string,
    runId: string,
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const envelope = this.db
        .prepare("SELECT * FROM envelopes WHERE message_id = ?")
        .get(messageId) as EnvelopeRow | undefined;
      if (!envelope) throw new NotFoundError(`No message ${messageId}`);
      if (
        envelope.claim_attempt_id !== attemptId ||
        envelope.claim_epoch !== this.epochValue
      ) {
        throw new FenceMismatchError(
          `Attempt ${attemptId} does not hold this epoch's claim on message ${messageId}`,
        );
      }
      if (this.currentStatus(messageId) !== "delivery_claimed") {
        throw new InvalidStateError(
          "Native attempt may only start once, immediately after a current claim",
        );
      }
      const recipient = this.db
        .prepare("SELECT * FROM instances WHERE instance_id = ?")
        .get(envelope.recipient_id) as InstanceRow | undefined;
      if (
        !recipient ||
        recipient.status !== "bound" ||
        recipient.fence !== expectedFence ||
        recipient.run_id !== runId ||
        !recipient.native_session_id ||
        recipient.native_session_id !== nativeSessionId
      ) {
        throw new FenceMismatchError(
          "Native input requires the current bound run, fence and exact native session",
        );
      }
      this.insertReceipt(messageId, "native_attempt_started", {
        attemptId,
        nativeSessionId,
        detail: { runId },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.rollback(error);
    }
  }

  /** This storage method must only be called after the adapter validates native evidence. */
  markDelivered(
    messageId: string,
    nativeSessionId: string,
    evidence?: unknown,
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT discarded_at FROM envelopes WHERE message_id = ?")
        .get(messageId) as { discarded_at: string | null } | undefined;
      if (
        !row ||
        row.discarded_at ||
        !["native_attempt_started", "needs_reconciliation"].includes(
          this.currentStatus(messageId),
        )
      ) {
        throw new InvalidStateError(
          "Delivery requires an active native attempt, not a terminal or suspended message",
        );
      }
      const attempt = this.db
        .prepare(
          "SELECT native_session_id FROM receipts WHERE message_id = ? AND event = 'native_attempt_started' ORDER BY id DESC LIMIT 1",
        )
        .get(messageId) as { native_session_id: string } | undefined;
      if (!attempt || attempt.native_session_id !== nativeSessionId) {
        throw new FenceMismatchError(
          "Native delivery evidence does not match the attempted session",
        );
      }
      this.insertReceipt(messageId, "delivered", {
        attemptId: null,
        nativeSessionId,
        detail: evidence ?? null,
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.rollback(error);
    }
  }

  /** This storage method must only be called after the recipient's correlated ACK. */
  markProcessed(messageId: string, ackEvidence?: unknown): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT discarded_at FROM envelopes WHERE message_id = ?")
        .get(messageId) as { discarded_at: string | null } | undefined;
      if (
        !row ||
        row.discarded_at ||
        this.currentStatus(messageId) !== "delivered"
      ) {
        throw new InvalidStateError(
          "Processing requires an active confirmed delivery",
        );
      }
      this.insertReceipt(messageId, "processed", {
        attemptId: null,
        nativeSessionId: null,
        detail: ackEvidence ?? null,
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.rollback(error);
    }
  }

  /** Park only a pre-native message; an already attempted injection is uncertain, never suspended. */
  markSuspended(messageId: string, reason: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT discarded_at FROM envelopes WHERE message_id = ?")
        .get(messageId) as { discarded_at: string | null } | undefined;
      if (
        !row ||
        row.discarded_at ||
        !["accepted", "pending", "delivery_claimed"].includes(
          this.currentStatus(messageId),
        )
      ) {
        throw new InvalidStateError(
          "Only an active, pre-native message can be suspended",
        );
      }
      this.insertReceipt(messageId, "suspended", {
        attemptId: null,
        nativeSessionId: null,
        detail: { reason },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.rollback(error);
    }
  }

  /** Requires an authorized caller in the future transport. Never unpark an attempted instruction. */
  resumeSuspended(messageId: string, reason: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT discarded_at FROM envelopes WHERE message_id = ?")
        .get(messageId) as { discarded_at: string | null } | undefined;
      if (
        !row ||
        row.discarded_at ||
        this.currentStatus(messageId) !== "suspended"
      ) {
        throw new InvalidStateError(
          "Only a suspended, active message can be resumed",
        );
      }
      this.insertReceipt(messageId, "pending", {
        attemptId: null,
        nativeSessionId: null,
        detail: { reason },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.rollback(error);
    }
  }

  /** Explicit cleanup releases the unresolved-item slot, but retained history still costs disk/payload budget. */
  discard(messageId: string, reason: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      const result = this.db
        .prepare(
          "UPDATE envelopes SET discarded_at = ? WHERE message_id = ? AND discarded_at IS NULL",
        )
        .run(now, messageId);
      if (result.changes === 0)
        throw new NotFoundError(`No active message ${messageId} to discard`);
      this.insertReceipt(messageId, "discarded", {
        attemptId: null,
        nativeSessionId: null,
        detail: { reason },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.rollback(error);
    }
  }

  getEnvelope(messageId: string): EnvelopeRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM envelopes WHERE message_id = ?")
      .get(messageId) as EnvelopeRow | undefined;
    return row
      ? toEnvelopeRecord(row, this.currentStatus(messageId))
      : undefined;
  }

  /** Append-only receipt history for a message, oldest first. */
  getReceipts(messageId: string): ReceiptRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM receipts WHERE message_id = ? ORDER BY id ASC")
      .all(messageId) as unknown as ReceiptRow[];
    return rows.map(toReceiptRecord);
  }

  /** Offline parent inbox; caller authorization must be enforced by the relay transport. */
  listParentQuestions(groupId: string): EnvelopeRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM envelopes WHERE group_id = ? AND recipient_id = ? AND kind = 'question' AND discarded_at IS NULL ORDER BY recipient_seq ASC",
      )
      .all(groupId, `parent:${groupId}`) as unknown as EnvelopeRow[];
    return rows.map((row) =>
      toEnvelopeRecord(row, this.currentStatus(row.message_id)),
    );
  }

  /** Correlated reply for an authorized group's parent question; absent means still awaiting an answer. */
  getParentQuestionReply(
    groupId: string,
    questionId: string,
  ): EnvelopeRecord | undefined {
    const question = this.db
      .prepare(
        "SELECT 1 FROM envelopes WHERE group_id = ? AND message_id = ? AND recipient_id = ? AND kind = 'question'",
      )
      .get(groupId, questionId, `parent:${groupId}`);
    if (!question) return undefined;
    const reply = this.db
      .prepare(
        "SELECT * FROM envelopes WHERE group_id = ? AND kind = 'reply' AND in_reply_to = ? ORDER BY created_at LIMIT 1",
      )
      .get(groupId, questionId) as EnvelopeRow | undefined;
    return reply
      ? toEnvelopeRecord(reply, this.currentStatus(reply.message_id))
      : undefined;
  }

  listUnresolvedForRecipient(recipientInstanceId: string): EnvelopeRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM envelopes WHERE recipient_id = ? AND discarded_at IS NULL ORDER BY recipient_seq ASC",
      )
      .all(recipientInstanceId) as unknown as EnvelopeRow[];
    return rows
      .map((row) => ({ row, status: this.currentStatus(row.message_id) }))
      .filter(({ status }) => status !== "processed")
      .map(({ row, status }) => toEnvelopeRecord(row, status));
  }

  // -------------------------------------------------------------------------
  // Result inbox
  // -------------------------------------------------------------------------

  /**
   * Idempotently settle a run's result into the durable parent inbox,
   * independent of message delivery. Requires the settling instance's
   * current fence (only the fenced run that owns this instance may write
   * its own result); a retried settle with the same `{instanceId, runId}`
   * and identical canonical result returns the original row rather than
   * erroring or duplicating.
   */
  settleResult(input: SettleResultInput): ResultRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const instance = this.db
        .prepare("SELECT * FROM instances WHERE instance_id = ?")
        .get(input.instanceId) as InstanceRow | undefined;
      if (!instance) throw new NotFoundError(`No instance ${input.instanceId}`);
      if (
        instance.fence !== input.expectedFence ||
        instance.status !== "bound" ||
        instance.run_id !== input.runId
      ) {
        throw new FenceMismatchError(
          `Result requires the current bound run and fence on ${input.instanceId}`,
        );
      }

      const resultJson = canonicalJson(input.resultJson ?? null);
      if (Buffer.byteLength(resultJson, "utf8") > MAX_RESULT_BYTES) {
        throw new PayloadTooLargeError(
          "Run result exceeds the 1 MiB inbox limit",
        );
      }
      const existing = this.db
        .prepare("SELECT * FROM results WHERE instance_id = ? AND run_id = ?")
        .get(input.instanceId, input.runId) as unknown as ResultRow | undefined;
      if (existing) {
        if (existing.result_json !== resultJson) {
          throw new IdempotencyConflictError(
            `Run ${input.runId} on instance ${input.instanceId} already settled with a different result`,
          );
        }
        this.db.exec("COMMIT");
        return toResultRecord(existing);
      }

      this.assertCapacity(
        instance.group_id,
        Buffer.byteLength(resultJson, "utf8"),
      );

      const resultId = randomUUID();
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO results (result_id, instance_id, run_id, group_id, result_json, idempotency_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          resultId,
          input.instanceId,
          input.runId,
          instance.group_id,
          resultJson,
          input.idempotencyKey ?? null,
          now,
        );
      const created = this.db
        .prepare("SELECT * FROM results WHERE result_id = ?")
        .get(resultId) as unknown as ResultRow;
      this.db.exec("COMMIT");
      return toResultRecord(created);
    } catch (error) {
      this.rollback(error);
    }
  }

  /** Read-only view of a group's results; collection requires a separate acknowledgement. */
  listResults(groupId: string): ResultRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM results WHERE group_id = ? AND archived_at IS NULL ORDER BY created_at ASC",
      )
      .all(groupId) as unknown as ResultRow[];
    return rows.map(toResultRecord);
  }

  /** Actor identity must be supplied by an authenticated transport, never model text. */
  markResultCollected(resultId: string, actorIdentity: string): void {
    if (!actorIdentity)
      throw new InvalidStateError("Collection requires an actor identity");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      const result = this.db
        .prepare(
          "UPDATE results SET collected_at = ? WHERE result_id = ? AND collected_at IS NULL AND archived_at IS NULL",
        )
        .run(now, resultId);
      if (
        result.changes === 0 &&
        !this.db
          .prepare(
            "SELECT 1 FROM results WHERE result_id = ? AND archived_at IS NULL",
          )
          .get(resultId)
      ) {
        throw new NotFoundError(`No active result ${resultId}`);
      }
      if (result.changes > 0)
        this.insertResultAudit(resultId, "collected", { actorIdentity });
      this.db.exec("COMMIT");
    } catch (error) {
      this.rollback(error);
    }
  }

  /** Explicit archive leaves an immutable audit event; it never frees retained payload bytes. */
  archiveResult(resultId: string, reason: string, actorIdentity: string): void {
    if (!reason || !actorIdentity)
      throw new InvalidStateError("Archival requires an actor and reason");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      const result = this.db
        .prepare(
          "UPDATE results SET archived_at = ? WHERE result_id = ? AND archived_at IS NULL",
        )
        .run(now, resultId);
      if (result.changes === 0)
        throw new NotFoundError(`No active result ${resultId} to archive`);
      this.insertResultAudit(resultId, "archived", { actorIdentity, reason });
      this.db.exec("COMMIT");
    } catch (error) {
      this.rollback(error);
    }
  }

  listResultAudit(
    resultId: string,
  ): Array<{ event: string; detail: unknown; createdAt: string }> {
    const rows = this.db
      .prepare(
        "SELECT event, detail_json, created_at FROM result_audit WHERE result_id = ? ORDER BY id",
      )
      .all(resultId) as Array<{
      event: string;
      detail_json: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      event: row.event,
      detail: JSON.parse(row.detail_json),
      createdAt: row.created_at,
    }));
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** SQLITE_FULL may already have rolled back; do not mask the original error. */
  private rollback(error: unknown): never {
    if (this.db.isTransaction) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* preserve original storage failure */
      }
    }
    if (
      error instanceof Error &&
      /SQLITE_FULL|database or disk is full/i.test(error.message)
    ) {
      throw new CapacityError(
        "Relay SQLite page budget or filesystem capacity exceeded",
      );
    }
    throw error;
  }

  private insertResultAudit(
    resultId: string,
    event: string,
    detail: unknown,
  ): void {
    this.db
      .prepare(
        "INSERT INTO result_audit (result_id, event, detail_json, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(resultId, event, JSON.stringify(detail), new Date().toISOString());
  }

  private currentStatus(messageId: string): ReceiptEvent {
    const row = this.db
      .prepare(
        "SELECT event FROM receipts WHERE message_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(messageId) as { event: ReceiptEvent } | undefined;
    if (!row) throw new NotFoundError(`No receipts for message ${messageId}`);
    return row.event;
  }

  private insertReceipt(
    messageId: string,
    event: ReceiptEvent,
    fields: {
      attemptId: string | null;
      nativeSessionId: string | null;
      detail: unknown;
    },
  ): void {
    const detail =
      fields.detail === null || fields.detail === undefined
        ? null
        : JSON.stringify(fields.detail);
    if (
      detail &&
      Buffer.byteLength(detail, "utf8") > MAX_RECEIPT_DETAIL_BYTES
    ) {
      throw new PayloadTooLargeError(
        "Receipt evidence exceeds the 4 KiB limit",
      );
    }
    this.db
      .prepare(
        `INSERT INTO receipts (message_id, event, attempt_id, native_session_id, detail_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        messageId,
        event,
        fields.attemptId,
        fields.nativeSessionId,
        detail,
        new Date().toISOString(),
      );
  }

  /** Must be called inside an open transaction; throws (without committing) if either budget would be exceeded. */
  private assertCapacity(groupId: string, incomingBytes: number): void {
    const unresolvedEnvelopes = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM envelopes e WHERE e.group_id = ? AND e.discarded_at IS NULL
           AND (SELECT r.event FROM receipts r WHERE r.message_id = e.message_id ORDER BY r.id DESC LIMIT 1) <> 'processed'`,
        )
        .get(groupId) as { n: number }
    ).n;
    const unresolvedResults = (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM results WHERE group_id = ? AND archived_at IS NULL AND collected_at IS NULL",
        )
        .get(groupId) as {
        n: number;
      }
    ).n;
    if (unresolvedEnvelopes + unresolvedResults >= this.maxUnresolvedPerGroup) {
      throw new CapacityError(
        `Group ${groupId} has ${unresolvedEnvelopes + unresolvedResults} unresolved items, at the ${this.maxUnresolvedPerGroup} cap`,
      );
    }

    const totalBytes =
      (
        this.db
          .prepare(
            "SELECT COALESCE(SUM(LENGTH(CAST(body_utf8 AS BLOB))), 0) AS n FROM envelopes",
          )
          .get() as { n: number }
      ).n +
      (
        this.db
          .prepare(
            "SELECT COALESCE(SUM(LENGTH(CAST(result_json AS BLOB))), 0) AS n FROM results",
          )
          .get() as { n: number }
      ).n;
    if (totalBytes + incomingBytes > this.maxTotalBytes) {
      throw new CapacityError(
        `Persisted payload budget exceeded: ${totalBytes + incomingBytes} bytes would exceed the ${this.maxTotalBytes} limit`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Row shapes + mappers
// ---------------------------------------------------------------------------

interface InstanceRow {
  instance_id: string;
  group_id: string;
  alias: string;
  loadout_json: string;
  reserve_idempotency_key: string | null;
  status: InstanceStatus;
  run_id: string | null;
  native_session_id: string | null;
  fence: number;
  created_at: string;
  updated_at: string;
}

function toInstanceRecord(row: InstanceRow): InstanceRecord {
  return {
    instanceId: row.instance_id,
    groupId: row.group_id,
    alias: row.alias,
    loadout: JSON.parse(row.loadout_json),
    status: row.status,
    runId: row.run_id,
    nativeSessionId: row.native_session_id,
    fence: row.fence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface EnvelopeRow {
  message_id: string;
  group_id: string;
  sender_identity: string;
  recipient_id: string;
  recipient_seq: number;
  kind: EnvelopeKind;
  body_utf8: string;
  body_hash: string;
  in_reply_to: string | null;
  sender_idempotency_key: string;
  created_at: string;
  claim_attempt_id: string | null;
  claim_lease_expires_at: string | null;
  claim_epoch: number | null;
  discarded_at: string | null;
}

function toEnvelopeRecord(
  row: EnvelopeRow,
  status: ReceiptEvent,
): EnvelopeRecord {
  return {
    messageId: row.message_id,
    groupId: row.group_id,
    senderIdentity: row.sender_identity,
    recipientId: row.recipient_id,
    recipientSeq: row.recipient_seq,
    kind: row.kind,
    bodyUtf8: row.body_utf8,
    inReplyTo: row.in_reply_to,
    createdAt: row.created_at,
    status,
    discardedAt: row.discarded_at,
  };
}

interface ReceiptRow {
  id: number;
  message_id: string;
  event: ReceiptEvent;
  attempt_id: string | null;
  native_session_id: string | null;
  detail_json: string | null;
  created_at: string;
}

function toReceiptRecord(row: ReceiptRow): ReceiptRecord {
  return {
    id: row.id,
    messageId: row.message_id,
    event: row.event,
    attemptId: row.attempt_id,
    nativeSessionId: row.native_session_id,
    detail: row.detail_json ? JSON.parse(row.detail_json) : null,
    createdAt: row.created_at,
  };
}

interface ResultRow {
  result_id: string;
  instance_id: string;
  run_id: string;
  group_id: string;
  result_json: string;
  idempotency_key: string | null;
  created_at: string;
  collected_at: string | null;
  archived_at: string | null;
}

function toResultRecord(row: ResultRow): ResultRecord {
  return {
    resultId: row.result_id,
    instanceId: row.instance_id,
    runId: row.run_id,
    groupId: row.group_id,
    result: JSON.parse(row.result_json),
    createdAt: row.created_at,
    collectedAt: row.collected_at,
    archivedAt: row.archived_at,
  };
}

function hashBody(bodyUtf8: string): string {
  return createHash("sha256").update(bodyUtf8, "utf8").digest("hex");
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error && /UNIQUE constraint failed/i.test(error.message)
  );
}
