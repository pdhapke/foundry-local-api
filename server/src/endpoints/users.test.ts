// Integration test for Phase 25 — Users & Client State, built on the same
// template every phase since Phase 20 uses (see permissions.test.ts's header
// comment): a real Express app via createApp() with a fake FoundryClient
// swapped onto `app.locals["foundryClient"]`, driven with supertest. No real
// WebSocket/bridge/Foundry instance is involved.
//
// `GET /api/users` (list) already exists from Phase 6 and isn't re-tested
// here; this covers the get-by-id/create/update/delete/status/canvas-
// selection descriptors this phase adds.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import request from "supertest";

import type {
  ActiveGmResult,
  CanvasSelectionResult,
  CanvasTargetsResult,
  DocumentData,
  DocumentDeleteResult,
  SetCanvasTargetsInput,
  UserCreateInput,
  UserIdInput,
  UserStatusResult,
  UserUpdateInput,
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

void describe("Phase 25 users & client state", () => {
  void it("GET /api/users/:userId reads a single user's full document data", async () => {
    const app = buildApp(((type: string, payload: UserIdInput) => {
      assert.equal(type, "userGet");
      assert.deepEqual(payload, { userId: "u1" });
      const result: DocumentData = { _id: "u1", name: "Alice", role: 1 };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/api/users/u1").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "u1", name: "Alice", role: 1 });
  });

  void it("POST /api/users creates a user from the body's `data`", async () => {
    const app = buildApp(((type: string, payload: UserCreateInput) => {
      assert.equal(type, "userCreate");
      assert.deepEqual(payload, { data: { name: "Bob" } });
      const result: DocumentData = { _id: "u2", name: "Bob" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/users")
      .set(API_KEY_HEADER, API_KEY)
      .send({ data: { name: "Bob" } });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "u2", name: "Bob" });
  });

  void it("PUT /api/users/:userId sends the id from the path and changes from the body", async () => {
    const app = buildApp(((type: string, payload: UserUpdateInput) => {
      assert.equal(type, "userUpdate");
      assert.deepEqual(payload, { userId: "u1", changes: { name: "Alicia" } });
      const result: DocumentData = { _id: "u1", name: "Alicia" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .put("/api/users/u1")
      .set(API_KEY_HEADER, API_KEY)
      .send({ changes: { name: "Alicia" } });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "u1", name: "Alicia" });
  });

  void it("DELETE /api/users/:userId deletes a user by id", async () => {
    const app = buildApp(((type: string, payload: UserIdInput) => {
      assert.equal(type, "userDelete");
      assert.deepEqual(payload, { userId: "u1" });
      const result: DocumentDeleteResult = { id: "u1" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).delete("/api/users/u1").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { id: "u1" });
  });

  void it("propagates a module-side GM-only rejection (e.g. non-GM creating a user) as a 500", async () => {
    const app = buildApp((() =>
      Promise.reject(
        new FoundryBridgeError("HANDLER_ERROR", "Only a GM may create a user."),
      )) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/users")
      .set(API_KEY_HEADER, API_KEY)
      .send({ data: { name: "Bob" } });

    assert.equal(res.status, 500);
    assert.equal(res.body.error.code, "HANDLER_ERROR");
  });

  void it("GET /api/users/:userId/status reads a user's active/idle status", async () => {
    const app = buildApp(((type: string, payload: UserIdInput) => {
      assert.equal(type, "userGetStatus");
      assert.deepEqual(payload, { userId: "u1" });
      const result: UserStatusResult = { userId: "u1", active: true };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/api/users/u1/status").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { userId: "u1", active: true });
  });

  void it("GET /api/canvas/selection reads the currently controlled tokens and scene id", async () => {
    const app = buildApp(((type: string) => {
      assert.equal(type, "userGetCanvasSelection");
      const result: CanvasSelectionResult = { sceneId: "s1", tokenIds: ["t1", "t2"] };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/api/canvas/selection").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { sceneId: "s1", tokenIds: ["t1", "t2"] });
  });

  void it("GET /api/canvas/targets reads the currently targeted tokens and scene id", async () => {
    const app = buildApp(((type: string) => {
      assert.equal(type, "userGetTargets");
      const result: CanvasTargetsResult = { sceneId: "s1", tokenIds: ["t1"] };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/api/canvas/targets").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { sceneId: "s1", tokenIds: ["t1"] });
  });

  void it("POST /api/canvas/targets forwards tokenIds/additive and returns the resulting targets", async () => {
    const app = buildApp(((type: string, payload: SetCanvasTargetsInput) => {
      assert.equal(type, "userSetTargets");
      assert.deepEqual(payload, { tokenIds: ["t1", "t2"], additive: true });
      const result: CanvasTargetsResult = { sceneId: "s1", tokenIds: ["t1", "t2"] };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/canvas/targets")
      .set(API_KEY_HEADER, API_KEY)
      .send({ tokenIds: ["t1", "t2"], additive: true });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { sceneId: "s1", tokenIds: ["t1", "t2"] });
  });

  void it("GET /api/users/active-gm reads the active GM's user id", async () => {
    const app = buildApp(((type: string) => {
      assert.equal(type, "userGetActiveGm");
      const result: ActiveGmResult = { userId: "u1" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/api/users/active-gm").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { userId: "u1" });
  });

  void it("GET /api/users/active-gm returns userId: null when no GM is connected", async () => {
    const app = buildApp(((type: string) => {
      assert.equal(type, "userGetActiveGm");
      const result: ActiveGmResult = { userId: null };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/api/users/active-gm").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { userId: null });
  });

  void it("rejects a request with a missing/incorrect API key with 401", async () => {
    const app = buildApp((() => Promise.resolve({})) as FoundryClient["call"]);

    const res = await request(app).get("/api/users/u1");
    assert.equal(res.status, 401);
  });
});
