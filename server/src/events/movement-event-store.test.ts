import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    assert.deepEqual(MovementEventStore.diagnose(invalid).issueCodes, ["STORE_SCHEMA_MISMATCH"]);
    assert.throws(() => new MovementEventStore(directory), /Unable to read/);

    assert.deepEqual(MovementEventStore.diagnose(corrupt).issueCodes, ["STORE_INVALID_JSON"]);
    assert.equal(readFileSync(corrupt, "utf8"), "{");
    assert.deepEqual(MovementEventStore.diagnose(corrupt, false).issueCodes, [
      "STORE_NOT_CONFIGURED",
    ]);
    assert.deepEqual(MovementEventStore.diagnose(directory).issueCodes, ["STORE_FILE_UNREADABLE"]);

    const unsupported = join(directory, "unsupported.json");
    writeFileSync(unsupported, JSON.stringify({ version: 99, events: [] }));
    assert.deepEqual(MovementEventStore.diagnose(unsupported).issueCodes, [
      "STORE_UNSUPPORTED_VERSION",
    ]);

    const healthyPath = join(directory, "healthy.json");
    const store = new MovementEventStore(healthyPath);
    store.append(event("diagnostic-event"));
    const healthy = MovementEventStore.diagnose(healthyPath);
    assert.equal(healthy.valid, true);
    assert.equal(healthy.eventCount, 1);
    assert.equal(MovementEventStore.diagnose(healthyPath, true, false).runtimeAvailable, false);
    assert.deepEqual(MovementEventStore.diagnose(healthyPath, true, true, 1).issueCodes, [
      "STORE_READ_LIMIT_EXCEEDED",
    ]);

    const nestedInvalid = join(directory, "nested-invalid.json");
    const nested = JSON.parse(readFileSync(healthyPath, "utf8")) as {
      events: Array<{ waypoints: Array<{ x: unknown }> }>;
    };
    nested.events[0]!.waypoints[0]!.x = "not-a-coordinate";
    writeFileSync(nestedInvalid, JSON.stringify(nested));
    assert.deepEqual(MovementEventStore.diagnose(nestedInvalid).issueCodes, [
      "STORE_SCHEMA_MISMATCH",
    ]);

    const gapPath = join(directory, "gap.json");
    const gap = JSON.parse(readFileSync(healthyPath, "utf8")) as {
      eventSequences: Record<string, number>;
    };
    gap.eventSequences["unexplained-third-event"] = 3;
    writeFileSync(gapPath, JSON.stringify(gap));
    assert.deepEqual(MovementEventStore.diagnose(gapPath).issueCodes, [
      "STORE_CURSOR_RECONCILIATION_GAP",
    ]);

    const tampered = JSON.parse(readFileSync(healthyPath, "utf8")) as {
      events: Array<{ timestamp: number }>;
    };
    tampered.events[0]!.timestamp += 1;
    writeFileSync(healthyPath, JSON.stringify(tampered));
    assert.deepEqual(MovementEventStore.diagnose(healthyPath).issueCodes, [
      "STORE_DIGEST_MISMATCH",
    ]);
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
