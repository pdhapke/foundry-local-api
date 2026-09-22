// Integration test for Phase 12 — Tokens (scene-embedded), built on the
// Phase 10/11 template (see items.test.ts's header comment): a real Express
// app via createApp() with a fake FoundryClient swapped onto
// `app.locals["foundryClient"]`, driven with supertest. No real
// WebSocket/bridge/Foundry instance is involved.
//
// Unlike Actor/Item/Scene, there's no generic Phase 8 factory backing any of
// this (a Token only exists embedded on a Scene), so every descriptor here
// is exercised directly: list/get/create/update/delete plus move and
// visibility toggle.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import request from "supertest";

import type {
  DocumentData,
  DocumentDeleteResult,
  SceneTokenCreateInput,
  SceneTokenIdInput,
  SceneTokenListInput,
  SceneTokenMoveInput,
  SceneTokenUpdateInput,
  SceneTokenVisibilityInput,
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

void describe("Phase 12 tokens", () => {
  void it("GET /api/scenes/:sceneId/tokens lists a scene's embedded tokens", async () => {
    const app = buildApp(((type: string, payload: SceneTokenListInput) => {
      assert.equal(type, "sceneListTokens");
      assert.deepEqual(payload, { sceneId: "s1" });
      const result: DocumentData[] = [{ _id: "t1", name: "Goblin" }];
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/api/scenes/s1/tokens").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [{ _id: "t1", name: "Goblin" }]);
  });

  void it("GET /api/scenes/:sceneId/tokens/:tokenId reads a single embedded token", async () => {
    const app = buildApp(((type: string, payload: SceneTokenIdInput) => {
      assert.equal(type, "sceneGetToken");
      assert.deepEqual(payload, { sceneId: "s1", tokenId: "t1" });
      const result: DocumentData = { _id: "t1", name: "Goblin" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/api/scenes/s1/tokens/t1").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "t1", name: "Goblin" });
  });

  void it("POST /api/scenes/:sceneId/tokens creates an embedded token from the body's `data`", async () => {
    const app = buildApp(((type: string, payload: SceneTokenCreateInput) => {
      assert.equal(type, "sceneCreateToken");
      assert.deepEqual(payload, { sceneId: "s1", data: { name: "Orc" } });
      const result: DocumentData = { _id: "t2", name: "Orc" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/scenes/s1/tokens")
      .set(API_KEY_HEADER, API_KEY)
      .send({ data: { name: "Orc" } });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "t2", name: "Orc" });
  });

  void it("PUT /api/scenes/:sceneId/tokens/:tokenId sends ids from the path and changes from the body", async () => {
    const app = buildApp(((type: string, payload: SceneTokenUpdateInput) => {
      assert.equal(type, "sceneUpdateToken");
      assert.deepEqual(payload, { sceneId: "s1", tokenId: "t1", changes: { name: "Goblin Boss" } });
      const result: DocumentData = { _id: "t1", name: "Goblin Boss" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .put("/api/scenes/s1/tokens/t1")
      .set(API_KEY_HEADER, API_KEY)
      .send({ changes: { name: "Goblin Boss" } });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "t1", name: "Goblin Boss" });
  });

  void it("DELETE /api/scenes/:sceneId/tokens/:tokenId deletes an embedded token", async () => {
    const app = buildApp(((type: string, payload: SceneTokenIdInput) => {
      assert.equal(type, "sceneDeleteToken");
      assert.deepEqual(payload, { sceneId: "s1", tokenId: "t1" });
      const result: DocumentDeleteResult = { id: "t1" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).delete("/api/scenes/s1/tokens/t1").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { id: "t1" });
  });

  void it("POST /api/scenes/:sceneId/tokens/:tokenId/move moves the token", async () => {
    const app = buildApp(((type: string, payload: SceneTokenMoveInput) => {
      assert.equal(type, "sceneMoveToken");
      assert.deepEqual(payload, { sceneId: "s1", tokenId: "t1", x: 400, y: 250 });
      const result: DocumentData = { _id: "t1", x: 400, y: 250 };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/scenes/s1/tokens/t1/move")
      .set(API_KEY_HEADER, API_KEY)
      .send({ x: 400, y: 250 });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "t1", x: 400, y: 250 });
  });

  void it("PUT /api/scenes/:sceneId/tokens/:tokenId/visibility toggles the token's hidden flag", async () => {
    const app = buildApp(((type: string, payload: SceneTokenVisibilityInput) => {
      assert.equal(type, "sceneSetTokenVisibility");
      assert.deepEqual(payload, { sceneId: "s1", tokenId: "t1", hidden: true });
      const result: DocumentData = { _id: "t1", hidden: true };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .put("/api/scenes/s1/tokens/t1/visibility")
      .set(API_KEY_HEADER, API_KEY)
      .send({ hidden: true });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "t1", hidden: true });
  });

  void it("rejects a request with a missing/incorrect API key with 401", async () => {
    const app = buildApp((() => Promise.resolve({})) as FoundryClient["call"]);

    const res = await request(app).get("/api/scenes/s1/tokens");
    assert.equal(res.status, 401);
  });
});
