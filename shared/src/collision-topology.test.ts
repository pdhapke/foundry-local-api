import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspectWallTopology, pathDistance, validatePathGeometry } from "./collision-topology.js";

void describe("collision and topology geometry", () => {
  void it("handles blocked/open doors, corners, elevation, and no persistence", () => {
    const input = {
      sceneId: "s",
      tokenId: "t",
      waypoints: [{ x: 10, y: 0, elevation: 0 }],
      movementMode: "walk" as const,
    };
    const token = { x: 0, y: 0, elevation: 0, revision: "r1" };
    const walls = [
      {
        id: "door",
        c: [7, -5, 7, 5] as [number, number, number, number],
        door: 1,
        ds: 0,
        bottom: -1,
        top: 1,
      },
    ];
    const blocked = validatePathGeometry(input, token, walls, { type: 1, size: 5 });
    assert.equal(blocked.reachable, false);
    assert.deepEqual(blocked.segments[0]?.wallIds, ["door"]);
    const open = validatePathGeometry(
      { ...input, simulatedDoors: { door: "open" } },
      token,
      walls,
      { type: 1, size: 5 },
    );
    assert.equal(open.reachable, true);
    assert.deepEqual(open.before, open.after);
    const above = validatePathGeometry(
      { ...input, waypoints: [{ x: 10, y: 0, elevation: 10 }], movementMode: "fly" },
      token,
      walls,
      { type: 1, size: 5 },
    );
    assert.equal(above.reachable, true);
  });
  void it("reports malformed, duplicate, crossing, zero-length, and dangling topology", () => {
    const result = inspectWallTopology("s", [
      { id: "a", c: [0, 0, 10, 0] },
      { id: "dup", c: [10, 0, 0, 0] },
      { id: "cross", c: [5, -5, 5, 5] },
      { id: "zero", c: [20, 20, 20, 20] },
      { id: "bad", c: [0, Number.NaN, 1, 1] },
    ]);
    assert.deepEqual(result.malformedWallIds, ["bad"]);
    assert.deepEqual(result.duplicateGroups, [["a", "dup"]]);
    assert.ok(result.crossingPairs.some((p) => p.includes("cross")));
    assert.deepEqual(result.zeroLengthWallIds, ["zero"]);
  });
  void it("uses footprint, interpolated elevation, direction, grid fit, and explicit mode support", () => {
    const token = { x: 0, y: 0, elevation: 0, revision: "r", width: 5, height: 5 };
    const base = {
      sceneId: "s",
      tokenId: "t",
      waypoints: [{ x: 10, y: 5, elevation: 4 }],
      movementMode: "walk" as const,
    };
    const wall = {
      id: "one-way",
      c: [5, -5, 5, 3] as [number, number, number, number],
      top: 2,
      dir: 2,
    };
    const forward = validatePathGeometry(base, token, [wall], {
      type: 1,
      size: 5,
      diagonalRule: "5105",
    });
    assert.equal(forward.segments[0]!.distance, 10);
    assert.equal(
      pathDistance({ x: 0, y: 0 }, { x: 10, y: 10 }, { type: 1, size: 5, diagonalRule: "5105" }),
      15,
    );
    assert.equal(forward.reachable, false, "footprint edge and interpolated elevation collide");
    assert.equal(forward.gridWarnings.length, 0);
    const reverse = validatePathGeometry(
      { ...base, waypoints: [{ x: 0, y: 0, elevation: 4 }] },
      { ...token, x: 10, y: 5 },
      [wall],
      { type: 1, size: 5, diagonalRule: "5105" },
    );
    assert.equal(reverse.reachable, true, "one-way wall permits reverse crossing");
    const burrow = validatePathGeometry({ ...base, movementMode: "burrow" }, token, [], {
      type: 1,
      size: 5,
    });
    assert.equal(burrow.modeSupport.status, "unsupported");
    assert.equal(burrow.reachable, false);
  });
  void it("sweeps the complete footprint through narrow and corner contacts", () => {
    const token = {
      x: 0,
      y: 0,
      revision: "token-1",
      sceneRevision: "scene-1",
      width: 10,
      height: 10,
    };
    const narrow = validatePathGeometry(
      { sceneId: "s", tokenId: "t", waypoints: [{ x: 20, y: 0 }], movementMode: "walk" },
      token,
      [{ id: "thin", c: [15, 1, 15, 2], revision: "wall-1" }],
      { type: 1, size: 10 },
    );
    assert.equal(narrow.reachable, false, "a wall between sampled corners and center is detected");
    assert.equal(narrow.firstCollision?.wallId, "thin");
    assert.equal(narrow.firstCollision?.t, 0.25);
    assert.deepEqual(narrow.segments[0]!.firstCollisionWallIds, ["thin"]);

    const corner = validatePathGeometry(
      { sceneId: "s", tokenId: "t", waypoints: [{ x: 10, y: 10 }], movementMode: "walk" },
      { ...token, width: 5, height: 5 },
      [{ id: "corner", c: [10, 10, 10, 20], revision: "wall-2" }],
      { type: 1, size: 5 },
    );
    assert.equal(corner.reachable, false);
    assert.equal(corner.firstCollision?.x, 10);
    assert.equal(corner.firstCollision?.y, 10);
  });
  void it("intersects continuous footprint and elevation intervals instead of sampling one contact", () => {
    const result = validatePathGeometry(
      {
        sceneId: "s",
        tokenId: "t",
        waypoints: [{ x: 20, y: 0, elevation: 0 }],
        movementMode: "fly",
      },
      { x: 0, y: 0, elevation: 10, revision: "t1", width: 10, height: 10 },
      [{ id: "low-wall", c: [15, -5, 15, 15], bottom: 0, top: 5 }],
      { type: 1, size: 10 },
    );
    assert.equal(result.reachable, false);
    assert.equal(result.firstCollision?.wallId, "low-wall");
    assert.equal(result.firstCollision?.t, 0.5);
    assert.equal(result.firstCollision?.elevation, 5);
  });
  void it("models every door state, secret doors, and compatible simulations", () => {
    const input = {
      sceneId: "s",
      tokenId: "t",
      waypoints: [{ x: 10, y: 0 }],
      movementMode: "walk" as const,
    };
    const token = { x: 0, y: 0, revision: "t1", width: 2, height: 2 };
    for (const state of ["closed", "locked", "barred", "sealed"] as const) {
      const result = validatePathGeometry(
        input,
        token,
        [{ id: state, c: [5, -2, 5, 4], door: 1, ds: state }],
        { type: 1, size: 2 },
      );
      assert.equal(result.reachable, false, state);
      assert.equal(result.firstCollision?.doorState, state);
    }
    const open = validatePathGeometry(
      input,
      token,
      [{ id: "open", c: [5, -2, 5, 4], door: 1, ds: "open" }],
      { type: 1, size: 2 },
    );
    assert.equal(open.reachable, true);
    assert.equal(open.segments[0]!.intersections[0]!.blocking, false);
    const secret = validatePathGeometry(
      input,
      token,
      [{ id: "secret", c: [5, -2, 5, 4], door: 2, ds: 0 }],
      { type: 1, size: 2 },
    );
    assert.equal(secret.firstCollision?.doorType, "secret");
    assert.equal(secret.reachable, false);
    const oneWayDoor = validatePathGeometry(
      input,
      token,
      [{ id: "one-way-door", c: [5, -2, 5, 4], door: 1, ds: "closed", dir: 2 }],
      { type: 1, size: 2 },
    );
    const reverseOneWayDoor = validatePathGeometry(
      { ...input, waypoints: [{ x: 0, y: 0 }] },
      { ...token, x: 10 },
      [{ id: "one-way-door", c: [5, -2, 5, 4], door: 1, ds: "closed", dir: 2 }],
      { type: 1, size: 2 },
    );
    assert.equal(oneWayDoor.reachable, false);
    assert.equal(reverseOneWayDoor.reachable, true);
    const incompatible = validatePathGeometry(
      { ...input, simulatedDoors: { wall: "open" } },
      token,
      [{ id: "wall", c: [5, -2, 5, 4], door: 0 }],
      { type: 1, size: 2 },
    );
    assert.equal(incompatible.status, "incomplete");
    assert.equal(incompatible.reachable, false);
    assert.deepEqual(incompatible.invalidSimulatedDoorIds, ["wall"]);

    const invalidState = validatePathGeometry(
      {
        ...input,
        simulatedDoors: { door: "ajar" } as unknown as Record<
          string,
          "open" | "closed" | "locked" | "barred" | "sealed"
        >,
      },
      token,
      [{ id: "door", c: [5, -2, 5, 4], door: 1, ds: "closed" }],
      { type: 1, size: 2 },
    );
    assert.equal(invalidState.status, "incomplete");
    assert.equal(invalidState.reachable, false);
    assert.deepEqual(invalidState.invalidSimulatedDoorIds, ["door"]);
    assert.equal(invalidState.firstCollision?.doorState, "closed");
  });
  void it("reports malformed input and invalid grid fit without claiming reachability", () => {
    const result = validatePathGeometry(
      { sceneId: "s", tokenId: "t", waypoints: [{ x: 3, y: 0 }], movementMode: "walk" },
      { x: 0, y: 0, revision: "t1", width: 3, height: 5 },
      [{ id: "bad", c: [0, Number.NaN, 1, 1] }],
      { type: 1, size: 0 },
    );
    assert.equal(result.status, "incomplete");
    assert.equal(result.reachable, false);
    assert.deepEqual(result.malformedWallIds, ["bad"]);
    assert.equal(result.gridFit.valid, false);
    assert.ok(result.gridFit.errors.length > 0);
  });
  void it("classifies an otherwise reachable off-grid destination as incomplete", () => {
    const result = validatePathGeometry(
      { sceneId: "s", tokenId: "t", waypoints: [{ x: 7, y: 0 }], movementMode: "walk" },
      { x: 0, y: 0, revision: "t1", sceneRevision: "s1", width: 5, height: 5 },
      [],
      { type: 1, size: 5 },
    );
    assert.equal(result.status, "incomplete");
    assert.equal(result.reachable, false);
    assert.equal(result.gridFit.valid, false);
    assert.match(result.gridFit.errors[0]!, /not aligned/);
  });
  void it("classifies an off-grid starting Token position as incomplete", () => {
    const result = validatePathGeometry(
      { sceneId: "s", tokenId: "t", waypoints: [{ x: 10, y: 0 }], movementMode: "walk" },
      { x: 1, y: 0, revision: "t1", sceneRevision: "s1", width: 5, height: 5 },
      [],
      { type: 1, size: 5 },
    );
    assert.equal(result.status, "incomplete");
    assert.equal(result.reachable, false);
    assert.equal(result.gridFit.valid, false);
    assert.ok(result.gridFit.errors.some((message) => message.includes("starting position")));
  });
  void it("fails closed instead of throwing for non-array coordinates and invalid elevation bounds", () => {
    const malformedWalls = [
      { id: "not-an-array", c: null },
      { id: "bad-height", c: [5, -5, 5, 5], bottom: 10, top: 2 },
    ] as unknown as Parameters<typeof validatePathGeometry>[2];
    const result = validatePathGeometry(
      { sceneId: "s", tokenId: "t", waypoints: [{ x: 10, y: 0 }], movementMode: "walk" },
      { x: 0, y: 0, revision: "t1", width: 2, height: 2 },
      malformedWalls,
      { type: 1, size: 2 },
    );
    assert.equal(result.status, "incomplete");
    assert.equal(result.reachable, false);
    assert.deepEqual(result.malformedWallIds, ["not-an-array", "bad-height"]);
    assert.deepEqual(inspectWallTopology("s", malformedWalls).malformedWallIds, [
      "not-an-array",
      "bad-height",
    ]);
  });
  void it("keeps malformed geometry signatures bounded and type-sensitive", () => {
    const input = {
      sceneId: "s",
      tokenId: "t",
      waypoints: [{ x: 10, y: 0 }],
      movementMode: "walk" as const,
    };
    const token = { x: 0, y: 0, revision: "token-r1", sceneRevision: "scene-r1" };
    const signatureFor = (coordinates: unknown) => {
      const result = validatePathGeometry(
        input,
        token,
        [{ id: "bad", c: coordinates, revision: "wall-r1" }] as unknown as Parameters<
          typeof validatePathGeometry
        >[2],
        { type: 1, size: 5 },
      );
      return {
        shape: result.evidence.before.malformedWalls["bad"]!.shapeSignature,
        topology: result.evidence.before.topologySignature,
      };
    };
    const variants = [
      signatureFor([0, Number.NaN, 1, 1]),
      signatureFor([0, Infinity, 1, 1]),
      signatureFor([0, -Infinity, 1, 1]),
      signatureFor(null),
      signatureFor("invalid"),
      signatureFor([0, 1, 1]),
    ];
    assert.equal(new Set(variants.map(({ shape }) => shape)).size, variants.length);
    assert.equal(new Set(variants.map(({ topology }) => topology)).size, variants.length);
    assert.ok(variants.every(({ shape }) => /^[0-9a-f]{8}$/.test(shape)));

    const huge = signatureFor(Array.from({ length: 20_000 }, (_, index) => index));
    assert.equal(huge.shape.length, 8);
    assert.ok(huge.topology.length < 200);
    assert.ok(!huge.topology.includes("19999"));
  });
  void it("returns revision-backed unchanged-state evidence for repeatable live reads", () => {
    const input = {
      sceneId: "s",
      tokenId: "t",
      waypoints: [{ x: 10, y: 0 }],
      movementMode: "walk" as const,
    };
    const token = {
      x: 0,
      y: 0,
      revision: "token-r7",
      sceneRevision: "scene-r9",
      width: 2,
      height: 2,
    };
    const walls = [
      { id: "later", c: [8, -2, 8, 4] as [number, number, number, number], revision: "wall-r3" },
      { id: "first", c: [5, -2, 5, 4] as [number, number, number, number], revision: "wall-r2" },
    ];
    const first = validatePathGeometry(input, token, walls, { type: 1, size: 2 });
    const second = validatePathGeometry(input, token, walls, { type: 1, size: 2 });
    assert.equal(first.firstCollision?.wallId, "first");
    assert.equal(first.evidence.unchanged, true);
    assert.deepEqual(first.evidence.before, first.evidence.after);
    assert.deepEqual(first.evidence.after, second.evidence.before);
    assert.deepEqual(first.evidence.before.wallRevisions, { later: "wall-r3", first: "wall-r2" });
  });
});
