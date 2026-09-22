// Unit tests for Phase 26's FoundryEventBus — pure logic, no Express/
// supertest/bridge involved (see event-bus.ts's header comment).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FoundryEventBus } from "./event-bus.js";

void describe("FoundryEventBus", () => {
  void it("notifies subscribers on publish with the event name and payload", () => {
    const bus = new FoundryEventBus();
    const received: Array<{ event: string; payload: unknown }> = [];
    bus.subscribe((event, payload) => received.push({ event, payload }));

    bus.publish("createActor", { _id: "a1" });

    assert.deepEqual(received, [{ event: "createActor", payload: { _id: "a1" } }]);
  });

  void it("stops notifying a listener once unsubscribed", () => {
    const bus = new FoundryEventBus();
    const received: string[] = [];
    const unsubscribe = bus.subscribe((event) => received.push(event));

    bus.publish("createActor", {});
    unsubscribe();
    bus.publish("updateActor", {});

    assert.deepEqual(received, ["createActor"]);
  });

  void it("supports multiple independent subscribers", () => {
    const bus = new FoundryEventBus();
    const a: string[] = [];
    const b: string[] = [];
    bus.subscribe((event) => a.push(event));
    bus.subscribe((event) => b.push(event));

    bus.publish("createItem", {});

    assert.deepEqual(a, ["createItem"]);
    assert.deepEqual(b, ["createItem"]);
  });

  void it("recent() returns published events oldest-first, capped by an optional limit", () => {
    const bus = new FoundryEventBus();
    bus.publish("a", 1);
    bus.publish("b", 2);
    bus.publish("c", 3);

    assert.deepEqual(
      bus.recent().map((r) => r.event),
      ["a", "b", "c"],
    );
    assert.deepEqual(
      bus.recent(2).map((r) => r.event),
      ["b", "c"],
    );
  });

  void it("recent() with a limit larger than the buffer returns the whole buffer", () => {
    const bus = new FoundryEventBus();
    bus.publish("a", 1);

    assert.deepEqual(
      bus.recent(50).map((r) => r.event),
      ["a"],
    );
  });

  void it("caps the ring buffer at the configured capacity, dropping the oldest entries", () => {
    const bus = new FoundryEventBus(3);
    bus.publish("a", 1);
    bus.publish("b", 2);
    bus.publish("c", 3);
    bus.publish("d", 4);

    assert.deepEqual(
      bus.recent().map((r) => r.event),
      ["b", "c", "d"],
    );
  });

  void it("each recorded event carries a numeric timestamp", () => {
    const bus = new FoundryEventBus();
    const before = Date.now();
    bus.publish("createActor", {});
    const after = Date.now();

    const [record] = bus.recent();
    assert.ok(record);
    assert.ok(record.timestamp >= before && record.timestamp <= after);
  });
});
