import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import test from "node:test";
import {
  AliasConflictError,
  CapacityError,
  ClaimBlockedError,
  FenceMismatchError,
  IdempotencyConflictError,
  MalformedLoadoutError,
  InvalidStateError,
  RelayStore,
  physicalPageCeiling,
} from "./src/relay/store.ts";
import type { CallerIdentity } from "./src/relay/store.ts";

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-store-test-"));
  return dir;
}

function withStore<T>(dir: string, fn: (store: RelayStore) => T): T {
  const store = new RelayStore(dir);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function reserveOne(store: RelayStore, groupId: string, alias: string) {
  return store.reserve({ groupId, alias, loadout: { role: "worker" } });
}

function boundRecipient(store: RelayStore, groupId: string, alias: string) {
  const reserved = reserveOne(store, groupId, alias);
  return store.bind({
    instanceId: reserved.instanceId,
    expectedFence: reserved.fence,
    runId: "run-1",
    nativeSessionId: "native-session-1",
  });
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

test("unknown future schema fails without creating tables or bumping epoch", () => {
  const dir = tempDir();
  try {
    const first = new RelayStore(dir);
    first.close();
    const file = join(dir, "relay-store.sqlite");
    const db = new DatabaseSync(file);
    db.prepare(
      "UPDATE meta SET value = '999' WHERE key = 'schema_version'",
    ).run();
    db.close();
    assert.throws(() => new RelayStore(dir), /schema version 999/);
    const inspected = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(
        (
          inspected
            .prepare("SELECT value FROM meta WHERE key = 'epoch'")
            .get() as { value: string }
        ).value,
        "1",
      );
    } finally {
      inspected.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schema v1 upgrades transactionally to v2 with audit table", () => {
  const dir = tempDir();
  try {
    withStore(dir, () => {});
    const file = join(dir, "relay-store.sqlite");
    const db = new DatabaseSync(file);
    db.exec("DROP TABLE result_audit");
    db.prepare(
      "UPDATE meta SET value = '1' WHERE key = 'schema_version'",
    ).run();
    db.close();
    withStore(dir, (store) => {
      assert.equal(store.schemaVersion, 2);
      assert.equal(store.epoch, 2);
    });
    const inspected = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(
        (
          inspected
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string }
        ).value,
        "2",
      );
    } finally {
      inspected.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("configuration cannot lift the four-child global cap or safe payload ceiling", () => {
  const dir = tempDir();
  try {
    assert.throws(
      () => new RelayStore(dir, { maxInstances: 5 }),
      CapacityError,
    );
    assert.throws(
      () => new RelayStore(dir, { maxBodyBytes: 512 * 1024 }),
      CapacityError,
    );
    assert.throws(
      () => new RelayStore(dir, { maxDiskBytes: 1024 }),
      CapacityError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("physical page ceiling reserves room for an entire worst-case rollback journal", () => {
  const budget = 100 * 1024 * 1024;
  const pages = physicalPageCeiling(budget, 4096);
  assert.ok(pages > 12000);
  assert.ok(pages * (2 * 4096 + 8) + 128 * 1024 <= budget);
  assert.throws(() => physicalPageCeiling(1000, 4096), CapacityError);
  assert.throws(() => physicalPageCeiling(budget, 8192), CapacityError);
});

test("physical DB and journal stay within a small cap when a commit runs out of pages", () => {
  const dir = tempDir();
  const budget = 1024 * 1024;
  const footprint = () =>
    [
      "owner.sqlite",
      "owner.sqlite-journal",
      "relay-store.sqlite",
      "relay-store.sqlite-journal",
    ].reduce(
      (total, name) =>
        total +
        (existsSync(join(dir, name))
          ? statSync(join(dir, name)).blocks * 512
          : 0),
      0,
    );
  try {
    const store = new RelayStore(dir, { maxDiskBytes: budget });
    try {
      const b = reserveOne(store, "g", "b");
      let admitted = 0;
      for (let i = 0; i < 50; i++) {
        try {
          store.enqueue({
            sender: parentIdentity("g"),
            recipient: { instanceId: b.instanceId },
            kind: "message",
            bodyUtf8: "x".repeat(60 * 1024),
            idempotencyKey: `k${i}`,
          });
          admitted++;
          assert.ok(
            footprint() <= budget,
            `physical footprint ${footprint()} exceeds budget`,
          );
        } catch (error) {
          assert.ok(error instanceof CapacityError, String(error));
          break;
        }
      }
      assert.ok(admitted > 0 && admitted < 50);
      assert.equal(
        store.listUnresolvedForRecipient(b.instanceId).length,
        admitted,
      );
      assert.ok(footprint() <= budget);
    } finally {
      store.close();
    }
    const reopened = new RelayStore(dir, { maxDiskBytes: budget });
    reopened.close();
    assert.ok(footprint() <= budget);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startup refuses untrusted WAL sidecars instead of silently converting them", () => {
  const dir = tempDir();
  try {
    withStore(dir, () => {});
    writeFileSync(join(dir, "relay-store.sqlite-wal"), "untrusted");
    assert.throws(() => new RelayStore(dir), /Untrusted SQLite sidecar/);
    rmSync(join(dir, "relay-store.sqlite-wal"));
    symlinkSync(
      join(dir, "relay-store.sqlite"),
      join(dir, "relay-store.sqlite-journal"),
    );
    assert.throws(() => new RelayStore(dir), /Untrusted SQLite sidecar/);
    rmSync(join(dir, "relay-store.sqlite-journal"));
    withStore(dir, (store) => assert.equal(store.epoch, 2));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store directory and database file are created user-private (0700/0600)", () => {
  const dir = tempDir();
  try {
    withStore(dir, () => {});
    const dirStat = statSync(dir);
    assert.equal(dirStat.mode & 0o777, 0o700);
    const dbStat = statSync(join(dir, "relay-store.sqlite"));
    assert.equal(dbStat.mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Registry: reservation, aliasing, admission cap
// ---------------------------------------------------------------------------

test("reserve enforces the shared global admission cap across groups", () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      reserveOne(store, "group-a", "one");
      reserveOne(store, "group-a", "two");
      reserveOne(store, "group-b", "three");
      reserveOne(store, "group-b", "four");
      assert.throws(() => reserveOne(store, "group-c", "five"), CapacityError);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("alias is immutable and group-scoped: same alias collides within a group, not across groups", () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      reserveOne(store, "group-a", "worker");
      assert.throws(
        () => reserveOne(store, "group-a", "worker"),
        AliasConflictError,
      );
      // Same alias text in a different group is a distinct reservation.
      const other = reserveOne(store, "group-b", "worker");
      assert.equal(other.alias, "worker");
      assert.equal(other.groupId, "group-b");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reserve is idempotent by (groupId, idempotencyKey) and rejects a conflicting reuse", () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const first = store.reserve({
        groupId: "group-a",
        alias: "worker",
        loadout: { model: "x" },
        idempotencyKey: "k1",
      });
      const retry = store.reserve({
        groupId: "group-a",
        alias: "worker",
        loadout: { model: "x" },
        idempotencyKey: "k1",
      });
      assert.equal(retry.instanceId, first.instanceId);

      assert.throws(
        () =>
          store.reserve({
            groupId: "group-a",
            alias: "different-alias",
            loadout: { model: "x" },
            idempotencyKey: "k1",
          }),
        IdempotencyConflictError,
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reserve fails closed on a missing or malformed loadout", () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      assert.throws(
        () =>
          store.reserve({
            groupId: "group-a",
            alias: "worker",
            loadout: undefined,
          }),
        MalformedLoadoutError,
      );
      assert.throws(
        () =>
          store.reserve({
            groupId: "group-a",
            alias: "missing-field",
            loadout: { role: undefined },
          }),
        MalformedLoadoutError,
      );
      assert.throws(
        () =>
          store.reserve({
            groupId: "group-a",
            alias: "primitive",
            loadout: 42,
          }),
        MalformedLoadoutError,
      );
      assert.throws(
        () =>
          store.reserve({
            groupId: "group-a",
            alias: "wrong-group",
            loadout: { groupId: "group-b" },
          }),
        MalformedLoadoutError,
      );
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      assert.throws(
        () =>
          store.reserve({
            groupId: "group-a",
            alias: "worker",
            loadout: cyclic,
          }),
        MalformedLoadoutError,
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bounded loadout, result, keys and receipt evidence fail before exhausting storage", () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      assert.throws(
        () =>
          store.reserve({
            groupId: "g",
            alias: "big",
            loadout: { role: "x".repeat(65 * 1024) },
          }),
        MalformedLoadoutError,
      );
      assert.throws(
        () =>
          store.reserve({
            groupId: "g",
            alias: "x".repeat(300),
            loadout: { role: "worker" },
          }),
        MalformedLoadoutError,
      );
      const b = boundRecipient(store, "g", "b");
      assert.throws(
        () =>
          store.settleResult({
            instanceId: b.instanceId,
            expectedFence: b.fence,
            runId: "run-1",
            resultJson: { answer: "x".repeat(1024 * 1024) },
          }),
        /1 MiB/,
      );
      assert.throws(
        () =>
          store.enqueue({
            sender: parentIdentity("g"),
            recipient: { instanceId: b.instanceId },
            kind: "message",
            bodyUtf8: "hi",
            idempotencyKey: "k".repeat(300),
          }),
        InvalidStateError,
      );
      const m = store.enqueue({
        sender: parentIdentity("g"),
        recipient: { instanceId: b.instanceId },
        kind: "message",
        bodyUtf8: "hi",
        idempotencyKey: "k",
      });
      const claimed = store.claim(b.instanceId, b.fence);
      assert.ok("attemptId" in claimed);
      if ("attemptId" in claimed)
        store.nativeAttemptStarted(
          m.messageId,
          claimed.attemptId,
          b.fence,
          "native-session-1",
          "run-1",
        );
      assert.throws(
        () =>
          store.markDelivered(
            m.messageId,
            "native-session-1",
            "x".repeat(5000),
          ),
        /4 KiB/,
      );
      assert.equal(
        store.getEnvelope(m.messageId)?.status,
        "native_attempt_started",
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bind and release require the caller's current fence; a stale writer is rejected", () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const reserved = reserveOne(store, "group-a", "worker");
      const bound = store.bind({
        instanceId: reserved.instanceId,
        expectedFence: reserved.fence,
        runId: "run-1",
      });
      assert.equal(bound.status, "bound");
      assert.ok(bound.fence > reserved.fence);

      // The old fence token is now stale.
      assert.throws(
        () =>
          store.bind({
            instanceId: reserved.instanceId,
            expectedFence: reserved.fence,
            runId: "run-2",
          }),
        FenceMismatchError,
      );

      const released = store.release({
        instanceId: reserved.instanceId,
        expectedFence: bound.fence,
        reason: "done",
      });
      assert.equal(released.status, "released");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit cancellation suspends pending messages atomically without deleting history", () => {
  const dir = tempDir();
  let id = "";
  try {
    withStore(dir, (store) => {
      const b = boundRecipient(store, "g", "b");
      id = b.instanceId;
      const accepted = ["one", "two"].map((bodyUtf8) =>
        store.enqueue({
          sender: parentIdentity("g"),
          recipient: { instanceId: b.instanceId },
          kind: "message",
          bodyUtf8,
          idempotencyKey: bodyUtf8,
        }),
      );
      store.claim(b.instanceId, b.fence);
      store.release({
        instanceId: b.instanceId,
        expectedFence: b.fence,
        reason: "user cancel",
        cancelled: true,
      });
      for (const message of accepted) {
        assert.equal(store.getEnvelope(message.messageId)?.status, "suspended");
        assert.equal(
          store.getReceipts(message.messageId).at(-1)?.detail instanceof Object,
          true,
        );
      }
    });
    withStore(dir, (store) => {
      assert.equal(store.listUnresolvedForRecipient(id).length, 2);
      assert.equal(store.getInstance(id)?.status, "released");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveByAlias is scoped to the group and never leaks across groups", () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const inA = reserveOne(store, "group-a", "worker");
      reserveOne(store, "group-b", "other");
      assert.equal(
        store.resolveByAlias("group-a", "worker")?.instanceId,
        inA.instanceId,
      );
      assert.equal(store.resolveByAlias("group-b", "worker"), undefined);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Restart reconciliation
// ---------------------------------------------------------------------------

test("a bound instance becomes unknown after a restart, and the epoch advances", () => {
  const dir = tempDir();
  try {
    let instanceId = "";
    let fence = 0;
    withStore(dir, (store) => {
      const reserved = reserveOne(store, "group-a", "worker");
      const bound = store.bind({
        instanceId: reserved.instanceId,
        expectedFence: reserved.fence,
        runId: "run-1",
      });
      instanceId = bound.instanceId;
      fence = bound.fence;
      assert.equal(store.epoch, 1);
    });

    withStore(dir, (store) => {
      assert.equal(store.epoch, 2);
      const reloaded = store.getInstance(instanceId);
      assert.equal(reloaded?.status, "unknown");
      // The instance keeps its fence (no writer implicitly reauthorized); an
      // authorized reconciler must present it to reattach or release.
      assert.equal(reloaded?.fence, fence);
      assert.throws(
        () => store.bind({ instanceId, expectedFence: fence, runId: "run-2" }),
        InvalidStateError,
      );
      assert.throws(
        () =>
          store.release({
            instanceId,
            expectedFence: fence,
            reason: "stale PID",
          }),
        InvalidStateError,
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Mailbox: enqueue, idempotency, ordering, permissions/ACL
// ---------------------------------------------------------------------------

function parentIdentity(groupId: string): CallerIdentity {
  return { role: "parent", groupId };
}

test("enqueue authenticates by caller identity/fence, not a message-supplied sender field", () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const a = reserveOne(store, "group-a", "a");
      const b = reserveOne(store, "group-a", "b");
      assert.throws(
        () =>
          store.enqueue({
            sender: {
              role: "instance",
              groupId: "group-a",
              instanceId: a.instanceId,
              fence: 999,
            },
            recipient: { instanceId: b.instanceId },
            kind: "message",
            bodyUtf8: "hi",
            idempotencyKey: "k1",
          }),
        FenceMismatchError,
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("child send requires a bound writer and an immutable recipient allowlist", () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const sender = store.reserve({
        groupId: "g",
        alias: "sender",
        loadout: { allowedRecipients: ["yes"] },
      });
      const yes = reserveOne(store, "g", "yes");
      const no = reserveOne(store, "g", "no");
      const write = (fence: number, recipientId: string) =>
        store.enqueue({
          sender: {
            role: "instance",
            groupId: "g",
            instanceId: sender.instanceId,
            fence,
          },
          recipient: { instanceId: recipientId },
          kind: "message",
          bodyUtf8: "text",
          idempotencyKey: "k",
        });
      assert.throws(
        () => write(sender.fence, yes.instanceId),
        FenceMismatchError,
      );
      const bound = store.bind({
        instanceId: sender.instanceId,
        expectedFence: sender.fence,
        runId: "r",
      });
      assert.throws(() => write(bound.fence, no.instanceId), InvalidStateError);
      assert.equal(write(bound.fence, yes.instanceId).status, "accepted");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lost send response across relay restart returns original acceptance without authorizing new writes", () => {
  const dir = tempDir();
  let senderId = "",
    senderFence = 0,
    targetId = "",
    originalId = "";
  try {
    withStore(dir, (store) => {
      const reserved = store.reserve({
        groupId: "g",
        alias: "sender",
        loadout: { allowedRecipients: ["target"] },
      });
      const sender = store.bind({
        instanceId: reserved.instanceId,
        expectedFence: reserved.fence,
        runId: "r",
      });
      const target = reserveOne(store, "g", "target");
      senderId = sender.instanceId;
      senderFence = sender.fence;
      targetId = target.instanceId;
      originalId = store.enqueue({
        sender: {
          role: "instance",
          groupId: "g",
          instanceId: senderId,
          fence: senderFence,
        },
        recipient: { instanceId: targetId },
        kind: "message",
        bodyUtf8: "committed",
        idempotencyKey: "k",
      }).messageId;
    });
    withStore(dir, (store) => {
      const sender = {
        role: "instance" as const,
        groupId: "g",
        instanceId: senderId,
        fence: senderFence,
      };
      assert.equal(store.getInstance(senderId)?.status, "unknown");
      assert.equal(
        store.enqueue({
          sender,
          recipient: { instanceId: targetId },
          kind: "message",
          bodyUtf8: "committed",
          idempotencyKey: "k",
        }).messageId,
        originalId,
      );
      assert.throws(
        () =>
          store.enqueue({
            sender,
            recipient: { instanceId: targetId },
            kind: "message",
            bodyUtf8: "new",
            idempotencyKey: "new-key",
          }),
        FenceMismatchError,
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enqueue resolves recipients within the sender's group only; cross-group addressing fails", () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      reserveOne(store, "group-a", "a");
      const outsider = reserveOne(store, "group-b", "outsider");
      assert.throws(
        () =>
          store.enqueue({
            sender: parentIdentity("group-a"),
            recipient: { instanceId: outsider.instanceId },
            kind: "message",
            bodyUtf8: "hi",
            idempotencyKey: "k1",
          }),
        /Recipient does not exist/,
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enqueue idempotency: identical retry returns the original message; conflicting retry errors", () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const b = reserveOne(store, "group-a", "b");
      const first = store.enqueue({
        sender: parentIdentity("group-a"),
        recipient: { instanceId: b.instanceId },
        kind: "message",
        bodyUtf8: "hello",
        idempotencyKey: "k1",
      });
      const retry = store.enqueue({
        sender: parentIdentity("group-a"),
        recipient: { instanceId: b.instanceId },
        kind: "message",
        bodyUtf8: "hello",
        idempotencyKey: "k1",
      });
      assert.equal(retry.messageId, first.messageId);
      assert.equal(retry.recipientSeq, first.recipientSeq);
      assert.throws(
        () =>
          store.enqueue({
            sender: parentIdentity("group-a"),
            recipient: { instanceId: b.instanceId },
            kind: "question",
            bodyUtf8: "hello",
            idempotencyKey: "k1",
          }),
        IdempotencyConflictError,
      );

      assert.throws(
        () =>
          store.enqueue({
            sender: parentIdentity("group-a"),
            recipient: { instanceId: b.instanceId },
            kind: "message",
            bodyUtf8: "different body",
            idempotencyKey: "k1",
          }),
        IdempotencyConflictError,
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("idempotency compares exact UTF-8 bytes, including NULs", () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const b = reserveOne(store, "g", "b");
      store.enqueue({
        sender: parentIdentity("g"),
        recipient: { instanceId: b.instanceId },
        kind: "message",
        bodyUtf8: "",
        idempotencyKey: "k",
      });
      assert.throws(
        () =>
          store.enqueue({
            sender: parentIdentity("g"),
            recipient: { instanceId: b.instanceId },
            kind: "message",
            bodyUtf8: "\0\0",
            idempotencyKey: "k",
          }),
        IdempotencyConflictError,
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enqueue assigns a strictly increasing per-recipient sequence", () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const b = reserveOne(store, "group-a", "b");
      const m1 = store.enqueue({
        sender: parentIdentity("group-a"),
        recipient: { instanceId: b.instanceId },
        kind: "message",
        bodyUtf8: "one",
        idempotencyKey: "k1",
      });
      const m2 = store.enqueue({
        sender: parentIdentity("group-a"),
        recipient: { instanceId: b.instanceId },
        kind: "message",
        bodyUtf8: "two",
        idempotencyKey: "k2",
      });
      assert.equal(m1.recipientSeq, 1);
      assert.equal(m2.recipientSeq, 2);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enqueue rejects a body larger than the configured limit", () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const b = reserveOne(store, "group-a", "b");
      assert.throws(
        () =>
          store.enqueue({
            sender: parentIdentity("group-a"),
            recipient: { instanceId: b.instanceId },
            kind: "message",
            bodyUtf8: "x".repeat(65 * 1024),
            idempotencyKey: "k1",
          }),
        /exceeding the/,
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backpressure: per-group unresolved item cap and per-user byte budget reject new enqueues", () => {
  const dir = tempDir();
  try {
    const store = new RelayStore(dir, {
      maxUnresolvedPerGroup: 2,
      maxTotalBytes: 40,
    });
    try {
      const b = reserveOne(store, "group-a", "b");
      store.enqueue({
        sender: parentIdentity("group-a"),
        recipient: { instanceId: b.instanceId },
        kind: "message",
        bodyUtf8: "one",
        idempotencyKey: "k1",
      });
      store.enqueue({
        sender: parentIdentity("group-a"),
        recipient: { instanceId: b.instanceId },
        kind: "message",
        bodyUtf8: "two",
        idempotencyKey: "k2",
      });
      assert.throws(
        () =>
          store.enqueue({
            sender: parentIdentity("group-a"),
            recipient: { instanceId: b.instanceId },
            kind: "message",
            bodyUtf8: "three",
            idempotencyKey: "k3",
          }),
        CapacityError,
      );
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Claim / native-attempt boundary / never-redeliver-after-native-attempt
// ---------------------------------------------------------------------------

test("discarded history still consumes physical payload bytes until safely pruned", () => {
  const dir = tempDir();
  try {
    const store = new RelayStore(dir, { maxTotalBytes: 8 });
    try {
      const b = reserveOne(store, "g", "b");
      const first = store.enqueue({
        sender: parentIdentity("g"),
        recipient: { instanceId: b.instanceId },
        kind: "message",
        bodyUtf8: "12345678",
        idempotencyKey: "a",
      });
      store.discard(first.messageId, "user requested cleanup");
      assert.throws(
        () =>
          store.enqueue({
            sender: parentIdentity("g"),
            recipient: { instanceId: b.instanceId },
            kind: "message",
            bodyUtf8: "1",
            idempotencyKey: "b",
          }),
        CapacityError,
      );
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("payload backpressure counts UTF-8 bytes rather than SQLite text characters", () => {
  const dir = tempDir();
  try {
    const store = new RelayStore(dir, { maxTotalBytes: 5 });
    try {
      const recipient = reserveOne(store, "g", "child");
      store.enqueue({
        sender: parentIdentity("g"),
        recipient: { instanceId: recipient.instanceId },
        kind: "message",
        bodyUtf8: "你好",
        idempotencyKey: "a",
      });
      assert.fail("UTF-8 over budget should have been rejected");
    } catch (error) {
      if (!(error instanceof CapacityError)) throw error;
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unstarted claim (no native attempt) is safely reclaimed and redelivered with the same message ID", async () => {
  const dir = tempDir();
  try {
    const store = new RelayStore(dir, { claimLeaseMs: 1 });
    try {
      const b = boundRecipient(store, "group-a", "b");
      const enqueued = store.enqueue({
        sender: parentIdentity("group-a"),
        recipient: { instanceId: b.instanceId },
        kind: "message",
        bodyUtf8: "hi",
        idempotencyKey: "k1",
      });
      const claim1 = store.claim(b.instanceId, b.fence);
      assert.ok("attemptId" in claim1);
      // Wait for the lease, rather than assuming two SQLite calls take >1ms.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const claim2 = store.claim(b.instanceId, b.fence);
      assert.ok("attemptId" in claim2);
      if ("attemptId" in claim2) {
        assert.equal(claim2.envelope.messageId, enqueued.messageId);
        assert.notEqual(
          claim2.attemptId,
          (claim1 as { attemptId: string }).attemptId,
        );
      }
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claim blocks a message already claimed by another bridge (lease still active)", () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const b = boundRecipient(store, "group-a", "b");
      store.enqueue({
        sender: parentIdentity("group-a"),
        recipient: { instanceId: b.instanceId },
        kind: "message",
        bodyUtf8: "hi",
        idempotencyKey: "k1",
      });
      store.claim(b.instanceId, b.fence);
      assert.throws(
        () => store.claim(b.instanceId, b.fence),
        ClaimBlockedError,
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("once native_attempt_started is committed, the message is never redelivered — even after a restart", () => {
  const dir = tempDir();
  let messageId = "";
  let recipientId = "";
  let recipientFence = 0;
  try {
    withStore(dir, (store) => {
      const b = boundRecipient(store, "group-a", "b");
      recipientId = b.instanceId;
      recipientFence = b.fence;
      const enqueued = store.enqueue({
        sender: parentIdentity("group-a"),
        recipient: { instanceId: b.instanceId },
        kind: "message",
        bodyUtf8: "hi",
        idempotencyKey: "k1",
      });
      messageId = enqueued.messageId;
      const claimed = store.claim(b.instanceId, b.fence);
      assert.ok("attemptId" in claimed);
      if ("attemptId" in claimed) {
        store.nativeAttemptStarted(
          messageId,
          claimed.attemptId,
          b.fence,
          "native-session-1",
          "run-1",
        );
      }
      // Bridge "crashes" here — no delivered/processed evidence was ever recorded.
    });

    // Simulate the relay restarting.
    withStore(dir, (store) => {
      const envelope = store.getEnvelope(messageId);
      assert.equal(envelope?.status, "needs_reconciliation");
      assert.throws(
        () => store.claim(recipientId, recipientFence),
        FenceMismatchError,
      );

      const receipts = store.getReceipts(messageId).map((r) => r.event);
      assert.deepEqual(receipts, [
        "accepted",
        "delivery_claimed",
        "native_attempt_started",
        "needs_reconciliation",
      ]);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("head-of-line blocking: an uncertain message blocks claiming a later message to the same recipient", () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const b = boundRecipient(store, "group-a", "b");
      const m1 = store.enqueue({
        sender: parentIdentity("group-a"),
        recipient: { instanceId: b.instanceId },
        kind: "message",
        bodyUtf8: "first",
        idempotencyKey: "k1",
      });
      store.enqueue({
        sender: parentIdentity("group-a"),
        recipient: { instanceId: b.instanceId },
        kind: "message",
        bodyUtf8: "second",
        idempotencyKey: "k2",
      });

      const claimed = store.claim(b.instanceId, b.fence);
      assert.ok("attemptId" in claimed);
      if ("attemptId" in claimed) {
        assert.equal(claimed.envelope.messageId, m1.messageId);
        store.nativeAttemptStarted(
          m1.messageId,
          claimed.attemptId,
          b.fence,
          "native-session-1",
          "run-1",
        );
      }

      // The first message is now uncertain; the second, later message must
      // not be claimable ahead of it.
      assert.throws(
        () => store.claim(b.instanceId, b.fence),
        ClaimBlockedError,
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a released or unknown recipient cannot claim or start native input using an old attempt", () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const b = boundRecipient(store, "g", "b");
      const m = store.enqueue({
        sender: parentIdentity("g"),
        recipient: { instanceId: b.instanceId },
        kind: "message",
        bodyUtf8: "hi",
        idempotencyKey: "k",
      });
      const claim = store.claim(b.instanceId, b.fence);
      assert.ok("attemptId" in claim);
      if (!("attemptId" in claim)) return;
      assert.throws(
        () =>
          store.nativeAttemptStarted(
            m.messageId,
            claim.attemptId,
            b.fence,
            "wrong-session",
            "run-1",
          ),
        FenceMismatchError,
      );
      assert.throws(
        () =>
          store.nativeAttemptStarted(
            m.messageId,
            claim.attemptId,
            b.fence,
            "native-session-1",
            "wrong-run",
          ),
        FenceMismatchError,
      );
      store.release({
        instanceId: b.instanceId,
        expectedFence: b.fence,
        reason: "verified terminal",
      });
      assert.throws(
        () => store.claim(b.instanceId, b.fence),
        FenceMismatchError,
      );
      assert.throws(
        () =>
          store.nativeAttemptStarted(
            m.messageId,
            claim.attemptId,
            b.fence,
            "native-session-1",
            "run-1",
          ),
        FenceMismatchError,
      );
    });
    withStore(dir, (store) => {
      const b = store.resolveByAlias("g", "b")!;
      assert.throws(
        () => store.claim(b.instanceId, b.fence),
        FenceMismatchError,
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("markDelivered/markProcessed require prior native_attempt_started evidence", () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const b = boundRecipient(store, "group-a", "b");
      const enqueued = store.enqueue({
        sender: parentIdentity("group-a"),
        recipient: { instanceId: b.instanceId },
        kind: "message",
        bodyUtf8: "hi",
        idempotencyKey: "k1",
      });
      assert.throws(() =>
        store.markDelivered(enqueued.messageId, "native-session-1"),
      );
      assert.throws(() => store.markProcessed(enqueued.messageId));

      const claimed = store.claim(b.instanceId, b.fence);
      assert.ok("attemptId" in claimed);
      if ("attemptId" in claimed) {
        store.nativeAttemptStarted(
          enqueued.messageId,
          claimed.attemptId,
          b.fence,
          "native-session-1",
          "run-1",
        );
      }
      assert.throws(
        () => store.markSuspended(enqueued.messageId, "oops"),
        InvalidStateError,
      );
      assert.throws(
        () => store.markDelivered(enqueued.messageId, "another-session"),
        FenceMismatchError,
      );
      store.markDelivered(enqueued.messageId, "native-session-1");
      assert.throws(
        () => store.markDelivered(enqueued.messageId, "native-session-1"),
        InvalidStateError,
      );
      assert.throws(
        () => store.claim(b.instanceId, b.fence),
        ClaimBlockedError,
      );
      store.markProcessed(enqueued.messageId, { ack: true });
      assert.throws(
        () => store.markDelivered(enqueued.messageId, "native-session-1"),
        InvalidStateError,
      );
      assert.throws(
        () => store.markProcessed(enqueued.messageId),
        InvalidStateError,
      );
      assert.deepEqual(store.claim(b.instanceId, b.fence), { none: true });
      assert.equal(store.getEnvelope(enqueued.messageId)?.status, "processed");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Question / reply correlation
// ---------------------------------------------------------------------------

test("pre-native suspension parks the head until an explicit resume", () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const b = boundRecipient(store, "g", "b");
      const m = store.enqueue({
        sender: parentIdentity("g"),
        recipient: { instanceId: b.instanceId },
        kind: "message",
        bodyUtf8: "hi",
        idempotencyKey: "k",
      });
      store.markSuspended(m.messageId, "receiver offline");
      assert.throws(
        () => store.claim(b.instanceId, b.fence),
        ClaimBlockedError,
      );
      store.resumeSuspended(m.messageId, "authorized restart");
      assert.ok("attemptId" in store.claim(b.instanceId, b.fence));
      assert.deepEqual(
        store.getReceipts(m.messageId).map(({ event }) => event),
        ["accepted", "suspended", "pending", "delivery_claimed"],
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reply requires inReplyTo and is idempotent/conflict-checked like any other enqueue", () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const childReserved = store.reserve({
        groupId: "group-a",
        alias: "child",
        loadout: { allowedRecipients: ["__parent__"] },
      });
      const child = store.bind({
        instanceId: childReserved.instanceId,
        expectedFence: childReserved.fence,
        runId: "run-1",
      });
      const question = store.enqueue({
        sender: {
          role: "instance",
          groupId: "group-a",
          instanceId: child.instanceId,
          fence: child.fence,
        },
        recipient: { parent: true },
        kind: "question",
        bodyUtf8: "may I proceed?",
        idempotencyKey: "q1",
      });

      assert.equal(
        store.listParentQuestions("group-a")[0]?.messageId,
        question.messageId,
      );
      assert.equal(
        store.getParentQuestionReply("group-a", question.messageId),
        undefined,
      );
      const siblingReserved = store.reserve({
        groupId: "group-a",
        alias: "sibling",
        loadout: { allowedRecipients: ["child"] },
      });
      const sibling = store.bind({
        instanceId: siblingReserved.instanceId,
        expectedFence: siblingReserved.fence,
        runId: "r",
      });
      assert.throws(
        () =>
          store.enqueue({
            sender: {
              role: "instance",
              groupId: "group-a",
              instanceId: sibling.instanceId,
              fence: sibling.fence,
            },
            recipient: { instanceId: child.instanceId },
            kind: "reply",
            bodyUtf8: "fake answer",
            idempotencyKey: "spoof",
            inReplyTo: question.messageId,
          }),
        InvalidStateError,
      );

      assert.throws(
        () =>
          store.enqueue({
            sender: parentIdentity("group-a"),
            recipient: { instanceId: child.instanceId },
            kind: "reply",
            bodyUtf8: "yes",
            idempotencyKey: "r1",
          }),
        /inReplyTo/,
      );

      const reply = store.enqueue({
        sender: parentIdentity("group-a"),
        recipient: { instanceId: child.instanceId },
        kind: "reply",
        bodyUtf8: "yes",
        idempotencyKey: "r1",
        inReplyTo: question.messageId,
      });
      assert.equal(
        store.getEnvelope(reply.messageId)?.inReplyTo,
        question.messageId,
      );
      assert.equal(
        store.getParentQuestionReply("group-a", question.messageId)?.messageId,
        reply.messageId,
      );
      assert.equal(
        store.getParentQuestionReply("unrelated", question.messageId),
        undefined,
      );

      // A conflicting second reply to the same question with the same key errors.
      assert.throws(
        () =>
          store.enqueue({
            sender: parentIdentity("group-a"),
            recipient: { instanceId: child.instanceId },
            kind: "reply",
            bodyUtf8: "no, wait",
            idempotencyKey: "r1",
            inReplyTo: question.messageId,
          }),
        IdempotencyConflictError,
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Result inbox: idempotent, fenced, durable across restarts
// ---------------------------------------------------------------------------

test("settleResult is idempotent per (instanceId, runId) and fenced to the current writer", () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const reserved = reserveOne(store, "group-a", "worker");
      const bound = store.bind({
        instanceId: reserved.instanceId,
        expectedFence: reserved.fence,
        runId: "run-1",
      });

      assert.throws(
        () =>
          store.settleResult({
            instanceId: bound.instanceId,
            expectedFence: bound.fence,
            runId: "fake-run",
            resultJson: { ok: true },
          }),
        FenceMismatchError,
      );
      const first = store.settleResult({
        instanceId: bound.instanceId,
        expectedFence: bound.fence,
        runId: "run-1",
        resultJson: { ok: true },
      });
      const retry = store.settleResult({
        instanceId: bound.instanceId,
        expectedFence: bound.fence,
        runId: "run-1",
        resultJson: { ok: true },
      });
      assert.equal(retry.resultId, first.resultId);

      assert.throws(
        () =>
          store.settleResult({
            instanceId: bound.instanceId,
            expectedFence: bound.fence,
            runId: "run-1",
            resultJson: { ok: false },
          }),
        IdempotencyConflictError,
      );

      assert.throws(
        () =>
          store.settleResult({
            instanceId: bound.instanceId,
            expectedFence: 999,
            runId: "run-2",
            resultJson: { ok: true },
          }),
        FenceMismatchError,
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collect and archive are distinct, atomic and auditable", () => {
  const dir = tempDir();
  let resultId = "";
  try {
    withStore(dir, (store) => {
      const reserved = reserveOne(store, "g", "worker");
      const bound = store.bind({
        instanceId: reserved.instanceId,
        expectedFence: reserved.fence,
        runId: "r",
      });
      resultId = store.settleResult({
        instanceId: bound.instanceId,
        expectedFence: bound.fence,
        runId: "r",
        resultJson: { answer: 42 },
      }).resultId;
      assert.equal(store.listResults("g")[0]?.collectedAt, null);
      store.markResultCollected(resultId, "parent:g");
      store.markResultCollected(resultId, "parent:g");
      assert.notEqual(store.listResults("g")[0]?.collectedAt, null);
      assert.deepEqual(
        store.listResultAudit(resultId).map(({ event }) => event),
        ["collected"],
      );
      store.archiveResult(resultId, "explicit cleanup", "parent:g");
      assert.deepEqual(store.listResults("g"), []);
    });
    withStore(dir, (store) => {
      assert.deepEqual(
        store
          .listResultAudit(resultId)
          .map(({ event, detail }) => ({ event, detail })),
        [
          { event: "collected", detail: { actorIdentity: "parent:g" } },
          {
            event: "archived",
            detail: { actorIdentity: "parent:g", reason: "explicit cleanup" },
          },
        ],
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settled results survive a restart and remain listable for their group", () => {
  const dir = tempDir();
  let groupId = "group-a";
  try {
    withStore(dir, (store) => {
      const reserved = reserveOne(store, groupId, "worker");
      const bound = store.bind({
        instanceId: reserved.instanceId,
        expectedFence: reserved.fence,
        runId: "run-1",
      });
      store.settleResult({
        instanceId: bound.instanceId,
        expectedFence: bound.fence,
        runId: "run-1",
        resultJson: { summary: "done" },
      });
    });

    withStore(dir, (store) => {
      const results = store.listResults(groupId);
      assert.equal(results.length, 1);
      assert.deepEqual(results[0]?.result, { summary: "done" });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
