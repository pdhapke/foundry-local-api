import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const baseSource = () => ({
  _id: "scene",
  name: "Map",
  grid: {
    type: 1,
    size: 50,
    distance: 5,
    units: "ft",
    style: "solidLines",
    thickness: 1,
    color: "#000000",
    alpha: 0.12,
  },
  shiftX: 0,
  shiftY: 0,
  tokens: [{ _id: "t" }],
  walls: [{ _id: "w" }],
  regions: [],
  tiles: [],
  notes: [],
  lights: [],
  sounds: [],
  flags: { preserved: true },
  _stats: { modifiedTime: 12, lastModifiedBy: "gm" },
});

let source = baseSource();
let mutateUnrelatedField = false;
const scene = {
  width: 1000,
  height: 1000,
  padding: 0,
  grid: { size: 50, type: 1, distance: 5, units: "ft" },
  dimensions: { sceneWidth: 1000, sceneHeight: 1000, sceneX: 0, sceneY: 0 },
  toObject: () => structuredClone(source),
  update: async (changes: Record<string, unknown>) => {
    source = { ...source, ...structuredClone(changes) } as typeof source;
    if (mutateUnrelatedField) {
      source.name = "Unexpected change";
      mutateUnrelatedField = false;
    }
    source._stats.modifiedTime += 1;
    return scene;
  },
  activate: async () => scene,
  resetFog: async () => undefined,
};

Object.assign(globalThis, {
  game: {
    user: { isGM: true },
    collections: new Map([["Scene", new Map([["scene", scene]])]]),
  },
});

const { alignSceneGrid } = await import("./scenes.js");

void describe("revision-checked Scene grid alignment", () => {
  beforeEach(() => {
    source = baseSource();
    mutateUnrelatedField = false;
    (globalThis as unknown as { game: { user: { isGM: boolean } } }).game.user.isGM = true;
  });

  void it("dry-runs without persistence and returns the exact rollback", async () => {
    const result = await alignSceneGrid({
      id: "scene",
      expectedModifiedTime: 12,
      size: 80,
      distance: 10,
      shiftX: 33,
      shiftY: 30,
      dryRun: true,
    });
    assert.equal(result.persisted, false);
    assert.equal(source.grid.size, 50);
    assert.deepEqual(result.rollback, {
      id: "scene",
      expectedModifiedTime: 12,
      size: 50,
      distance: 5,
      shiftX: 0,
      shiftY: 0,
    });
  });

  void it("applies only grid fields and revision-binds the rollback", async () => {
    const result = await alignSceneGrid({
      id: "scene",
      expectedModifiedTime: 12,
      size: 80,
      distance: 10,
      shiftX: 33,
      shiftY: 30,
    });
    assert.equal(result.persisted, true);
    assert.equal(source.grid.size, 80);
    assert.equal(source.grid.distance, 10);
    assert.equal(source.shiftX, 33);
    assert.equal(source.shiftY, 30);
    assert.deepEqual(source.tokens, [{ _id: "t" }]);
    assert.deepEqual(source.walls, [{ _id: "w" }]);
    assert.deepEqual(source.flags, { preserved: true });
    assert.equal(result.rollback.expectedModifiedTime, 13);
  });

  void it("rejects a stale revision and a non-GM without mutation", async () => {
    await assert.rejects(
      alignSceneGrid({
        id: "scene",
        expectedModifiedTime: 11,
        size: 80,
        distance: 10,
        shiftX: 33,
        shiftY: 30,
      }),
      (error: unknown) => (error as { code?: string }).code === "STALE_REVISION",
    );
    (globalThis as unknown as { game: { user: { isGM: boolean } } }).game.user.isGM = false;
    await assert.rejects(
      alignSceneGrid({
        id: "scene",
        expectedModifiedTime: 12,
        size: 80,
        distance: 10,
        shiftX: 33,
        shiftY: 30,
      }),
      (error: unknown) => (error as { code?: string }).code === "PERMISSION_DENIED",
    );
    assert.equal(source.grid.size, 50);
  });

  void it("restores the grid and reports rollback failure after an unrelated change", async () => {
    mutateUnrelatedField = true;
    await assert.rejects(
      alignSceneGrid({
        id: "scene",
        expectedModifiedTime: 12,
        size: 80,
        distance: 10,
        shiftX: 33,
        shiftY: 30,
      }),
      (error: unknown) => (error as { code?: string }).code === "ROLLBACK_FAILED",
    );
    assert.equal(source.name, "Unexpected change");
    assert.equal(source.grid.size, 50);
    assert.equal(source.grid.distance, 5);
    assert.equal(source.shiftX, 0);
    assert.equal(source.shiftY, 0);
  });
});
