import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const db = new Map<string, Record<string, unknown>>();
const emitted: unknown[][] = [];
let serverDeletes = true;
// Ignores a delayed server deletion that belongs to an earlier test.
let generation = 0;

function seed() {
  db.clear();
  const fogs: Array<[string, string, string]> = [
    ["fog-1", "scene", "player"],
    ["fog-2", "scene", "gm"],
    ["fog-3", "scene", "player"],
    ["fog-other", "other-scene", "player"],
  ];
  for (const [id, scene, user] of fogs) {
    db.set(id, { _id: id, scene, user, level: `level-${id}`, explored: "seen", positions: {} });
  }
}

const documentClass = {
  database: {
    get: (_documentClass: unknown, operation: Record<string, unknown>) => {
      const query = (operation["query"] ?? {}) as Record<string, unknown>;
      return Promise.resolve(
        [...db.values()]
          .filter((source) => Object.entries(query).every(([key, value]) => source[key] === value))
          .map((source) => ({ id: source["_id"], toObject: () => structuredClone(source) })),
      );
    },
  },
};

Object.assign(globalThis, {
  game: {
    user: { id: "gm", isGM: true },
    collections: new Map<string, unknown>([
      ["Scene", new Map([["scene", { id: "scene" }]])],
      ["FogExploration", new Map()],
    ]),
    socket: {
      emit: (...args: unknown[]) => {
        emitted.push(args);
        // Foundry's server handler deletes every FogExploration for the Scene, asynchronously.
        if (serverDeletes && args[0] === "resetFog") {
          const scheduled = generation;
          setTimeout(() => {
            if (scheduled !== generation) return;
            for (const [id, source] of db) if (source["scene"] === args[1]) db.delete(id);
          }, 5);
        }
      },
    },
  },
  CONFIG: { FogExploration: { documentClass } },
});

const { resetSceneFog } = await import("./scenes.js");
const gameUser = () => (globalThis as unknown as { game: { user: { isGM: boolean } } }).game.user;

void describe("Scene fog reset", () => {
  beforeEach(() => {
    generation += 1;
    seed();
    emitted.length = 0;
    serverDeletes = true;
    gameUser().isGM = true;
  });

  void it("emits Foundry's resetFog event and verifies every user's and Level's fog is gone", async () => {
    const result = await resetSceneFog({ id: "scene" }, { pollMs: 1 });
    assert.deepEqual(result, { id: "scene", deletedDocumentCount: 3, remainingDocumentCount: 0 });
    assert.deepEqual(emitted, [["resetFog", "scene"]]);
    assert.deepEqual([...db.keys()], ["fog-other"], "other Scenes keep their fog");
  });

  void it("still emits the reset when no fog is persisted", async () => {
    db.clear();
    const result = await resetSceneFog({ id: "scene" }, { pollMs: 1 });
    assert.equal(result.deletedDocumentCount, 0);
    assert.deepEqual(emitted, [["resetFog", "scene"]]);
  });

  void it("reports an incomplete result when fog documents remain", async () => {
    serverDeletes = false;
    await assert.rejects(
      resetSceneFog({ id: "scene" }, { timeoutMs: 20, pollMs: 1 }),
      (error: unknown) => (error as { code?: string }).code === "INCOMPLETE_RESULT",
    );
  });

  void it("requires a GM and an existing Scene before emitting anything", async () => {
    gameUser().isGM = false;
    await assert.rejects(
      resetSceneFog({ id: "scene" }),
      (error: unknown) => (error as { code?: string }).code === "PERMISSION_DENIED",
    );
    gameUser().isGM = true;
    await assert.rejects(resetSceneFog({ id: "missing" }));
    assert.deepEqual(emitted, []);
  });
});
