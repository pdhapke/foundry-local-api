import assert from "node:assert/strict";
import test from "node:test";
import { executeTvControl } from "./gm-tv.js";
import type { TvControlCommandInput } from "@foundry-local-api/shared";

function fixture(observeExtra: boolean) {
  const tv = { id: "tv", name: "TV", isGM: false, active: true, toObject: () => ({}) };
  const gm = { id: "gm", name: "GM", isGM: true, active: true, toObject: () => ({}) };
  const player = {
    id: "player",
    name: "Player",
    isGM: false,
    active: true,
    toObject: () => ({ character: "assigned" }),
  };
  const assigned = {
    id: "assigned",
    type: "character",
    testUserPermission: (u: { id: string }, p: string) =>
      (u.id === player.id && p === "OWNER") || u.id === tv.id,
  };
  const extra = {
    id: "extra",
    type: "character",
    testUserPermission: (u: { id: string }, p: string) =>
      (u.id === player.id && p === "OWNER") || (u.id === tv.id && observeExtra),
  };
  const tokens = [assigned, extra].map((actor) => ({
    actor,
    hasSight: true,
    controlled: false,
    document: { id: `${actor.id}-token`, hidden: false, level: "level", sight: { enabled: true } },
  }));
  const sources = new Map(
    tokens
      .filter((t) => t.actor === assigned || observeExtra)
      .map((t) => [t.actor.id, { active: true, isPreview: false, object: t }]),
  );
  let mutations = 0;
  const canvasFixture = {
    ready: true,
    scene: {
      id: "scene",
      tokenVision: true,
      grid: { size: 100, type: 1 },
      tokens: { values: () => tokens.map((t) => ({ ...t.document, actor: t.actor })).values() },
    },
    level: { id: "level" },
    stage: { pivot: { x: 0, y: 0 }, scale: { x: 1 } },
    effects: { visionSources: sources, lightSources: new Map() },
    tokens: {
      placeables: tokens,
      controlled: [],
      releaseAll: () => {
        mutations++;
      },
    },
    animatePan: async () => {
      mutations++;
    },
  };
  const storage = new Map([["foundry-local-api.clientId", "tv-complete-review"]]);
  Object.assign(globalThis, {
    game: {
      world: { id: "world" },
      release: { version: "14.368" },
      user: tv,
      users: new Map([
        [tv.id, tv],
        [gm.id, gm],
        [player.id, player],
      ]),
      collections: new Map([
        [
          "Actor",
          new Map([
            [assigned.id, assigned],
            [extra.id, extra],
          ]),
        ],
      ]),
      settings: { get: () => true },
    },
    canvas: canvasFixture,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
  const input: TvControlCommandInput = {
    version: "tv-controls-v1",
    worldId: "world",
    sceneId: "scene",
    tvUserId: "tv",
    tvClientId: "tv-complete-review",
    requestingUserId: "gm",
    action: "inspect",
  };
  return { input, mutations: () => mutations };
}
void test("independent: unassigned owned PC without TV OBSERVER cannot silently disappear from union", async () => {
  const { input, mutations } = fixture(false);
  assert.equal((await executeTvControl(input)).vision.status, "blocked");
  await assert.rejects(
    executeTvControl({
      ...input,
      action: "camera",
      camera: { x: 10, y: 10, scale: 1 },
      expectedState: { sceneId: "scene", x: 0, y: 0, scale: 1 },
      idempotencyKey: "review-unassigned-missing",
    }),
  );
  assert.equal(mutations(), 0);
});
void test("independent: native union verifies every owned Character even when only one is assigned", async () => {
  const { input, mutations } = fixture(true);
  const result = await executeTvControl(input);
  assert.equal(result.vision.status, "verified");
  assert.equal(result.vision.permissionsChanged, false);
  assert.equal(mutations(), 0);
});
