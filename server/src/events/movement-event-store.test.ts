import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildMovementEvent } from "@foundry-local-api/shared";
import { MovementEventStore } from "./movement-event-store.js";
const event = (id: string, tokenId = "t") =>
  buildMovementEvent({
    eventId: id,
    sceneId: "s",
    tokenId,
    userId: "u",
    timestamp: 1,
    waypoints: [
      { x: 0, y: 0 },
      { x: 3, y: 0 },
    ],
    regions: [],
  });
void describe("durable movement event store", () => {
  void it("persists generation, exact expiry ranges, filters, and dedup beyond retention", () => {
    const path = join(mkdtempSync(join(tmpdir(), "moves-")), "events.json");
    const first = new MovementEventStore(path, 2);
    const a = first.append(event("a")),
      again = first.append(event("a"));
    assert.equal(a.sequence, again.sequence);
    first.append(event("b", "other"));
    first.append(event("c"));
    const expired = first.query({ cursor: first.cursor(0) });
    assert.equal(expired.gap?.reason, "expired");
    assert.equal(expired.gap?.missingRangesComplete, true);
    assert.deepEqual(expired.gap?.missingRanges, [{ fromSequence: 1, toSequence: 1 }]);
    assert.deepEqual(
      first.query({ tokenId: "other" }).events.map((e) => e.eventId),
      ["b"],
    );
    assert.deepEqual(first.query({ sceneId: "wrong", userId: "wrong" }).events, []);
    assert.deepEqual(
      first.query({ eventType: "token_movement", movementField: "x" }).events.map((e) => e.eventId),
      ["b", "c"],
    );
    const restarted = new MovementEventStore(path, 2);
    const page = restarted.query({ cursor: first.cursor(a.sequence) });
    assert.equal(page.gap, undefined);
    assert.equal(page.generation, first.generation);
    assert.deepEqual(
      page.events.map((e) => e.eventId),
      ["b", "c"],
    );
    const replay = restarted.query({ cursor: page.nextCursor });
    assert.deepEqual(replay.events, []);
    assert.equal(restarted.append(event("a")).sequence, 1);
    assert.throws(() => restarted.append(event("a", "changed")), /conflicting content/);
    const otherGeneration = restarted.query({ cursor: `lost-generation:99` });
    assert.equal(otherGeneration.gap?.reconciliationRequired, true);
    assert.equal(otherGeneration.gap?.missingRangesComplete, false);
    assert.deepEqual(otherGeneration.gap?.missingRanges, []);
  });

  void it("fails explicitly for corrupt, invalid-schema, and unreadable stores", () => {
    const directory = mkdtempSync(join(tmpdir(), "moves-corrupt-"));
    const corrupt = join(directory, "corrupt.json");
    writeFileSync(corrupt, "{");
    assert.throws(() => new MovementEventStore(corrupt), /store is corrupt/);
    const invalid = join(directory, "invalid.json");
    writeFileSync(invalid, JSON.stringify({ nextSequence: "one", events: [] }));
    assert.throws(() => new MovementEventStore(invalid), /invalid schema/);
    assert.throws(() => new MovementEventStore(directory), /Unable to read/);
  });

  void it("migrates a valid legacy buffer once and then preserves its generation", () => {
    const path = join(mkdtempSync(join(tmpdir(), "moves-legacy-")), "events.json");
    writeFileSync(
      path,
      JSON.stringify({
        nextSequence: 2,
        events: [{ ...event("legacy"), sequence: 1 }],
      }),
    );
    const migrated = new MovementEventStore(path);
    assert.equal(migrated.query({}).events[0]?.eventId, "legacy");
    assert.equal(new MovementEventStore(path).generation, migrated.generation);
  });

  void it("persists generation before the first event", () => {
    const path = join(mkdtempSync(join(tmpdir(), "moves-empty-")), "events.json");
    const first = new MovementEventStore(path);
    assert.equal(new MovementEventStore(path).generation, first.generation);
  });

  void it("does not retain or acknowledge an event in memory when durable save fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "moves-save-failure-"));
    const path = join(directory, "events.json");
    const store = new MovementEventStore(path);
    const mutable = store as unknown as { path: string };
    mutable.path = directory;
    assert.throws(() => store.append(event("save-failure")));
    assert.deepEqual(store.query({}).events, []);
    mutable.path = path;
    assert.equal(store.append(event("save-failure")).sequence, 1);
    assert.deepEqual(
      new MovementEventStore(path).query({}).events.map(({ eventId }) => eventId),
      ["save-failure"],
    );
  });
});
