// Integration test for Phase 21 — Active Effects, built on the Phase 20
// template (see packs.test.ts's header comment): a real Express app via
// createApp() with a fake FoundryClient swapped onto
// `app.locals["foundryClient"]`, driven with supertest. No real
// WebSocket/bridge/Foundry instance is involved.
//
// `makeEmbeddedEffectEndpoints()` is called once per parent type (Actor,
// Item); this exercises the Actor-parented routes fully (all five CRUD
// operations) plus one Item-parented route to prove the second call wires
// up its own `parentType`/`routeBase` correctly rather than colliding with
// the first.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import request from "supertest";

import type {
  DocumentData,
  DocumentDeleteResult,
  EffectCreateInput,
  EffectIdInput,
  EffectParentInput,
  EffectUpdateInput,
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

void describe("Phase 21 active effects", () => {
  void it("GET /api/actors/:parentId/effects lists an actor's embedded effects", async () => {
    const app = buildApp(((type: string, payload: EffectParentInput) => {
      assert.equal(type, "effectList");
      assert.deepEqual(payload, { parentType: "Actor", parentId: "a1" });
      const result: DocumentData[] = [{ _id: "e1", name: "Poisoned" }];
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/api/actors/a1/effects").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [{ _id: "e1", name: "Poisoned" }]);
  });

  void it("GET /api/actors/:parentId/effects/:effectId reads a single embedded effect", async () => {
    const app = buildApp(((type: string, payload: EffectIdInput) => {
      assert.equal(type, "effectGet");
      assert.deepEqual(payload, { parentType: "Actor", parentId: "a1", effectId: "e1" });
      const result: DocumentData = { _id: "e1", name: "Poisoned" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/api/actors/a1/effects/e1").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "e1", name: "Poisoned" });
  });

  void it("POST /api/actors/:parentId/effects creates an embedded effect from the body's `data`", async () => {
    const app = buildApp(((type: string, payload: EffectCreateInput) => {
      assert.equal(type, "effectCreate");
      assert.deepEqual(payload, {
        parentType: "Actor",
        parentId: "a1",
        data: { name: "Stunned" },
      });
      const result: DocumentData = { _id: "e2", name: "Stunned" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/actors/a1/effects")
      .set(API_KEY_HEADER, API_KEY)
      .send({ data: { name: "Stunned" } });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "e2", name: "Stunned" });
  });

  void it("PUT /api/actors/:parentId/effects/:effectId sends ids from the path and changes from the body", async () => {
    const app = buildApp(((type: string, payload: EffectUpdateInput) => {
      assert.equal(type, "effectUpdate");
      assert.deepEqual(payload, {
        parentType: "Actor",
        parentId: "a1",
        effectId: "e1",
        changes: { disabled: true },
      });
      const result: DocumentData = { _id: "e1", name: "Poisoned", disabled: true };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .put("/api/actors/a1/effects/e1")
      .set(API_KEY_HEADER, API_KEY)
      .send({ changes: { disabled: true } });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "e1", name: "Poisoned", disabled: true });
  });

  void it("DELETE /api/actors/:parentId/effects/:effectId deletes an embedded effect", async () => {
    const app = buildApp(((type: string, payload: EffectIdInput) => {
      assert.equal(type, "effectDelete");
      assert.deepEqual(payload, { parentType: "Actor", parentId: "a1", effectId: "e1" });
      const result: DocumentDeleteResult = { id: "e1" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).delete("/api/actors/a1/effects/e1").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { id: "e1" });
  });

  void it("GET /api/items/:parentId/effects lists an item's embedded effects with parentType: Item", async () => {
    const app = buildApp(((type: string, payload: EffectParentInput) => {
      assert.equal(type, "effectList");
      assert.deepEqual(payload, { parentType: "Item", parentId: "i1" });
      const result: DocumentData[] = [{ _id: "e3", name: "Cursed" }];
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/api/items/i1/effects").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [{ _id: "e3", name: "Cursed" }]);
  });

  void it("rejects a request with a missing/incorrect API key with 401", async () => {
    const app = buildApp((() => Promise.resolve({})) as FoundryClient["call"]);

    const res = await request(app).get("/api/actors/a1/effects");
    assert.equal(res.status, 401);
  });
});
