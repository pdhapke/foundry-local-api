// Integration test for Phase 10 — Items, built on the Phase 9 template (see
// actors.test.ts's header comment): a real Express app via createApp() with
// a fake FoundryClient swapped onto `app.locals["foundryClient"]`, driven
// with supertest. No real WebSocket/bridge/Foundry instance is involved.
//
// World Item CRUD is already proven generic by documents.test.ts's
// `makeDocumentEndpoints()` tests, so this file only exercises the four
// embedded-item extras (get/create/update/delete a single Item on an actor)
// plus a smoke check that itemEndpointDescriptors actually mounts CRUD under
// `/api/items`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import request from "supertest";

import type {
  DocumentData,
  DocumentDeleteResult,
  DocumentTypeInput,
  EmbeddedItemCreateInput,
  EmbeddedItemIdInput,
  EmbeddedItemUpdateInput,
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

void describe("Phase 10 items", () => {
  void it("GET /api/items lists documents via the generic Item CRUD factory", async () => {
    const app = buildApp(((type: string, payload: DocumentTypeInput) => {
      assert.equal(type, "documentList");
      assert.deepEqual(payload, { documentType: "Item" });
      const result: DocumentData[] = [{ _id: "i1", name: "Sword" }];
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/api/items").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [{ _id: "i1", name: "Sword" }]);
  });

  void it("GET /api/actors/:actorId/items/:itemId reads a single embedded item", async () => {
    const app = buildApp(((type: string, payload: EmbeddedItemIdInput) => {
      assert.equal(type, "actorGetItem");
      assert.deepEqual(payload, { actorId: "a1", itemId: "i1" });
      const result: DocumentData = { _id: "i1", name: "Sword" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/api/actors/a1/items/i1").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "i1", name: "Sword" });
  });

  void it("POST /api/actors/:actorId/items creates an embedded item from the body's `data`", async () => {
    const app = buildApp(((type: string, payload: EmbeddedItemCreateInput) => {
      assert.equal(type, "actorCreateItem");
      assert.deepEqual(payload, { actorId: "a1", data: { name: "Dagger" } });
      const result: DocumentData = { _id: "i2", name: "Dagger" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/actors/a1/items")
      .set(API_KEY_HEADER, API_KEY)
      .send({ data: { name: "Dagger" } });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "i2", name: "Dagger" });
  });

  void it("PUT /api/actors/:actorId/items/:itemId sends ids from the path and changes from the body", async () => {
    const app = buildApp(((type: string, payload: EmbeddedItemUpdateInput) => {
      assert.equal(type, "actorUpdateItem");
      assert.deepEqual(payload, { actorId: "a1", itemId: "i1", changes: { name: "Longsword" } });
      const result: DocumentData = { _id: "i1", name: "Longsword" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .put("/api/actors/a1/items/i1")
      .set(API_KEY_HEADER, API_KEY)
      .send({ changes: { name: "Longsword" } });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "i1", name: "Longsword" });
  });

  void it("DELETE /api/actors/:actorId/items/:itemId deletes an embedded item", async () => {
    const app = buildApp(((type: string, payload: EmbeddedItemIdInput) => {
      assert.equal(type, "actorDeleteItem");
      assert.deepEqual(payload, { actorId: "a1", itemId: "i1" });
      const result: DocumentDeleteResult = { id: "i1" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).delete("/api/actors/a1/items/i1").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { id: "i1" });
  });

  void it("rejects a request with a missing/incorrect API key with 401", async () => {
    const app = buildApp((() => Promise.resolve({})) as FoundryClient["call"]);

    const res = await request(app).get("/api/actors/a1/items/i1");
    assert.equal(res.status, 401);
  });
});
