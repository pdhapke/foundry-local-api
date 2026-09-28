import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildMovementEvent } from "./movement-events.js";
void describe("movement transitions", () => {
  void it("retains ordered narrow overlapping transitions and compact deltas", () => {
    const event = buildMovementEvent({
      eventId: "e",
      sceneId: "s",
      tokenId: "t",
      userId: "u",
      timestamp: 1,
      waypoints: [
        { x: 0, y: 5 },
        { x: 20, y: 5 },
      ],
      regions: [
        {
          id: "room",
          polygons: [
            [
              { x: 2, y: 0 },
              { x: 18, y: 0 },
              { x: 18, y: 10 },
              { x: 2, y: 10 },
            ],
          ],
        },
        {
          id: "hazard",
          polygons: [
            [
              { x: 9, y: 0 },
              { x: 10, y: 0 },
              { x: 10, y: 10 },
              { x: 9, y: 10 },
            ],
          ],
        },
      ],
    });
    assert.deepEqual(
      event.transitions.map((x) => `${x.regionId}:${x.kind}`),
      ["room:enter", "hazard:enter", "hazard:exit", "room:exit"],
    );
    assert.deepEqual(event.deltas, [{ dx: 20, dy: 0, delevation: 0 }]);
  });

  void it("treats multiple polygons as a union and suppresses shared-boundary jitter", () => {
    const event = buildMovementEvent({
      eventId: "union",
      sceneId: "s",
      tokenId: "t",
      userId: "u",
      waypoints: [
        { x: 0, y: 5 },
        { x: 20, y: 5 },
      ],
      regions: [
        {
          id: "room",
          category: "room",
          polygons: [
            [
              { x: 2, y: 0 },
              { x: 10, y: 0 },
              { x: 10, y: 10 },
              { x: 2, y: 10 },
            ],
            [
              { x: 10, y: 0 },
              { x: 18, y: 0 },
              { x: 18, y: 10 },
              { x: 10, y: 10 },
            ],
          ],
        },
      ],
    });
    assert.deepEqual(
      event.transitions.map((t) => [t.kind, Math.round(t.point.x)]),
      [
        ["enter", 2],
        ["exit", 18],
      ],
    );
  });

  void it("uses the full footprint, Region elevation, precedence, and exact first stop", () => {
    const event = buildMovementEvent({
      eventId: "stop",
      sceneId: "s",
      tokenId: "t",
      userId: "u",
      footprint: { width: 2, height: 2 },
      waypoints: [
        { x: 0, y: 5, elevation: 5 },
        { x: 20, y: 5, elevation: 5 },
        { x: 30, y: 5, elevation: 5 },
      ],
      regions: [
        {
          id: "room",
          category: "room",
          polygons: [
            [
              { x: 5, y: 0 },
              { x: 25, y: 0 },
              { x: 25, y: 10 },
              { x: 5, y: 10 },
            ],
          ],
        },
        {
          id: "threshold",
          category: "threshold",
          polygons: [
            [
              { x: 10, y: 0 },
              { x: 12, y: 0 },
              { x: 12, y: 10 },
              { x: 10, y: 10 },
            ],
          ],
          bottom: 0,
          top: 10,
        },
        {
          id: "hazard",
          category: "hazard",
          polygons: [
            [
              { x: 10, y: 0 },
              { x: 12, y: 0 },
              { x: 12, y: 10 },
              { x: 10, y: 10 },
            ],
          ],
          bottom: 0,
          top: 10,
        },
        {
          id: "high",
          category: "hazard",
          polygons: [
            [
              { x: 2, y: 0 },
              { x: 3, y: 0 },
              { x: 3, y: 10 },
              { x: 2, y: 10 },
            ],
          ],
          bottom: 10,
          top: 20,
        },
      ],
    });
    assert.equal(
      event.transitions.some((t) => t.regionId === "high"),
      false,
    );
    assert.deepEqual(
      event.transitions
        .filter((t) => t.kind === "enter" && Math.abs(t.point.x - 8) < 1e-5)
        .map((t) => t.regionId),
      ["hazard", "threshold"],
    );
    assert.equal(event.firstStop?.regionId, "hazard");
    assert.ok(Math.abs(event.acceptedPoint.x - 8) < 1e-5);
    assert.deepEqual(
      event.remainingPath.map((p) => p.x),
      [event.acceptedPoint.x, 20, 30],
    );
    assert.equal(event.pendingMovement?.status, "pending");
    assert.equal(event.segments.length, 2);
  });

  void it("captures a narrow hazard crossed between endpoints", () => {
    const event = buildMovementEvent({
      eventId: "narrow",
      sceneId: "s",
      tokenId: "t",
      userId: "u",
      waypoints: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      regions: [
        {
          id: "h",
          category: "hazard",
          polygons: [
            [
              { x: 49.9, y: -1 },
              { x: 50.1, y: -1 },
              { x: 50.1, y: 1 },
              { x: 49.9, y: 1 },
            ],
          ],
        },
      ],
    });
    assert.deepEqual(
      event.transitions.map((t) => t.kind),
      ["enter", "exit"],
    );
  });

  void it("subtracts polygon holes from Region union geometry", () => {
    const event = buildMovementEvent({
      eventId: "hole",
      sceneId: "s",
      tokenId: "t",
      userId: "u",
      waypoints: [
        { x: 0, y: 5 },
        { x: 10, y: 5 },
      ],
      regions: [
        {
          id: "room-with-hole",
          category: "room",
          polygons: [
            [
              { x: 1, y: 0 },
              { x: 9, y: 0 },
              { x: 9, y: 10 },
              { x: 1, y: 10 },
            ],
          ],
          holes: [
            [
              { x: 4, y: 0 },
              { x: 6, y: 0 },
              { x: 6, y: 10 },
              { x: 4, y: 10 },
            ],
          ],
        },
      ],
    });
    assert.deepEqual(
      event.transitions.map((transition) => [transition.kind, Math.round(transition.point.x)]),
      [
        ["enter", 1],
        ["exit", 4],
        ["enter", 6],
        ["exit", 9],
      ],
    );
  });

  void it("makes incomplete Region geometry explicit and emits no guessed transitions", () => {
    const event = buildMovementEvent({
      eventId: "incomplete",
      sceneId: "s",
      tokenId: "t",
      userId: "u",
      waypoints: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      regions: [
        {
          id: "curve",
          polygons: [],
          incompleteReasons: ["unsupported exact circle geometry"],
        },
      ],
    });
    assert.equal(event.geometryStatus, "incomplete");
    assert.deepEqual(event.incompleteReasons, ["Region curve: unsupported exact circle geometry"]);
    assert.deepEqual(event.transitions, []);
  });

  void it("carries explicit stop-on-enter semantics into the canonical transition", () => {
    const event = buildMovementEvent({
      eventId: "room-stop",
      sceneId: "s",
      tokenId: "t",
      userId: "u",
      waypoints: [
        { x: 0, y: 1 },
        { x: 4, y: 1 },
      ],
      regions: [
        {
          id: "room",
          category: "room",
          stopOnEnter: true,
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
    });
    assert.equal(event.firstStop?.regionId, "room");
    assert.equal(event.firstStop?.stopOnEnter, true);
  });

  void it("honors an exclusive Region elevation top boundary", () => {
    const event = buildMovementEvent({
      eventId: "exclusive-top",
      sceneId: "s",
      tokenId: "t",
      userId: "u",
      waypoints: [
        { x: 1, y: 1, elevation: 9 },
        { x: 1, y: 1, elevation: 10 },
        { x: 1, y: 1, elevation: 11 },
      ],
      regions: [
        {
          id: "level",
          polygons: [
            [
              { x: 0, y: 0 },
              { x: 2, y: 0 },
              { x: 2, y: 2 },
              { x: 0, y: 2 },
            ],
          ],
          bottom: 0,
          top: 10,
          topInclusive: false,
        },
      ],
    });
    assert.deepEqual(
      event.transitions.map((transition) => [transition.kind, transition.segmentIndex]),
      [["exit", 0]],
    );
  });
});
