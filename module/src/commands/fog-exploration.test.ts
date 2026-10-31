import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { getFogExploration, updateFogExploration } from "./fog-exploration.js";

const savedGame = Object.getOwnPropertyDescriptor(globalThis, "game");
const savedConfig = Object.getOwnPropertyDescriptor(globalThis, "CONFIG");

function install(existing?: { explored: string | null; positions: Record<string, unknown> }) {
  const fogs = new Map<string, any>();
  const make = (
    id: string,
    state: { explored: string | null; positions: Record<string, unknown> },
  ) => {
    const source: Record<string, unknown> = { _id: id, scene: "scene", user: "player", ...state };
    const document = {
      id,
      toObject: () => structuredClone(source),
      update: (changes: Record<string, unknown>) => {
        Object.assign(source, changes);
        return Promise.resolve(document);
      },
      delete: () => {
        fogs.delete(id);
        return Promise.resolve(document);
      },
    };
    fogs.set(id, document);
    return document;
  };
  if (existing) make("fog-1", existing);
  Object.defineProperty(globalThis, "game", {
    configurable: true,
    value: {
      user: { id: "gm", isGM: true },
      users: new Map([["player", { id: "player" }]]),
      collections: new Map([
        ["Scene", new Map([["scene", { id: "scene" }]])],
        ["FogExploration", fogs],
      ]),
    },
  });
  Object.defineProperty(globalThis, "CONFIG", {
    configurable: true,
    value: {
      FogExploration: {
        documentClass: {
          create: async (data: Record<string, unknown>, options?: Record<string, unknown>) => {
            const document = make(
              options?.["keepId"] === true && typeof data["_id"] === "string"
                ? data["_id"]
                : `fog-created-${fogs.size + 1}`,
              {
                explored: (data["explored"] as string | null) ?? null,
                positions: (data["positions"] as Record<string, unknown>) ?? {},
              },
            );
            await document.update(data);
            return document;
          },
        },
      },
    },
  });
  return fogs;
}

afterEach(() => {
  if (savedGame) Object.defineProperty(globalThis, "game", savedGame);
  else Reflect.deleteProperty(globalThis, "game");
  if (savedConfig) Object.defineProperty(globalThis, "CONFIG", savedConfig);
  else Reflect.deleteProperty(globalThis, "CONFIG");
});

void describe("fog exploration commands", () => {
  void it("reads empty fog, merges positions without revealing explored texture, and replays", async () => {
    install();
    const empty = await getFogExploration({ sceneId: "scene", userId: "player" });
    assert.equal(empty.exists, false);
    const first = await updateFogExploration({
      sceneId: "scene",
      userId: "player",
      mode: "merge",
      state: { positions: { origin: { x: 1, y: 2 } } },
      expectedRevision: empty.revision,
      idempotencyKey: "fog-merge-test-0001",
    });
    assert.equal(first.after.state.explored, null);
    assert.deepEqual(first.after.state.positions, { origin: { x: 1, y: 2 } });
    const replay = await updateFogExploration({
      sceneId: "scene",
      userId: "player",
      mode: "merge",
      state: { positions: { origin: { x: 1, y: 2 } } },
      expectedRevision: empty.revision,
      idempotencyKey: "fog-merge-test-0001",
    });
    assert.equal(replay.replayed, true);
    await assert.rejects(
      updateFogExploration({
        sceneId: "scene",
        userId: "player",
        mode: "merge",
        state: { explored: "cannot-union" },
        expectedRevision: first.after.revision,
        idempotencyKey: "fog-unsafe-merge-0001",
      }),
      (error: unknown) =>
        (error as { code?: string; fieldPath?: string }).code === "INVALID_PAYLOAD" &&
        (error as { fieldPath?: string }).fieldPath === "state.explored",
    );
  });

  void it("replaces state exactly, rejects stale revisions, and restores absence", async () => {
    const fogs = install({ explored: "old", positions: { old: { x: 1, y: 1 } } });
    const before = await getFogExploration({ sceneId: "scene", userId: "player" });
    const replaced = await updateFogExploration({
      sceneId: "scene",
      userId: "player",
      mode: "replace",
      state: { explored: "new", positions: { new: { x: 2, y: 2 } } },
      expectedRevision: before.revision,
      idempotencyKey: "fog-replace-test-0001",
    });
    assert.deepEqual(replaced.after.state, {
      explored: "new",
      positions: { new: { x: 2, y: 2 } },
    });
    await assert.rejects(
      updateFogExploration({
        sceneId: "scene",
        userId: "player",
        mode: "replace",
        state: {},
        expectedRevision: before.revision,
        idempotencyKey: "fog-stale-test-0001",
      }),
      (error: unknown) => (error as { code?: string }).code === "STALE_REVISION",
    );
    await updateFogExploration({
      sceneId: "scene",
      userId: "player",
      mode: "replace",
      state: { explored: null, positions: {} },
      removeDocument: true,
      expectedRevision: replaced.after.revision,
      idempotencyKey: "fog-restore-test-0001",
    });
    assert.equal(fogs.size, 0);
  });

  void it("compensates a create whose independent readback differs and does not cache failure", async () => {
    const fogs = install();
    const before = await getFogExploration({ sceneId: "scene", userId: "player" });
    const documentClass = CONFIG["FogExploration"]!.documentClass;
    const create = documentClass.create.bind(documentClass);
    let corrupt = true;
    documentClass.create = async (data, options) => {
      const created = await create(data, options);
      if (created && corrupt) await created.update({ positions: { corrupt: { x: 99, y: 99 } } });
      return created;
    };
    const input = {
      sceneId: "scene",
      userId: "player",
      mode: "replace" as const,
      state: { explored: "new", positions: { expected: { x: 2, y: 3 } } },
      expectedRevision: before.revision,
      idempotencyKey: "fog-create-verify-0001",
    };
    await assert.rejects(
      updateFogExploration(input),
      (error: unknown) => (error as { code?: string }).code === "INCOMPLETE_RESULT",
    );
    assert.equal(fogs.size, 0, "failed create verification restores exact absence");
    assert.deepEqual(await getFogExploration({ sceneId: "scene", userId: "player" }), before);

    corrupt = false;
    const retry = await updateFogExploration(input);
    assert.equal(retry.replayed, false, "a compensated failure is not added to replay state");
    assert.deepEqual(retry.after.state, input.state);
  });

  void it("compensates an update verification failure and replays only the verified retry", async () => {
    const fogs = install({ explored: "old", positions: { old: { x: 1, y: 1 } } });
    const before = await getFogExploration({ sceneId: "scene", userId: "player" });
    const document = fogs.get("fog-1")!;
    const update = document.update.bind(document);
    let updateCalls = 0;
    document.update = async (changes: Record<string, unknown>) => {
      updateCalls += 1;
      const result = await update(changes);
      if (updateCalls === 1) await update({ positions: { corrupt: { x: 99, y: 99 } } });
      return result;
    };
    const input = {
      sceneId: "scene",
      userId: "player",
      mode: "replace" as const,
      state: { explored: "new", positions: { expected: { x: 2, y: 3 } } },
      expectedRevision: before.revision,
      idempotencyKey: "fog-update-verify-0001",
    };
    await assert.rejects(
      updateFogExploration(input),
      (error: unknown) => (error as { code?: string }).code === "INCOMPLETE_RESULT",
    );
    const restored = await getFogExploration({ sceneId: "scene", userId: "player" });
    assert.deepEqual(restored, before, "failed update verification restores the before-image");

    const retry = await updateFogExploration(input);
    assert.equal(retry.replayed, false);
    const callsAfterSuccess = updateCalls;
    const replay = await updateFogExploration(input);
    assert.equal(replay.replayed, true);
    assert.equal(updateCalls, callsAfterSuccess, "replay performs no additional persistence call");
  });

  void it("compensates failed delete verification with the exact ID/state and verifies absence", async () => {
    const fogs = install({ explored: "old", positions: { old: { x: 1, y: 1 } } });
    const before = await getFogExploration({ sceneId: "scene", userId: "player" });
    const document = fogs.get("fog-1")!;
    const remove = document.delete.bind(document);
    document.delete = async () => {
      const result = await remove();
      await CONFIG["FogExploration"]!.documentClass.create({
        scene: "scene",
        user: "player",
        explored: "wrong",
        positions: {},
      });
      return result;
    };
    const input = {
      sceneId: "scene",
      userId: "player",
      mode: "replace" as const,
      state: { explored: null, positions: {} },
      removeDocument: true,
      expectedRevision: before.revision,
      idempotencyKey: "fog-delete-verify-0001",
    };
    await assert.rejects(
      updateFogExploration(input),
      (error: unknown) => (error as { code?: string }).code === "INCOMPLETE_RESULT",
    );
    assert.deepEqual([...fogs.keys()], ["fog-1"]);
    assert.deepEqual(
      await getFogExploration({ sceneId: "scene", userId: "player" }),
      before,
      "failed deletion restores the exact document identity and state",
    );

    const removed = await updateFogExploration(input);
    assert.equal(removed.after.exists, false);
    assert.equal(fogs.size, 0);
    const replay = await updateFogExploration(input);
    assert.equal(replay.replayed, true);
    assert.equal(fogs.size, 0);
  });

  void it("verifies and replays an idempotent restore of prior absence without persistence", async () => {
    const fogs = install();
    const before = await getFogExploration({ sceneId: "scene", userId: "player" });
    const input = {
      sceneId: "scene",
      userId: "player",
      mode: "replace" as const,
      state: { explored: null, positions: {} },
      removeDocument: true,
      expectedRevision: before.revision,
      idempotencyKey: "fog-absent-restore-0001",
    };
    const restored = await updateFogExploration(input);
    assert.equal(restored.before.exists, false);
    assert.equal(restored.after.exists, false);
    assert.equal(fogs.size, 0);
    const replay = await updateFogExploration(input);
    assert.equal(replay.replayed, true);
    assert.equal(fogs.size, 0);
  });

  void it("fails closed before mutation when duplicate fog documents already exist", async () => {
    install({ explored: null, positions: {} });
    const collection = (globalThis as any).game.collections.get("FogExploration") as Map<
      string,
      unknown
    >;
    collection.set("fog-duplicate", collection.get("fog-1"));
    const before = structuredClone([...collection.keys()]);
    await assert.rejects(
      getFogExploration({ sceneId: "scene", userId: "player" }),
      (error: unknown) => (error as { code?: string }).code === "INCOMPLETE_RESULT",
    );
    assert.deepEqual([...collection.keys()], before);
  });

  void it("isolates exact state and revisions between users on the same Scene", async () => {
    const fogs = install();
    (globalThis as any).game.users.set("player-two", { id: "player-two" });
    const playerOneBefore = await getFogExploration({ sceneId: "scene", userId: "player" });
    const playerTwoBefore = await getFogExploration({
      sceneId: "scene",
      userId: "player-two",
    });
    const playerOne = await updateFogExploration({
      sceneId: "scene",
      userId: "player",
      mode: "replace",
      state: { explored: "player-one", positions: { one: { x: 1, y: 2 } } },
      expectedRevision: playerOneBefore.revision,
      idempotencyKey: "fog-player-one-0001",
    });
    const playerTwo = await updateFogExploration({
      sceneId: "scene",
      userId: "player-two",
      mode: "replace",
      state: { explored: "player-two", positions: { two: { x: 3, y: 4 } } },
      expectedRevision: playerTwoBefore.revision,
      idempotencyKey: "fog-player-two-0001",
    });

    assert.equal(fogs.size, 2);
    assert.equal(playerOne.after.userId, "player");
    assert.equal(playerTwo.after.userId, "player-two");
    assert.deepEqual(
      (await getFogExploration({ sceneId: "scene", userId: "player" })).state,
      playerOne.after.state,
    );
    assert.deepEqual(
      (await getFogExploration({ sceneId: "scene", userId: "player-two" })).state,
      playerTwo.after.state,
    );
  });
});

interface DatabaseFogOptions {
  levels: string[];
  view?: string | null;
  fogs?: Array<{ id: string; user: string; level: string; explored: string | null }>;
}

/**
 * Foundry v14-shaped fixture: fog lives in the world database (reachable through
 * `documentClass.database.get`), the GM client's FogExploration collection only caches its own
 * documents, and the backend throws when it applies a mutation to an uncached document.
 */
function installDatabase({ levels, view = null, fogs = [] }: DatabaseFogOptions) {
  const db = new Map<string, Record<string, unknown>>();
  const collection = new Map<string, any>();
  let created = 0;
  const instance = (id: string) => {
    const document: any = {
      id,
      toObject: () => structuredClone(db.get(id) ?? {}),
      update: (changes: Record<string, unknown>) => {
        if (collection.get(id) !== document) throw new Error("FogExploration is not cached");
        Object.assign(db.get(id)!, structuredClone(changes));
        return Promise.resolve(document);
      },
      delete: () => {
        if (collection.get(id) !== document) throw new Error("FogExploration is not cached");
        db.delete(id);
        collection.delete(id);
        return Promise.resolve(document);
      },
    };
    return document;
  };
  for (const fog of fogs) {
    db.set(fog.id, {
      _id: fog.id,
      scene: "scene",
      user: fog.user,
      level: fog.level,
      explored: fog.explored,
      positions: {},
    });
  }
  const scene = {
    id: "scene",
    levels: new Map(levels.map((level) => [level, { id: level }])),
    _view: view,
    initialLevel: levels[0] ? { id: levels[0] } : null,
    firstLevel: levels[0] ? { id: levels[0] } : null,
  };
  Object.defineProperty(globalThis, "game", {
    configurable: true,
    value: {
      user: { id: "gm", isGM: true },
      users: new Map([
        ["gm", { id: "gm" }],
        ["player", { id: "player" }],
      ]),
      collections: new Map<string, unknown>([
        ["Scene", new Map([["scene", scene]])],
        ["FogExploration", collection],
      ]),
    },
  });
  Object.defineProperty(globalThis, "CONFIG", {
    configurable: true,
    value: {
      FogExploration: {
        documentClass: {
          create: (data: Record<string, unknown>, options?: Record<string, unknown>) => {
            const id =
              options?.["keepId"] === true && typeof data["_id"] === "string"
                ? data["_id"]
                : `fog-created-${++created}`;
            db.set(id, {
              explored: null,
              positions: {},
              ...structuredClone(data),
              _id: id,
            });
            const document = instance(id);
            collection.set(id, document);
            return Promise.resolve(document);
          },
          database: {
            get: (_documentClass: unknown, operation: Record<string, unknown>) => {
              const query = (operation["query"] ?? {}) as Record<string, unknown>;
              return Promise.resolve(
                [...db.values()]
                  .filter((source) =>
                    Object.entries(query).every(([key, value]) => source[key] === value),
                  )
                  .map((source) => instance(source["_id"] as string)),
              );
            },
          },
        },
      },
    },
  });
  return { db, collection };
}

void describe("fog exploration on Foundry v14 (database-backed, per Level)", () => {
  void it("reads and edits another user's fog that the GM client does not cache", async () => {
    const { db, collection } = installDatabase({
      levels: ["level-a"],
      fogs: [{ id: "fog-1", user: "player", level: "level-a", explored: "seen" }],
    });
    const before = await getFogExploration({ sceneId: "scene", userId: "player" });
    assert.equal(before.exists, true);
    assert.equal(before.level, "level-a");
    assert.equal(before.documentId, "fog-1");
    assert.equal(before.state.explored, "seen");

    const replaced = await updateFogExploration({
      sceneId: "scene",
      userId: "player",
      mode: "replace",
      state: { explored: "updated", positions: { p: { x: 1, y: 1 } } },
      expectedRevision: before.revision,
      idempotencyKey: "fog-v14-replace-0001",
    });
    assert.equal(replaced.after.state.explored, "updated");
    assert.equal(db.get("fog-1")!["explored"], "updated");
    assert.equal(collection.size, 0, "another user's fog is not left in the GM cache");

    const removed = await updateFogExploration({
      sceneId: "scene",
      userId: "player",
      mode: "replace",
      state: { explored: null, positions: {} },
      removeDocument: true,
      expectedRevision: replaced.after.revision,
      idempotencyKey: "fog-v14-remove-0001",
    });
    assert.equal(removed.after.exists, false);
    assert.equal(db.size, 0);
    assert.equal(collection.size, 0);
  });

  void it("creates another user's fog on the resolved Level without caching it", async () => {
    const { db, collection } = installDatabase({ levels: ["level-a"] });
    const before = await getFogExploration({ sceneId: "scene", userId: "player" });
    assert.equal(before.exists, false);
    const created = await updateFogExploration({
      sceneId: "scene",
      userId: "player",
      mode: "merge",
      state: { positions: { p: { x: 2, y: 3 } } },
      expectedRevision: before.revision,
      idempotencyKey: "fog-v14-create-0001",
    });
    assert.equal(created.after.exists, true);
    assert.equal(created.after.level, "level-a");
    const [stored] = [...db.values()];
    assert.equal(stored!["user"], "player");
    assert.equal(stored!["scene"], "scene");
    assert.equal(stored!["level"], "level-a");
    assert.equal(collection.size, 0);
  });

  void it("keys fog per Level and defaults to the viewed Level", async () => {
    installDatabase({
      levels: ["level-a", "level-b"],
      view: "level-b",
      fogs: [
        { id: "fog-a", user: "player", level: "level-a", explored: "same" },
        { id: "fog-b", user: "player", level: "level-b", explored: "same" },
      ],
    });
    const viewed = await getFogExploration({ sceneId: "scene", userId: "player" });
    assert.equal(viewed.level, "level-b");
    assert.equal(viewed.documentId, "fog-b");
    const levelA = await getFogExploration({
      sceneId: "scene",
      userId: "player",
      level: "level-a",
    });
    assert.equal(levelA.documentId, "fog-a");
    assert.notEqual(levelA.revision, viewed.revision, "revisions are bound to the Level");
    await assert.rejects(
      getFogExploration({ sceneId: "scene", userId: "player", level: "missing" }),
      (error: unknown) => (error as { code?: string }).code === "NOT_FOUND",
    );
  });

  void it("rejects a Level on Scenes without Levels", async () => {
    install();
    await assert.rejects(
      getFogExploration({ sceneId: "scene", userId: "player", level: "level-a" }),
      (error: unknown) => (error as { code?: string }).code === "INVALID_PAYLOAD",
    );
  });
});
