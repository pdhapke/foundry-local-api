// Integration test for Phase 16 — Combat & Combat Tracker, built on the
// Phase 15 template (see macros.test.ts's header comment): a real Express
// app via createApp() with a fake FoundryClient swapped onto
// `app.locals["foundryClient"]`, driven with supertest. No real
// WebSocket/bridge/Foundry instance is involved.
//
// Base CRUD is already proven generic by documents.test.ts's
// `makeDocumentEndpoints()` tests, so this file only exercises the
// combat-specific extras (start/next-turn/next-round/end, add/remove
// combatant, roll initiative) plus a smoke check that
// combatEndpointDescriptors actually mounts CRUD under `/api/combats`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import request from "supertest";

import type {
  CombatAddCombatantInput,
  CombatIdInput,
  CombatRemoveCombatantInput,
  CombatRollInitiativeInput,
  DocumentData,
  DocumentDeleteResult,
  DocumentTypeInput,
} from "@foundry-local-api/shared";

import { createApp } from "../app.js";
import type { FoundryClient } from "../bridge/foundry-client.js";
import { API_KEY_HEADER } from "../middleware/auth.js";

const API_KEY = "test-api-key-0123456789abcdef";

function buildApp(call: FoundryClient["call"]) {
  const app = createApp({
    isDevelopment: false,
    apiKey: API_KEY,
    corsAllowedOrigins: [],
    rateLimitWindowMs: 60_000,
    rateLimitMax: 1000,
    requestLogger: () => {
      /* silence request logging in tests */
    },
  });
  const fakeFoundryClient = { call } as unknown as FoundryClient;
  app.locals["foundryClient"] = fakeFoundryClient;
  return app;
}

void describe("Phase 16 combats", () => {
  void it("GET /api/combats lists documents via the generic Combat CRUD factory", async () => {
    const app = buildApp(((type: string, payload: DocumentTypeInput) => {
      assert.equal(type, "documentList");
      assert.deepEqual(payload, { documentType: "Combat" });
      const result: DocumentData[] = [{ _id: "c1", round: 1 }];
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/api/combats").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [{ _id: "c1", round: 1 }]);
  });

  void it("POST /api/combats/:id/start starts the combat", async () => {
    const app = buildApp(((type: string, payload: CombatIdInput) => {
      assert.equal(type, "combatStart");
      assert.deepEqual(payload, { id: "c1" });
      const result: DocumentData = { _id: "c1", round: 1, turn: 0 };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).post("/api/combats/c1/start").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "c1", round: 1, turn: 0 });
  });

  void it("POST /api/combats/:id/next-turn advances the turn", async () => {
    const app = buildApp(((type: string, payload: CombatIdInput) => {
      assert.equal(type, "combatNextTurn");
      assert.deepEqual(payload, { id: "c1" });
      const result: DocumentData = { _id: "c1", turn: 1 };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).post("/api/combats/c1/next-turn").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "c1", turn: 1 });
  });

  void it("POST /api/combats/:id/next-round advances the round", async () => {
    const app = buildApp(((type: string, payload: CombatIdInput) => {
      assert.equal(type, "combatNextRound");
      assert.deepEqual(payload, { id: "c1" });
      const result: DocumentData = { _id: "c1", round: 2 };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).post("/api/combats/c1/next-round").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "c1", round: 2 });
  });

  void it("POST /api/combats/:id/end ends the combat", async () => {
    const app = buildApp(((type: string, payload: CombatIdInput) => {
      assert.equal(type, "combatEnd");
      assert.deepEqual(payload, { id: "c1" });
      const result: DocumentData = { _id: "c1", round: 0 };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).post("/api/combats/c1/end").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "c1", round: 0 });
  });

  void it("POST /api/combats/:id/combatants adds a combatant from the body's `data`", async () => {
    const app = buildApp(((type: string, payload: CombatAddCombatantInput) => {
      assert.equal(type, "combatAddCombatant");
      assert.deepEqual(payload, { id: "c1", data: { tokenId: "t1" } });
      const result: DocumentData = { _id: "cb1", tokenId: "t1" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/combats/c1/combatants")
      .set(API_KEY_HEADER, API_KEY)
      .send({ data: { tokenId: "t1" } });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "cb1", tokenId: "t1" });
  });

  void it("DELETE /api/combats/:id/combatants/:combatantId removes a combatant", async () => {
    const app = buildApp(((type: string, payload: CombatRemoveCombatantInput) => {
      assert.equal(type, "combatRemoveCombatant");
      assert.deepEqual(payload, { id: "c1", combatantId: "cb1" });
      const result: DocumentDeleteResult = { id: "cb1" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .delete("/api/combats/c1/combatants/cb1")
      .set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { id: "cb1" });
  });

  void it("POST /api/combats/:id/roll-initiative rolls for specific combatant ids", async () => {
    const app = buildApp(((type: string, payload: CombatRollInitiativeInput) => {
      assert.equal(type, "combatRollInitiative");
      assert.deepEqual(payload, { id: "c1", combatantIds: ["cb1", "cb2"] });
      const result: DocumentData = { _id: "c1", combatants: [] };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/combats/c1/roll-initiative")
      .set(API_KEY_HEADER, API_KEY)
      .send({ combatantIds: ["cb1", "cb2"] });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "c1", combatants: [] });
  });

  void it("POST /api/combats/:id/roll-initiative rolls for all when no ids given", async () => {
    const app = buildApp(((type: string, payload: CombatRollInitiativeInput) => {
      assert.equal(type, "combatRollInitiative");
      assert.deepEqual(payload, { id: "c1" });
      const result: DocumentData = { _id: "c1", combatants: [] };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/combats/c1/roll-initiative")
      .set(API_KEY_HEADER, API_KEY)
      .send({});

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "c1", combatants: [] });
  });

  void it("rejects a request with a missing/incorrect API key with 401", async () => {
    const app = buildApp((() => Promise.resolve({})) as FoundryClient["call"]);

    const res = await request(app).post("/api/combats/c1/start");
    assert.equal(res.status, 401);
  });
});
