// Phase 34 — unit tests for the dnd5e integration's REST descriptors.
//
// Mounts `dnd5eEndpointDescriptors` directly via `mountRestEndpoints` on a
// bare Express app (registry.test.ts's/router.test.ts's "small standalone
// app" harness style), not through the dynamic integration router
// (../router.ts) — that indirection (active/inactive gating, 404 naming) is
// already covered by Phase 32's router.test.ts. This file only needs to
// prove each descriptor reaches the right bridge command with the right
// input and returns the handler's result untouched.
//
// Phase 35 added seven write-action descriptors below the original three
// read-only ones — one happy-path assertion per new route (including that
// its path param merges with its body into one input), matching this file's
// own existing level of thoroughness rather than exhaustive per-route edge
// cases.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import express from "express";
import request from "supertest";

import type {
  Dnd5eAbilityRollInput,
  Dnd5eActorIdInput,
  Dnd5eActorSheetResult,
  Dnd5eConfigResult,
  Dnd5eInventoryItem,
  Dnd5eItemUseInput,
  Dnd5eItemUseResult,
  Dnd5eRestInput,
  Dnd5eRestResult,
  Dnd5eRollActionResult,
  Dnd5eSkillRollInput,
  Dnd5eSpellSlotInput,
  Dnd5eSpellSlotResult,
} from "@foundry-local-api/shared";

// Side-effect-only import, and deliberately first: same pre-existing
// circular-import workaround router.test.ts documents (endpoints/index.ts ->
// events.ts -> app.js -> routes/api.ts -> endpoints/index.ts). This file's
// `../../endpoints/registry.js` import below transitively reaches that same
// cycle from a different edge; without forcing `../../app.js` to evaluate
// first, `registerRestRoute` blows up at runtime (`__name is not a
// function`) because `../../endpoints/registry.js` hasn't finished
// initializing yet.
import "../../app.js";
import type { FoundryClient } from "../../bridge/foundry-client.js";
import { mountRestEndpoints } from "../../endpoints/registry.js";
import { dnd5eEndpointDescriptors } from "./endpoints.js";

function buildTestApp(call: FoundryClient["call"]): express.Express {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  mountRestEndpoints(router, dnd5eEndpointDescriptors);
  app.use(router);
  app.locals["foundryClient"] = { call } as unknown as FoundryClient;
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: { message: (err as Error).message } });
    },
  );
  return app;
}

const CONFIG_FIXTURE: Dnd5eConfigResult = {
  abilities: [{ id: "str", label: "Strength", abbreviation: "Str" }],
  skills: [{ id: "acr", label: "Acrobatics", ability: "dex" }],
  damageTypes: [{ id: "fire", label: "Fire" }],
  conditionTypes: [{ id: "blinded", label: "Blinded" }],
};

const SHEET_FIXTURE: Dnd5eActorSheetResult = {
  id: "actor1",
  name: "Test Hero",
  abilities: { str: { value: 16, mod: 3, save: 5, proficient: 1 } },
  skills: { acr: { total: 5, passive: 15, proficient: 1, ability: "dex" } },
  armorClass: 16,
  hitPoints: { value: 20, max: 24, temp: 0 },
  senses: { darkvision: 60 },
  currency: { gp: 15 },
  spellSlots: { spell1: { value: 2, max: 4 } },
  classes: [{ name: "Fighter", level: 3 }],
  level: 3,
  proficiencyBonus: 2,
};

const INVENTORY_FIXTURE: Dnd5eInventoryItem[] = [
  {
    id: "item1",
    name: "Longsword",
    type: "weapon",
    quantity: 1,
    equipped: true,
    attuned: false,
    activities: [{ id: "act1", name: "Attack", type: "attack" }],
  },
];

const ROLL_FIXTURE: Dnd5eRollActionResult = {
  formula: "1d20 + 3",
  total: 18,
  result: "(15) + 3",
  dice: [{ faces: 20, results: [15] }],
};

const REST_FIXTURE: Dnd5eRestResult = { type: "short", deltaHitPoints: 5, newDay: false };

const SPELL_SLOT_FIXTURE: Dnd5eSpellSlotResult = { level: 1, value: 3, max: 4 };

const ITEM_USE_FIXTURE: Dnd5eItemUseResult = { id: "item1", name: "Potion of Healing", used: true };

void describe("dnd5e integration endpoints", () => {
  void it("GET /dnd5e/config calls the CONFIG command and returns its result untouched", async () => {
    const app = buildTestApp(((type: string) => {
      assert.equal(type, "dnd5eConfig");
      return Promise.resolve(CONFIG_FIXTURE);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/dnd5e/config");

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, CONFIG_FIXTURE);
  });

  void it("GET /dnd5e/actors/:id/sheet calls the ACTOR_SHEET command with the id and returns its result untouched", async () => {
    const app = buildTestApp(((type: string, payload: Dnd5eActorIdInput) => {
      assert.equal(type, "dnd5eActorSheet");
      assert.deepEqual(payload, { id: "actor1" });
      return Promise.resolve(SHEET_FIXTURE);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/dnd5e/actors/actor1/sheet");

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, SHEET_FIXTURE);
  });

  void it("GET /dnd5e/actors/:id/inventory calls the ACTOR_INVENTORY command with the id and returns its result untouched", async () => {
    const app = buildTestApp(((type: string, payload: Dnd5eActorIdInput) => {
      assert.equal(type, "dnd5eActorInventory");
      assert.deepEqual(payload, { id: "actor1" });
      return Promise.resolve(INVENTORY_FIXTURE);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/dnd5e/actors/actor1/inventory");

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, INVENTORY_FIXTURE);
  });

  void it("POST /dnd5e/actors/:id/roll/ability-check calls ROLL_ABILITY_CHECK with the merged id+body", async () => {
    const app = buildTestApp(((type: string, payload: Dnd5eAbilityRollInput) => {
      assert.equal(type, "dnd5eRollAbilityCheck");
      assert.deepEqual(payload, { id: "actor1", ability: "str" });
      return Promise.resolve(ROLL_FIXTURE);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/dnd5e/actors/actor1/roll/ability-check")
      .send({ ability: "str" });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, ROLL_FIXTURE);
  });

  void it("POST /dnd5e/actors/:id/roll/saving-throw calls ROLL_SAVING_THROW with the merged id+body", async () => {
    const app = buildTestApp(((type: string, payload: Dnd5eAbilityRollInput) => {
      assert.equal(type, "dnd5eRollSavingThrow");
      assert.deepEqual(payload, { id: "actor1", ability: "dex" });
      return Promise.resolve(ROLL_FIXTURE);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/dnd5e/actors/actor1/roll/saving-throw")
      .send({ ability: "dex" });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, ROLL_FIXTURE);
  });

  void it("POST /dnd5e/actors/:id/roll/skill calls ROLL_SKILL with the merged id+body", async () => {
    const app = buildTestApp(((type: string, payload: Dnd5eSkillRollInput) => {
      assert.equal(type, "dnd5eRollSkill");
      assert.deepEqual(payload, { id: "actor1", skill: "acr" });
      return Promise.resolve(ROLL_FIXTURE);
    }) as FoundryClient["call"]);

    const res = await request(app).post("/dnd5e/actors/actor1/roll/skill").send({ skill: "acr" });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, ROLL_FIXTURE);
  });

  void it("POST /dnd5e/actors/:id/roll/death-save calls ROLL_DEATH_SAVE with just the id", async () => {
    const app = buildTestApp(((type: string, payload: Dnd5eActorIdInput) => {
      assert.equal(type, "dnd5eRollDeathSave");
      assert.deepEqual(payload, { id: "actor1" });
      return Promise.resolve(ROLL_FIXTURE);
    }) as FoundryClient["call"]);

    const res = await request(app).post("/dnd5e/actors/actor1/roll/death-save").send({});

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, ROLL_FIXTURE);
  });

  void it("POST /dnd5e/actors/:id/rest calls REST with the merged id+body", async () => {
    const app = buildTestApp(((type: string, payload: Dnd5eRestInput) => {
      assert.equal(type, "dnd5eRest");
      assert.deepEqual(payload, { id: "actor1", type: "short" });
      return Promise.resolve(REST_FIXTURE);
    }) as FoundryClient["call"]);

    const res = await request(app).post("/dnd5e/actors/actor1/rest").send({ type: "short" });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, REST_FIXTURE);
  });

  void it("POST /dnd5e/actors/:id/spell-slots calls ADJUST_SPELL_SLOT with the merged id+body", async () => {
    const app = buildTestApp(((type: string, payload: Dnd5eSpellSlotInput) => {
      assert.equal(type, "dnd5eAdjustSpellSlot");
      assert.deepEqual(payload, { id: "actor1", level: 1, delta: -1 });
      return Promise.resolve(SPELL_SLOT_FIXTURE);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/dnd5e/actors/actor1/spell-slots")
      .send({ level: 1, delta: -1 });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, SPELL_SLOT_FIXTURE);
  });

  void it("POST /dnd5e/items/:id/use calls USE_ITEM with just the id", async () => {
    const app = buildTestApp(((type: string, payload: Dnd5eItemUseInput) => {
      assert.equal(type, "dnd5eUseItem");
      assert.deepEqual(payload, { id: "item1" });
      return Promise.resolve(ITEM_USE_FIXTURE);
    }) as FoundryClient["call"]);

    const res = await request(app).post("/dnd5e/items/item1/use").send({});

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, ITEM_USE_FIXTURE);
  });
});
