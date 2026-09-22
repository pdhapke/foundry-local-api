// Integration test for Phase 28 — Bulk/Batch & Query Endpoints, built on the
// Phase 8 template (see documents.test.ts's header comment): a real Express
// app via createApp() with a fake FoundryClient swapped onto
// `app.locals["foundryClient"]`, driven with supertest. No real
// WebSocket/bridge/Foundry instance is involved.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import request from "supertest";

import type {
  DocumentBatchCreateInput,
  DocumentBatchDeleteInput,
  DocumentBatchDeleteResult,
  DocumentBatchUpdateInput,
  DocumentData,
  DocumentQueryInput,
} from "@foundry-local-api/shared";

import { createApp } from "../app.js";
import { FoundryBridgeError } from "../bridge/errors.js";
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

void describe("Phase 28 bulk/batch & query endpoints", () => {
  void it("POST /api/documents/query forwards documentType/filter/limit", async () => {
    const app = buildApp(((type: string, payload: DocumentQueryInput) => {
      assert.equal(type, "documentQuery");
      assert.deepEqual(payload, {
        documentType: "Actor",
        filter: { type: "npc" },
        limit: 5,
      });
      const result: DocumentData[] = [{ _id: "a1", name: "Goblin", type: "npc" }];
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/documents/query")
      .set(API_KEY_HEADER, API_KEY)
      .send({ documentType: "Actor", filter: { type: "npc" }, limit: 5 });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [{ _id: "a1", name: "Goblin", type: "npc" }]);
  });

  void it("POST /api/documents/query with only documentType omits filter/limit from the payload", async () => {
    const app = buildApp(((type: string, payload: DocumentQueryInput) => {
      assert.equal(type, "documentQuery");
      assert.deepEqual(payload, { documentType: "Actor" });
      assert.equal("filter" in payload, false);
      assert.equal("limit" in payload, false);
      const result: DocumentData[] = [];
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/documents/query")
      .set(API_KEY_HEADER, API_KEY)
      .send({ documentType: "Actor" });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });

  void it("POST /api/documents/batch-create forwards documentType/items", async () => {
    const app = buildApp(((type: string, payload: DocumentBatchCreateInput) => {
      assert.equal(type, "documentBatchCreate");
      assert.deepEqual(payload, {
        documentType: "Item",
        items: [{ name: "Sword" }, { name: "Shield" }],
      });
      const result: DocumentData[] = [
        { _id: "i1", name: "Sword" },
        { _id: "i2", name: "Shield" },
      ];
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/documents/batch-create")
      .set(API_KEY_HEADER, API_KEY)
      .send({ documentType: "Item", items: [{ name: "Sword" }, { name: "Shield" }] });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [
      { _id: "i1", name: "Sword" },
      { _id: "i2", name: "Shield" },
    ]);
  });

  void it("POST /api/documents/batch-update forwards documentType/updates", async () => {
    const app = buildApp(((type: string, payload: DocumentBatchUpdateInput) => {
      assert.equal(type, "documentBatchUpdate");
      assert.deepEqual(payload, {
        documentType: "Item",
        updates: [{ id: "i1", changes: { name: "Longsword" } }],
      });
      const result: DocumentData[] = [{ _id: "i1", name: "Longsword" }];
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/documents/batch-update")
      .set(API_KEY_HEADER, API_KEY)
      .send({ documentType: "Item", updates: [{ id: "i1", changes: { name: "Longsword" } }] });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [{ _id: "i1", name: "Longsword" }]);
  });

  void it("POST /api/documents/batch-delete forwards documentType/ids and returns deleted ids", async () => {
    const app = buildApp(((type: string, payload: DocumentBatchDeleteInput) => {
      assert.equal(type, "documentBatchDelete");
      assert.deepEqual(payload, { documentType: "Item", ids: ["i1", "i2"] });
      const result: DocumentBatchDeleteResult = { ids: ["i1", "i2"] };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/documents/batch-delete")
      .set(API_KEY_HEADER, API_KEY)
      .send({ documentType: "Item", ids: ["i1", "i2"] });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ids: ["i1", "i2"] });
  });

  void it("propagates a module-side rejection (e.g. unknown document type) as a 500", async () => {
    const app = buildApp((() =>
      Promise.reject(
        new FoundryBridgeError("HANDLER_ERROR", 'Unknown document type "Bogus"'),
      )) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/documents/query")
      .set(API_KEY_HEADER, API_KEY)
      .send({ documentType: "Bogus" });

    assert.equal(res.status, 500);
    assert.equal(res.body.error.code, "HANDLER_ERROR");
  });

  void it("rejects a request with a missing/incorrect API key with 401", async () => {
    const app = buildApp((() => Promise.resolve([])) as FoundryClient["call"]);

    const res = await request(app).post("/api/documents/query").send({ documentType: "Actor" });
    assert.equal(res.status, 401);
  });
});
