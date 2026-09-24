// Integration test for Phase 11 — Scenes, built on the Phase 8 template (see
// documents.test.ts's header comment): a real Express app via createApp()
// with a fake FoundryClient swapped onto `app.locals["foundryClient"]`,
// driven with supertest. No real WebSocket/bridge/Foundry instance is
// involved.
//
// Base CRUD is already proven generic by documents.test.ts's
// `makeDocumentEndpoints()` tests, so this file only exercises the two
// scene-specific extras (activate, dimensions) plus a smoke check that
// sceneEndpointDescriptors actually mounts CRUD under `/api/scenes`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import request from "supertest";

import type {
  DocumentData,
  DocumentTypeInput,
  SceneDimensions,
  SceneIdInput,
  SceneResetFogResult,
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

void describe("Phase 11 scenes", () => {
  void it("GET /api/scenes lists documents via the generic Scene CRUD factory", async () => {
    const app = buildApp(((type: string, payload: DocumentTypeInput) => {
      assert.equal(type, "documentList");
      assert.deepEqual(payload, { documentType: "Scene" });
      const result: DocumentData[] = [{ _id: "s1", name: "Dungeon" }];
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/api/scenes").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [{ _id: "s1", name: "Dungeon" }]);
  });

  void it("POST /api/scenes/:id/activate activates the scene", async () => {
    const app = buildApp(((type: string, payload: SceneIdInput) => {
      assert.equal(type, "sceneActivate");
      assert.deepEqual(payload, { id: "s1" });
      const result: DocumentData = { _id: "s1", name: "Dungeon", active: true };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).post("/api/scenes/s1/activate").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "s1", name: "Dungeon", active: true });
  });

  void it("GET /api/scenes/:id/dimensions reads the scene's grid/dimension info", async () => {
    const app = buildApp(((type: string, payload: SceneIdInput) => {
      assert.equal(type, "sceneGetDimensions");
      assert.deepEqual(payload, { id: "s1" });
      const result: SceneDimensions = {
        width: 4000,
        height: 3000,
        padding: 0.25,
        size: 100,
        gridType: 1,
        distance: 5,
        units: "ft",
        sceneWidth: 4400,
        sceneHeight: 3400,
        sceneX: -200,
        sceneY: -200,
      };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/api/scenes/s1/dimensions").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      width: 4000,
      height: 3000,
      padding: 0.25,
      size: 100,
      gridType: 1,
      distance: 5,
      units: "ft",
      sceneWidth: 4400,
      sceneHeight: 3400,
      sceneX: -200,
      sceneY: -200,
    });
  });

  void it("POST /api/scenes/:id/reset-fog resets the scene's fog of war", async () => {
    const app = buildApp(((type: string, payload: SceneIdInput) => {
      assert.equal(type, "sceneResetFog");
      assert.deepEqual(payload, { id: "s1" });
      const result: SceneResetFogResult = { id: "s1" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).post("/api/scenes/s1/reset-fog").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { id: "s1" });
  });

  void it("rejects a request with a missing/incorrect API key with 401", async () => {
    const app = buildApp((() => Promise.resolve({})) as FoundryClient["call"]);

    const res = await request(app).post("/api/scenes/s1/activate");
    assert.equal(res.status, 401);
  });
});
