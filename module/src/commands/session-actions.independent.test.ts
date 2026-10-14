import assert from "node:assert/strict";
import test from "node:test";
import { applySessionAction, readSessionAction } from "./session-actions.js";

void test("independent: installed Foundry record-shaped CONFIG.statusEffects supports trusted condition read", () => {
  const actor = {
    id: "actor",
    statuses: new Set<string>(),
    toggleStatusEffect: async () => {},
    toObject: () => ({}),
  };
  const scene = {
    toObject: () => ({ active: true }),
    getEmbeddedCollection: () => new Map([["token", { actor }]]),
  };
  const gm = { id: "gm", isGM: true, active: true };
  Object.assign(globalThis, {
    game: {
      world: { id: "world" },
      user: gm,
      users: new Map([["gm", gm]]),
      collections: new Map([["Scene", new Map([["scene", scene]])]]),
    },
    CONFIG: { statusEffects: { prone: { id: "prone" } } },
  });
  assert.deepEqual(
    readSessionAction({
      worldId: "world",
      requestingUserId: "gm",
      action: {
        kind: "actor.condition",
        sceneId: "scene",
        targetId: "actor",
        conditionId: "prone",
        active: true,
      },
    }).state,
    { active: false },
  );
});

void test("independent: record-configured status factory writes and deletes with authoritative options and separate read-back", async () => {
  const effects = new Map<string, { id: string; statuses: Set<string> }>();
  const calls: Record<string, unknown>[] = [];
  const actor = {
    id: "actor",
    statuses: new Set<string>(),
    effects,
    toObject: () => ({}),
    deleteEmbeddedDocuments: (_name: string, ids: string[], options: Record<string, unknown>) => {
      calls.push(options);
      ids.forEach((id) => effects.delete(id));
      actor.statuses.delete("prone");
      return Promise.resolve();
    },
  };
  const scene = {
    toObject: () => ({ active: true }),
    getEmbeddedCollection: () => new Map([["token", { actor }]]),
  };
  const gm = { id: "gm", isGM: true, active: true };
  Object.assign(globalThis, {
    game: {
      world: { id: "world" },
      user: gm,
      users: new Map([["gm", gm]]),
      collections: new Map([["Scene", new Map([["scene", scene]])]]),
    },
    CONFIG: {
      statusEffects: { prone: { id: "prone" } },
      ActiveEffect: {
        documentClass: {
          fromStatusEffect: (id: string) =>
            Promise.resolve({ toObject: () => ({ statuses: [id] }) }),
          create: (_data: unknown, options: Record<string, unknown>) => {
            calls.push(options);
            effects.set("effect", { id: "effect", statuses: new Set(["prone"]) });
            actor.statuses.add("prone");
            return Promise.resolve();
          },
        },
      },
    },
  });
  for (const active of [true, false]) {
    const input = {
      worldId: "world",
      requestingUserId: "gm",
      action: {
        kind: "actor.condition" as const,
        sceneId: "scene",
        targetId: "actor",
        conditionId: "prone",
        active,
      },
    };
    const result = await applySessionAction({
      ...input,
      expectedState: readSessionAction(input).state,
      correlationId: "validated-origin",
      idempotencyKey: "validated-action",
    });
    assert.equal(result.verified, true);
    assert.deepEqual(readSessionAction(input).state, { active });
    assert.deepEqual(calls.at(-1)?.["foundryLocalApiOrigin"], {
      source: "foundry-local-api.session-action",
      phase: "apply",
      correlationId: "validated-origin",
    });
  }
  assert.equal(calls.length, 2);
});
