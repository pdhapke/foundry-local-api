// Integration test for Phase 18 — RollTables & Cards (RollTable half),
// built on the Phase 16/17 template (see combats.test.ts's header comment):
// a real Express app via createApp() with a fake FoundryClient swapped onto
// `app.locals["foundryClient"]`, driven with supertest. No real
// WebSocket/bridge/Foundry instance is involved.
//
// Base CRUD is already proven generic by documents.test.ts's
// `makeDocumentEndpoints()` tests, so this file only exercises the one
// RollTable-specific extra (draw) plus a smoke check that
// rollTableEndpointDescriptors actually mounts CRUD under `/api/roll-tables`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import request from "supertest";

import type {
  DocumentData,
  DocumentTypeInput,
  RollTableDrawInput,
  RollTableDrawResult,
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

void describe("Phase 18 roll tables", () => {
  void it("GET /api/roll-tables lists documents via the generic RollTable CRUD factory", async () => {
    const app = buildApp(((type: string, payload: DocumentTypeInput) => {
      assert.equal(type, "documentList");
      assert.deepEqual(payload, { documentType: "RollTable" });
      const result: DocumentData[] = [{ _id: "rt1", name: "Wild Magic" }];
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/api/roll-tables").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [{ _id: "rt1", name: "Wild Magic" }]);
  });

  void it("POST /api/roll-tables/:id/draw draws a result, passing displayChat through", async () => {
    const app = buildApp(((type: string, payload: RollTableDrawInput) => {
      assert.equal(type, "rollTableDraw");
      assert.deepEqual(payload, { id: "rt1", displayChat: false });
      const result: RollTableDrawResult = {
        roll: { formula: "1d20", total: 14 },
        results: [{ _id: "tr1", text: "You grow a beard" }],
      };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/roll-tables/rt1/draw")
      .set(API_KEY_HEADER, API_KEY)
      .send({ displayChat: false });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      roll: { formula: "1d20", total: 14 },
      results: [{ _id: "tr1", text: "You grow a beard" }],
    });
  });

  void it("POST /api/roll-tables/:id/draw draws with no body", async () => {
    const app = buildApp(((type: string, payload: RollTableDrawInput) => {
      assert.equal(type, "rollTableDraw");
      assert.deepEqual(payload, { id: "rt1" });
      const result: RollTableDrawResult = {
        roll: { formula: "1d20", total: 3 },
        results: [],
      };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/roll-tables/rt1/draw")
      .set(API_KEY_HEADER, API_KEY)
      .send({});

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { roll: { formula: "1d20", total: 3 }, results: [] });
  });

  void it("rejects a request with a missing/incorrect API key with 401", async () => {
    const app = buildApp((() => Promise.resolve({})) as FoundryClient["call"]);

    const res = await request(app).post("/api/roll-tables/rt1/draw");
    assert.equal(res.status, 401);
  });
});
