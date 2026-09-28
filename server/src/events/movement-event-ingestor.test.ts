import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildMovementEvent, type CompactMovementEvent } from "@foundry-local-api/shared";
import { FoundryEventBus } from "./event-bus.js";
import {
  MOVEMENT_EVENT_NAME,
  ingestMovementEvent,
  subscribeMovementEventStore,
} from "./movement-event-ingestor.js";
import { MovementEventStore } from "./movement-event-store.js";

void describe("automatic durable movement ingestion", () => {
  const reporter = { clientId: "gm-client", userId: "gm-user", lane: "gm" as const };
  void it("persists only valid forwarded movement events and deduplicates correlation replay", () => {
    const bus = new FoundryEventBus();
    const store = new MovementEventStore(
      join(mkdtempSync(join(tmpdir(), "move-ingest-")), "state.json"),
    );
    const unsubscribe = subscribeMovementEventStore(bus, store, reporter);
    const event = buildMovementEvent({
      eventId: "correlation-1",
      sceneId: "scene",
      tokenId: "token",
      userId: "user",
      timestamp: 1,
      waypoints: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      regions: [],
    });
    bus.publish("updateActor", { _id: "unrelated" });
    bus.publish(MOVEMENT_EVENT_NAME, { malformed: true });
    bus.publish(MOVEMENT_EVENT_NAME, event);
    bus.publish(MOVEMENT_EVENT_NAME, event);
    assert.deepEqual(
      store.query({}).events.map((item) => item.eventId),
      ["correlation-1"],
    );
    unsubscribe();
    bus.publish(MOVEMENT_EVENT_NAME, { ...event, eventId: "correlation-2" });
    assert.equal(store.query({}).events.length, 1);
  });

  void it("persists authenticated reporter identity separately from the initiating user", () => {
    const store = new MovementEventStore(
      join(mkdtempSync(join(tmpdir(), "move-provenance-")), "state.json"),
    );
    const event = buildMovementEvent({
      eventId: "correlation-provenance",
      sceneId: "scene",
      tokenId: "token",
      userId: "initiating-player",
      timestamp: 1,
      waypoints: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      regions: [],
    });
    const record = ingestMovementEvent(store, event, {
      clientId: "gm-client",
      userId: "gm-user",
      lane: "gm",
    });
    assert.equal(record?.userId, "initiating-player");
    assert.deepEqual(record?.provenance, {
      reporterClientId: "gm-client",
      reporterUserId: "gm-user",
      reporterLane: "gm",
    });
  });

  void it("rejects semantically inconsistent movement records before persistence", () => {
    const valid = buildMovementEvent({
      eventId: "semantic-validation",
      sceneId: "scene",
      tokenId: "token",
      userId: "player",
      timestamp: 10,
      waypoints: [
        { x: 0, y: 1, elevation: 0 },
        { x: 6, y: 1, elevation: 3 },
      ],
      regions: [
        {
          id: "hazard",
          category: "hazard",
          polygons: [
            [
              { x: 2, y: 0 },
              { x: 4, y: 0 },
              { x: 4, y: 2 },
              { x: 2, y: 2 },
            ],
          ],
        },
      ],
    });
    assert.equal(valid.transitions.length, 2);
    assert.ok(valid.firstStop);

    const corruptions: Array<[string, (candidate: CompactMovementEvent) => void]> = [
      ["segment index", (candidate) => (candidate.segments[0]!.index = 4)],
      ["segment endpoint", (candidate) => (candidate.segments[0]!.to.x += 1)],
      ["segment delta", (candidate) => (candidate.segments[0]!.dx += 1)],
      ["parallel delta", (candidate) => (candidate.deltas[0]!.delevation += 1)],
      ["transition interpolation", (candidate) => (candidate.transitions[0]!.t += 0.01)],
      ["transition ordering", (candidate) => candidate.transitions.reverse()],
      [
        "first stop",
        (candidate) =>
          (candidate.firstStop = {
            ...candidate.firstStop!,
            point: { ...candidate.firstStop!.point, x: candidate.firstStop!.point.x + 1 },
          }),
      ],
      [
        "accepted point",
        (candidate) =>
          (candidate.acceptedPoint = {
            ...candidate.acceptedPoint,
            x: candidate.acceptedPoint.x + 1,
          }),
      ],
      ["remaining path", (candidate) => (candidate.remainingPath = [])],
      [
        "pending movement",
        (candidate) =>
          (candidate.pendingMovement = {
            ...candidate.pendingMovement!,
            acceptedPoint: {
              ...candidate.pendingMovement!.acceptedPoint,
              y: candidate.pendingMovement!.acceptedPoint.y + 1,
            },
          }),
      ],
      ["missing first stop", (candidate) => Reflect.deleteProperty(candidate, "firstStop")],
      [
        "missing pending movement",
        (candidate) => Reflect.deleteProperty(candidate, "pendingMovement"),
      ],
      ["geometry status", (candidate) => (candidate.geometryStatus = "incomplete")],
      ["event endpoint", (candidate) => (candidate.to.y += 1)],
    ];

    for (const [label, corrupt] of corruptions) {
      const candidate = structuredClone(valid);
      corrupt(candidate);
      const store = new MovementEventStore(
        join(mkdtempSync(join(tmpdir(), "move-invalid-")), "state.json"),
      );
      assert.equal(ingestMovementEvent(store, candidate, reporter), null, label);
      assert.equal(store.query({}).events.length, 0, `${label} was persisted`);
    }

    const roomInput = {
      eventId: "room-stop-validation",
      sceneId: "scene",
      tokenId: "token",
      userId: "player",
      timestamp: 11,
      waypoints: [
        { x: 0, y: 1 },
        { x: 4, y: 1 },
      ],
      regions: [
        {
          id: "room",
          category: "room" as const,
          polygons: [
            [
              { x: 2, y: 0 },
              { x: 3, y: 0 },
              { x: 3, y: 2 },
              { x: 2, y: 2 },
            ],
          ],
        },
      ],
    };
    const forged = buildMovementEvent(roomInput);
    const forgedStop = forged.transitions.find((transition) => transition.kind === "enter")!;
    forged.firstStop = { ...forgedStop };
    forged.acceptedPoint = { ...forgedStop.point };
    forged.remainingPath = [
      { ...forgedStop.point },
      ...forged.waypoints.slice(forgedStop.segmentIndex + 1),
    ];
    forged.pendingMovement = {
      status: "pending",
      stop: forged.firstStop,
      acceptedPoint: forged.acceptedPoint,
      remainingPath: forged.remainingPath,
    };
    const forgedStore = new MovementEventStore(
      join(mkdtempSync(join(tmpdir(), "move-forged-stop-")), "state.json"),
    );
    assert.equal(ingestMovementEvent(forgedStore, forged, reporter), null);

    const legitimate = buildMovementEvent({
      ...roomInput,
      eventId: "legitimate-room-stop",
      regions: [{ ...roomInput.regions[0]!, stopOnEnter: true }],
    });
    const legitimateStore = new MovementEventStore(
      join(mkdtempSync(join(tmpdir(), "move-legitimate-stop-")), "state.json"),
    );
    assert.equal(
      ingestMovementEvent(legitimateStore, legitimate, reporter)?.eventId,
      legitimate.eventId,
    );
  });
});
