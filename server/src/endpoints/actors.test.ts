// Integration test for Phase 9 — Actors, built on the Phase 8 template (see
// documents.test.ts's header comment): a real Express app via createApp()
// with a fake FoundryClient swapped onto `app.locals["foundryClient"]`,
// driven with supertest. No real WebSocket/bridge/Foundry instance is
// involved.
//
// Base CRUD is already proven generic by documents.test.ts's
// `makeDocumentEndpoints()` tests, so this file only exercises the two
// actor-specific extras (roll data, embedded items) plus a smoke check that
// actorEndpointDescriptors actually mounts CRUD under `/api/actors`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import request from "supertest";

import type {
  ActorIdInput,
  ActorRollData,
  DocumentData,
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

void describe("Phase 9 actors", () => {
  void it("GET /api/actors lists documents via the generic Actor CRUD factory", async () => {
    const app = buildApp(((type: string, payload: DocumentTypeInput) => {
      assert.equal(type, "documentList");
      assert.deepEqual(payload, { documentType: "Actor" });
      const result: DocumentData[] = [{ _id: "a1", name: "Hero" }];
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/api/actors").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [{ _id: "a1", name: "Hero" }]);
  });

  void it("GET /api/actors/:id/roll-data reads the actor's roll data", async () => {
    const app = buildApp(((type: string, payload: ActorIdInput) => {
      assert.equal(type, "actorGetRollData");
      assert.deepEqual(payload, { id: "a1" });
      const result: ActorRollData = { abilities: { str: { value: 10 } } };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/api/actors/a1/roll-data").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { abilities: { str: { value: 10 } } });
  });

  void it("GET /api/actors/:id/items lists the actor's embedded items", async () => {
    const app = buildApp(((type: string, payload: ActorIdInput) => {
      assert.equal(type, "actorListItems");
      assert.deepEqual(payload, { id: "a1" });
      const result: DocumentData[] = [{ _id: "i1", name: "Sword" }];
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/api/actors/a1/items").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [{ _id: "i1", name: "Sword" }]);
  });

  void it("rejects a request with a missing/incorrect API key with 401", async () => {
    const app = buildApp((() => Promise.resolve({})) as FoundryClient["call"]);

    const res = await request(app).get("/api/actors/a1/roll-data");
    assert.equal(res.status, 401);
  });
});
