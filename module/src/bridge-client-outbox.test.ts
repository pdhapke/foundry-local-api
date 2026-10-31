import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BridgeEventOutbox,
  MOVEMENT_EVENT_NAME,
  isBridgeEventAcknowledgement,
  type BridgeOutboxStorage,
} from "./bridge-client-outbox.js";

class MemoryStorage implements BridgeOutboxStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class FailingStorage extends MemoryStorage {
  failWrites = false;
  override setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error("quota exceeded");
    super.setItem(key, value);
  }
}

const sender = { clientId: "player-tab", userId: "player-1", lane: "player" as const };
const movement = (eventId = "move-1") => ({
  eventId,
  sceneId: "scene-1",
  tokenId: "token-1",
  userId: "player-1",
  waypoints: [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ],
});

void describe("BridgeEventOutbox", () => {
  void it("persists disconnected movement and reloads it with sender identity", () => {
    const storage = new MemoryStorage();
    const first = new BridgeEventOutbox(sender, { storage, storageKey: "outbox", now: () => 10 });
    const queued = first.enqueue(MOVEMENT_EVENT_NAME, movement());
    assert.equal(first.diagnostics().queuedCount, 1);

    const reloaded = new BridgeEventOutbox(sender, {
      storage,
      storageKey: "outbox",
      now: () => 10,
    });
    assert.equal(reloaded.ready().length, 1);
    const message = reloaded.markAttempt(queued.deliveryId);
    assert.deepEqual(message?.delivery.sender, sender);
    assert.equal(message?.delivery.attempt, 1);
    assert.deepEqual(message?.payload, movement());
  });

  void it("removes an acknowledged event exactly once", () => {
    const outbox = new BridgeEventOutbox(sender, { now: () => 10 });
    const queued = outbox.enqueue(MOVEMENT_EVENT_NAME, movement());
    const acknowledgement = {
      kind: "event-ack" as const,
      deliveryId: queued.deliveryId,
      accepted: true as const,
      clientId: sender.clientId,
    };
    assert.equal(outbox.acknowledge(acknowledgement), true);
    assert.equal(outbox.acknowledge(acknowledgement), false);
    assert.equal(outbox.diagnostics().queuedCount, 0);
  });

  void it("rejects acknowledgements for another executing client", () => {
    const outbox = new BridgeEventOutbox(sender, { now: () => 10 });
    const queued = outbox.enqueue(MOVEMENT_EVENT_NAME, movement());
    assert.equal(
      outbox.acknowledge({
        kind: "event-ack",
        deliveryId: queued.deliveryId,
        accepted: true,
        clientId: "other-tab",
      }),
      false,
    );
    assert.equal(outbox.diagnostics().queuedCount, 1);
  });

  void it("deduplicates identical event replay and rejects changed reuse", () => {
    const outbox = new BridgeEventOutbox(sender, { now: () => 10 });
    const first = outbox.enqueue(MOVEMENT_EVENT_NAME, movement());
    const duplicate = outbox.enqueue(MOVEMENT_EVENT_NAME, {
      ...movement(),
      waypoints: movement().waypoints.map((point) => ({ ...point })),
    });
    assert.equal(duplicate.deliveryId, first.deliveryId);
    assert.equal(outbox.diagnostics().queuedCount, 1);
    assert.throws(
      () => outbox.enqueue(MOVEMENT_EVENT_NAME, { ...movement(), tokenId: "different" }),
      /reused with different payload/,
    );
  });

  void it("uses bounded exponential retry and exposes dead-letter state", () => {
    let now = 100;
    const outbox = new BridgeEventOutbox(sender, {
      now: () => now,
      maxAttempts: 3,
      baseRetryMs: 10,
      maxRetryMs: 15,
    });
    const queued = outbox.enqueue(MOVEMENT_EVENT_NAME, movement());
    assert.equal(outbox.markAttempt(queued.deliveryId)?.delivery.attempt, 1);
    assert.equal(outbox.ready().length, 0);
    now = 110;
    assert.equal(outbox.markAttempt(queued.deliveryId)?.delivery.attempt, 2);
    now = 125;
    assert.equal(outbox.markAttempt(queued.deliveryId)?.delivery.attempt, 3);
    assert.deepEqual(outbox.diagnostics(), {
      persistence: "memory-only",
      queuedCount: 0,
      deadLetterCount: 1,
      lastError: null,
    });
    assert.equal(outbox.markAttempt(queued.deliveryId), null);
  });

  void it("fails visibly on corrupt durable storage without deleting it", () => {
    const storage = new MemoryStorage();
    storage.values.set("outbox", "not-json");
    const outbox = new BridgeEventOutbox(sender, { storage, storageKey: "outbox" });
    assert.deepEqual(outbox.diagnostics(), {
      persistence: "unavailable",
      queuedCount: 0,
      deadLetterCount: 0,
      lastError: "storage-corrupt",
    });
    assert.equal(storage.values.get("outbox"), "not-json");
    assert.throws(
      () => outbox.enqueue(MOVEMENT_EVENT_NAME, movement()),
      /durable movement outbox is unavailable/i,
    );
  });

  void it("rolls back a disconnected enqueue when durable persistence fails", () => {
    const storage = new FailingStorage();
    const outbox = new BridgeEventOutbox(sender, { storage, storageKey: "outbox", now: () => 10 });
    storage.failWrites = true;
    assert.throws(
      () => outbox.enqueue(MOVEMENT_EVENT_NAME, movement()),
      /unable to persist movement event/i,
    );
    assert.deepEqual(outbox.diagnostics(), {
      persistence: "unavailable",
      queuedCount: 0,
      deadLetterCount: 0,
      lastError: "storage-write-failed",
    });
  });

  void it("does not forget an acknowledged record when removal cannot be persisted", () => {
    const storage = new FailingStorage();
    const outbox = new BridgeEventOutbox(sender, { storage, storageKey: "outbox", now: () => 10 });
    const queued = outbox.enqueue(MOVEMENT_EVENT_NAME, movement());
    storage.failWrites = true;
    assert.equal(
      outbox.acknowledge({
        kind: "event-ack",
        deliveryId: queued.deliveryId,
        accepted: true,
        clientId: sender.clientId,
      }),
      false,
    );
    assert.equal(outbox.diagnostics().queuedCount, 1);
    assert.equal(
      new BridgeEventOutbox(sender, { storage, storageKey: "outbox" }).ready().length,
      1,
    );
  });

  void it("fails closed when persisted records do not match the storage identity", () => {
    const storage = new MemoryStorage();
    const first = new BridgeEventOutbox(sender, { storage, storageKey: "outbox", now: () => 10 });
    first.enqueue(MOVEMENT_EVENT_NAME, movement());
    const otherSender = { ...sender, clientId: "other-tab" };
    const mismatched = new BridgeEventOutbox(otherSender, { storage, storageKey: "outbox" });
    assert.equal(mismatched.diagnostics().lastError, "storage-corrupt");
    assert.throws(
      () => mismatched.enqueue(MOVEMENT_EVENT_NAME, movement("move-2")),
      /durable movement outbox is unavailable/i,
    );
  });

  void it("accepts only the bounded acknowledgement wire shape", () => {
    assert.equal(
      isBridgeEventAcknowledgement({
        kind: "event-ack",
        deliveryId: "movement:player-1:move-1",
        accepted: true,
        clientId: "player-tab",
      }),
      true,
    );
    assert.equal(
      isBridgeEventAcknowledgement({ kind: "event-ack", deliveryId: "x", accepted: false }),
      false,
    );
    assert.equal(
      isBridgeEventAcknowledgement({
        kind: "event-ack",
        deliveryId: "movement:player-1:move-1",
        accepted: true,
        clientId: "player-tab",
        unexpected: "field",
      }),
      false,
    );
  });
});
