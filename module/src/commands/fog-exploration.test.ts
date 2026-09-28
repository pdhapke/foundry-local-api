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
