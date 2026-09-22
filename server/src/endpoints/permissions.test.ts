// Integration test for Phase 23 — Permissions & Ownership, built on the same
// template every phase since Phase 20 uses (see packs.test.ts's header
// comment): a real Express app via createApp() with a fake FoundryClient
// swapped onto `app.locals["foundryClient"]`, driven with supertest. No real
// WebSocket/bridge/Foundry instance is involved.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import request from "supertest";

import type {
  DocumentOwnershipInput,
  DocumentOwnershipResult,
  DocumentSetOwnershipInput,
  UserRoleInput,
  UserRoleResult,
  UserSetRoleInput,
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

void describe("Phase 23 permissions & ownership", () => {
  void it("GET /api/documents/:documentType/:documentId/ownership reads a document's ownership map", async () => {
    const app = buildApp(((type: string, payload: DocumentOwnershipInput) => {
      assert.equal(type, "documentGetOwnership");
      assert.deepEqual(payload, { documentType: "Actor", documentId: "a1" });
      const result: DocumentOwnershipResult = {
        documentType: "Actor",
        documentId: "a1",
        ownership: { default: 0, u1: 3 },
      };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .get("/api/documents/Actor/a1/ownership")
      .set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      documentType: "Actor",
      documentId: "a1",
      ownership: { default: 0, u1: 3 },
    });
  });

  void it("PUT /api/documents/:documentType/:documentId/ownership sends ids from the path and the ownership map from the body", async () => {
    const app = buildApp(((type: string, payload: DocumentSetOwnershipInput) => {
      assert.equal(type, "documentSetOwnership");
      assert.deepEqual(payload, {
        documentType: "Actor",
        documentId: "a1",
        ownership: { default: 0, u1: 3 },
      });
      const result: DocumentOwnershipResult = {
        documentType: "Actor",
        documentId: "a1",
        ownership: { default: 0, u1: 3 },
      };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .put("/api/documents/Actor/a1/ownership")
      .set(API_KEY_HEADER, API_KEY)
      .send({ ownership: { default: 0, u1: 3 } });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      documentType: "Actor",
      documentId: "a1",
      ownership: { default: 0, u1: 3 },
    });
  });

  void it("GET /api/users/:userId/role reads a user's world permission level", async () => {
    const app = buildApp(((type: string, payload: UserRoleInput) => {
      assert.equal(type, "userGetRole");
      assert.deepEqual(payload, { userId: "u1" });
      const result: UserRoleResult = { userId: "u1", role: 1 };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/api/users/u1/role").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { userId: "u1", role: 1 });
  });

  void it("PUT /api/users/:userId/role sends the id from the path and role from the body", async () => {
    const app = buildApp(((type: string, payload: UserSetRoleInput) => {
      assert.equal(type, "userSetRole");
      assert.deepEqual(payload, { userId: "u1", role: 3 });
      const result: UserRoleResult = { userId: "u1", role: 3 };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .put("/api/users/u1/role")
      .set(API_KEY_HEADER, API_KEY)
      .send({ role: 3 });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { userId: "u1", role: 3 });
  });

  void it("rejects a request with a missing/incorrect API key with 401", async () => {
    const app = buildApp((() => Promise.resolve({})) as FoundryClient["call"]);

    const res = await request(app).get("/api/users/u1/role");
    assert.equal(res.status, 401);
  });
});
