import assert from "node:assert/strict";
import test from "node:test";
import type { GmActivityInput } from "@foundry-local-api/shared";
import { placeActivity, placementState } from "./gm-activity-placement.js";

type Obj = Record<string, any>;
function fixture(change: "scene" | "actor" | "geometry" | "level" | "canvas") {
  let creates = 0,
    counts = 0;
  const source = { _id: "wolf", ownership: { default: 0, gm: 3 } };
  const actor = {
    id: "wolf",
    uuid: "Actor.wolf",
    isOwner: true,
    toObject: () => structuredClone(source),
    prototypeToken: { actorLink: false, randomImg: false, toObject: () => ({ actorLink: false }) },
  };
  const sceneData = { active: true, width: 1000, height: 1000, grid: { units: "ft" } };
  const tokens = new Map<string, Obj>();
  const scene: Obj = {
    id: "scene",
    toObject: () => structuredClone(sceneData),
    async createEmbeddedDocuments() {
      creates++;
      return [];
    },
    getEmbeddedCollection: () => tokens,
  };
  const scenes = new Map([["scene", scene]]),
    actors = new Map<string, Obj>([["wolf", actor]]);
  const gm = { id: "gm", active: true, isGM: true };
  Object.assign(globalThis, {
    game: {
      user: gm,
      users: new Map([["gm", gm]]),
      world: { id: "world" },
      release: { version: "14.368" },
      system: { id: "dnd5e", version: "6.0.3" },
      collections: new Map<string, unknown>([
        ["Scene", scenes],
        ["Actor", actors],
      ]),
    },
    canvas: { scene, level: { id: "lower" } },
    CONFIG: { DND5E: { actorSizes: {} } },
    Hooks: { call: () => true, callAll: () => undefined },
    Roll: class {
      formula = "1";
      total = 1;
      async evaluate() {
        counts++;
        if (change === "scene") scenes.set("scene", { ...scene });
        if (change === "actor") actors.set("wolf", { ...actor });
        if (change === "geometry") sceneData.width = 10;
        if (change === "level") (globalThis as unknown as Obj).canvas.level = { id: "upper" };
        if (change === "canvas")
          (globalThis as unknown as Obj).canvas = { ...(globalThis as unknown as Obj).canvas };
        return this;
      }
    },
  });
  const activity: Obj = {
    id: "summon",
    uuid: "Actor.caster.Item.spell.Activity.summon",
    item: { uuid: "Actor.caster.Item.spell" },
    profiles: [{ _id: "profile", uuid: "Actor.wolf", count: "1" }],
    getRollData: () => ({}),
    async getChanges() {
      return {
        actorUpdates: {
          "flags.dnd5e.summon": { origin: this.item.uuid, activity: this.id, profile: "profile" },
        },
        tokenUpdates: {},
      };
    },
    async getTokenData(c: Obj) {
      return { actorId: c.actor.id, actorLink: false, ...c.placement, delta: c.actorUpdates };
    },
  };
  activity.availableProfiles = activity.profiles;
  activity.item.system = { activities: new Map([["summon", activity]]) };
  tokens.set("caster-token", {
    id: "caster-token",
    uuid: "Scene.scene.Token.caster-token",
    toObject: () => ({ _id: "caster-token", flags: {} }),
    actor: { items: new Map([["spell", activity.item]]) },
  });
  const input = {
    schemaVersion: "gm-actions-v1",
    worldId: "world",
    userId: "gm",
    sceneId: "scene",
    action: {
      tokenId: "caster-token",
      itemId: "spell",
      activityId: "summon",
      summon: {
        actorId: "wolf",
        profileId: "profile",
        placements: [{ x: 500, y: 500, elevation: 0, rotation: 0 }],
        ruling: "Explicit native position",
      },
    },
  } as unknown as GmActivityInput;
  return { input, activity, creations: () => creates, countRolls: () => counts };
}
void test("independent: bounded native output recovery declares incomplete inventory instead of silently claiming all outputs", () => {
  const f = fixture("scene");
  const scene = (globalThis as unknown as Obj).canvas.scene;
  const regions = new Map(
    Array.from({ length: 260 }, (_, i) => {
      const id = "region-" + i;
      return [
        id,
        {
          id,
          uuid: "Scene.scene.Region." + id,
          toObject: () => ({
            flags: {
              dnd5e: { activity: f.activity.uuid },
              "foundry-local-api": { idempotencyKey: "original-intent" },
            },
          }),
        },
      ] as const;
    }),
  );
  scene.getEmbeddedCollection = (name: string) => (name === "Region" ? regions : new Map());
  const state = placementState(f.input, f.activity);
  assert.equal(state.existingOutputs.length, 256);
  assert.equal(state.outputInventory.complete, false);
  assert.equal(state.outputInventory.matchedCounts.Region, 260);
});
for (const change of ["scene", "actor", "geometry", "level", "canvas"] as const) {
  void test(`independent: summon ${change} replacement while native count awaits prevents token creation`, async () => {
    const f = fixture(change);
    await assert.rejects(() => placeActivity(f.input, f.activity));
    assert.equal(
      f.countRolls(),
      1,
      "probe reached the awaited native count before rejecting changed binding",
    );
    assert.equal(f.creations(), 0, "must refuse before creating tokens on stale native binding");
  });
}
