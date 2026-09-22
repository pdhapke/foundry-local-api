// Phase 34 — unit tests for the dnd5e integration's three REST descriptors.
//
// Mounts `dnd5eEndpointDescriptors` directly via `mountRestEndpoints` on a
// bare Express app (registry.test.ts's/router.test.ts's "small standalone
// app" harness style), not through the dynamic integration router
// (../router.ts) — that indirection (active/inactive gating, 404 naming) is
// already covered by Phase 32's router.test.ts. This file only needs to
// prove each of the 3 descriptors reaches the right bridge command with the
// right input and returns the handler's result untouched.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import express from "express";
import request from "supertest";

import type {
  Dnd5eActorIdInput,
  Dnd5eActorSheetResult,
  Dnd5eConfigResult,
  Dnd5eInventoryItem,
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
});
