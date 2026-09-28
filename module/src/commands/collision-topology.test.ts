import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { validateLiveTokenPath, validateLiveWallTopology } from "./collision-topology.js";
const saved = Object.getOwnPropertyDescriptor(globalThis, "game");
afterEach(() =>
  saved
    ? Object.defineProperty(globalThis, "game", saved)
    : Reflect.deleteProperty(globalThis, "game"),
);
void describe("live collision commands", () => {
  void it("reads scene geometry without update/delete", () => {
    const calls: string[] = [];
    const doc = (id: string, d: Record<string, unknown>) => ({
      id,
      toObject: () => structuredClone(d),
      update: () => {
        calls.push("update");
        throw 0;
      },
      delete: () => {
        calls.push("delete");
        throw 0;
      },
    });
    const token = doc("t", { _id: "t", x: 0, y: 0, elevation: 0, _stats: { modifiedTime: 7 } });
    const wall = doc("w", {
      c: [5, -5, 5, 5],
      door: 0,
      ds: 0,
      move: 1,
      _stats: { modifiedTime: 7 },
    });
    const scene = {
      id: "s",
      toObject: () => ({ _stats: { modifiedTime: 6 } }),
      grid: { type: 1, size: 5, distance: 5, units: "ft" },
      testUserPermission: () => true,
      getEmbeddedCollection: (type: string) =>
        type === "Token" ? new Map([["t", token]]) : new Map([["w", wall]]),
    };
    Object.defineProperty(globalThis, "game", {
      configurable: true,
      value: {
        collections: new Map([["Scene", new Map([["s", scene]])]]),
        user: { id: "gm", isGM: true },
        settings: { get: () => "5105" },
      },
    });
    const result = validateLiveTokenPath({
      sceneId: "s",
      tokenId: "t",
      waypoints: [{ x: 10, y: 0 }],
      movementMode: "walk",
    });
    assert.equal(result.reachable, false);
    assert.deepEqual(result.before, result.after);
    assert.equal(result.persisted, false);
    assert.equal(result.evidence.before.sceneRevision, "6");
    assert.equal(result.evidence.before.tokenRevision, "7");
    assert.deepEqual(result.evidence.before.wallRevisions, { w: "7" });
    const second = validateLiveTokenPath({
      sceneId: "s",
      tokenId: "t",
      waypoints: [{ x: 10, y: 0 }],
      movementMode: "walk",
    });
    assert.deepEqual(result.evidence.after, second.evidence.before);
    assert.deepEqual(validateLiveWallTopology({ sceneId: "s" }).malformedWallIds, []);
    assert.deepEqual(calls, []);
  });
  void it("fails closed without disclosing restricted walls to players", () => {
    const token = {
      id: "t",
      toObject: () => ({ x: 0, y: 0, width: 1, height: 1, _stats: { modifiedTime: 8 } }),
    };
    const hidden = {
      id: "hidden-wall",
      // Hidden data is discarded before revision/geometry validation. Its
      // malformed private fields must neither break nor appear in player output.
      toObject: () => ({ c: null, move: 1, hidden: true }),
    };
    const secretDoor = {
      id: "secret-door",
      toObject: () => ({
        c: [5, -5, 5, 10],
        move: 20,
        door: 2,
        ds: 0,
        _stats: { modifiedTime: 9 },
      }),
    };
    const scene = {
      id: "s",
      toObject: () => ({ _stats: { modifiedTime: 7 } }),
      grid: { type: 1, size: 5, distance: 5, units: "ft", diagonalRule: "euclidean" },
      testUserPermission: () => true,
      getEmbeddedCollection: (type: string) =>
        type === "Token"
          ? new Map([["t", token]])
          : new Map<string, { id: string; toObject: () => Record<string, unknown> }>([
              ["hidden-wall", hidden],
              ["secret-door", secretDoor],
            ]),
    };
    Object.defineProperty(globalThis, "game", {
      configurable: true,
      value: {
        collections: new Map([["Scene", new Map([["s", scene]])]]),
        user: { id: "player", isGM: false },
        settings: { get: () => "euclidean" },
      },
    });
    assert.throws(
      () =>
        validateLiveTokenPath({
          sceneId: "s",
          tokenId: "t",
          waypoints: [{ x: 10, y: 0 }],
          movementMode: "walk",
        }),
      (error: unknown) => {
        const value = error as { code?: string; message?: string; details?: unknown };
        return (
          value.code === "INCOMPLETE_RESULT" &&
          !value.message?.includes("secret") &&
          value.details === undefined
        );
      },
    );
    assert.throws(
      () =>
        validateLiveTokenPath({
          sceneId: "s",
          tokenId: "t",
          waypoints: [{ x: 10, y: 0 }],
          movementMode: "walk",
          simulatedDoors: { "secret-door": "open" },
        }),
      (error: unknown) => (error as { code?: string }).code === "PERMISSION_DENIED",
    );
    assert.throws(() => validateLiveWallTopology({ sceneId: "s" }), /GM execution lane/);
  });
  void it("projects malformed visible walls as incomplete without throwing", () => {
    const token = {
      id: "t",
      toObject: () => ({ x: 0, y: 0, width: 1, height: 1, _stats: { modifiedTime: 8 } }),
    };
    const malformed = {
      id: "malformed",
      toObject: () => ({ c: null, move: 1, _stats: { modifiedTime: 9 } }),
    };
    const scene = {
      id: "s",
      toObject: () => ({ _stats: { modifiedTime: 7 } }),
      grid: { type: 1, size: 5, distance: 5, units: "ft", diagonalRule: "euclidean" },
      testUserPermission: () => true,
      getEmbeddedCollection: (type: string) =>
        type === "Token" ? new Map([["t", token]]) : new Map([["malformed", malformed]]),
    };
    Object.defineProperty(globalThis, "game", {
      configurable: true,
      value: {
        collections: new Map([["Scene", new Map([["s", scene]])]]),
        user: { id: "gm", isGM: true },
        settings: { get: () => "euclidean" },
      },
    });
    const result = validateLiveTokenPath({
      sceneId: "s",
      tokenId: "t",
      waypoints: [{ x: 10, y: 0 }],
      movementMode: "walk",
    });
    assert.equal(result.status, "incomplete");
    assert.equal(result.reachable, false);
    assert.deepEqual(result.malformedWallIds, ["malformed"]);
  });
  void it("fails incomplete when the second genuine live read observes concurrent changes", () => {
    let tokenRead = 0;
    let wallRead = 0;
    let sceneRead = 0;
    let fogRead = 0;
    const writes: string[] = [];
    const token = {
      id: "t",
      toObject: () => {
        tokenRead += 1;
        return {
          x: tokenRead === 1 ? 0 : 5,
          y: 0,
          width: 1,
          height: 1,
          _stats: { modifiedTime: tokenRead === 1 ? 10 : 11 },
        };
      },
      update: () => writes.push("token-update"),
    };
    const wall = {
      id: "door",
      toObject: () => {
        wallRead += 1;
        return {
          c: [10, -5, 10, 10],
          door: 1,
          ds: wallRead === 1 ? 0 : 1,
          move: 1,
          _stats: { modifiedTime: wallRead === 1 ? 20 : 21 },
        };
      },
      update: () => writes.push("wall-update"),
    };
    const fog = {
      id: "fog",
      toObject: () => {
        fogRead += 1;
        return {
          scene: "s",
          user: "gm",
          explored: fogRead === 1 ? "before" : "after",
          positions: {},
          _stats: { modifiedTime: fogRead === 1 ? 30 : 31 },
        };
      },
      update: () => writes.push("fog-update"),
    };
    const scene = {
      id: "s",
      toObject: () => {
        sceneRead += 1;
        return { _stats: { modifiedTime: sceneRead === 1 ? 40 : 41 } };
      },
      grid: { type: 1, size: 5, diagonalRule: "euclidean" },
      testUserPermission: () => true,
      getEmbeddedCollection: (type: string) =>
        type === "Token" ? new Map([["t", token]]) : new Map([["door", wall]]),
    };
    Object.defineProperty(globalThis, "game", {
      configurable: true,
      value: {
        collections: new Map<string, Map<string, object>>([
          ["Scene", new Map([["s", scene]])],
          ["FogExploration", new Map([["fog", fog]])],
        ]),
        user: { id: "gm", isGM: true },
        settings: { get: () => "euclidean" },
      },
    });
    const result = validateLiveTokenPath({
      sceneId: "s",
      tokenId: "t",
      waypoints: [{ x: 15, y: 0 }],
      movementMode: "walk",
    });
    assert.equal(result.status, "incomplete");
    assert.equal(result.reachable, false);
    assert.equal(result.evidence.unchanged, false);
    assert.equal(result.evidence.before.token.x, 0);
    assert.equal(result.evidence.after.token.x, 5);
    assert.equal(result.evidence.before.walls["door"]?.doorState, "closed");
    assert.equal(result.evidence.after.walls["door"]?.doorState, "open");
    assert.equal(result.evidence.before.sceneRevision, "40");
    assert.equal(result.evidence.after.sceneRevision, "41");
    assert.equal(result.evidence.before.fog?.revision, "30");
    assert.equal(result.evidence.after.fog?.revision, "31");
    assert.notEqual(
      result.evidence.before.fog?.stateSignature,
      result.evidence.after.fog?.stateSignature,
    );
    assert.deepEqual(writes, []);
    assert.equal(tokenRead, 2);
    assert.equal(wallRead, 2);
    assert.equal(sceneRead, 2);
    assert.equal(fogRead, 2);
  });
  void it("refuses document ID revision fallbacks", () => {
    const token = { id: "t", toObject: () => ({ x: 0, y: 0, width: 1, height: 1 }) };
    const scene = {
      id: "s",
      toObject: () => ({ _id: "s" }),
      grid: { type: 1, size: 5 },
      testUserPermission: () => true,
      getEmbeddedCollection: (type: string) =>
        type === "Token" ? new Map([["t", token]]) : new Map(),
    };
    Object.defineProperty(globalThis, "game", {
      configurable: true,
      value: {
        collections: new Map([["Scene", new Map([["s", scene]])]]),
        user: { id: "gm", isGM: true },
        settings: { get: () => "5105" },
      },
    });
    assert.throws(
      () =>
        validateLiveTokenPath({
          sceneId: "s",
          tokenId: "t",
          waypoints: [{ x: 5, y: 0 }],
          movementMode: "walk",
        }),
      /genuine document revision/,
    );
  });
});
