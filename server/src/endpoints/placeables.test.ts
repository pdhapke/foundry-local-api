// Integration test for Phase 22 — Canvas & Scene Placeables, built on the
// Phase 21 template (see active-effects.test.ts's header comment): a real
// Express app via createApp() with a fake FoundryClient swapped onto
// `app.locals["foundryClient"]`, driven with supertest. No real
// WebSocket/bridge/Foundry instance is involved.
//
// `makeEmbeddedPlaceableEndpoints()` is called once per placeable document
// type (Drawing/Note/AmbientLight/AmbientSound/Wall/MeasuredTemplate); this
// exercises the Drawing-routed CRUD fully plus one Wall-routed list request
// to prove a second call wires up its own `documentType`/`routeBase`
// correctly rather than colliding with the first. The camera pan endpoint is
// covered separately.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import request from "supertest";

import type {
  CanvasPanInput,
  CanvasPanResult,
  DocumentData,
  DocumentDeleteResult,
  PlaceableCreateInput,
  PlaceableIdInput,
  PlaceableParentInput,
  PlaceableUpdateInput,
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

void describe("Phase 22 canvas & scene placeables", () => {
  void it("GET /api/scenes/:sceneId/drawings lists a scene's embedded drawings", async () => {
    const app = buildApp(((type: string, payload: PlaceableParentInput) => {
      assert.equal(type, "placeableList");
      assert.deepEqual(payload, { documentType: "Drawing", sceneId: "s1" });
      const result: DocumentData[] = [{ _id: "d1", shape: { type: "r" } }];
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/api/scenes/s1/drawings").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [{ _id: "d1", shape: { type: "r" } }]);
  });

  void it("GET /api/scenes/:sceneId/drawings/:placeableId reads a single embedded drawing", async () => {
    const app = buildApp(((type: string, payload: PlaceableIdInput) => {
      assert.equal(type, "placeableGet");
      assert.deepEqual(payload, { documentType: "Drawing", sceneId: "s1", placeableId: "d1" });
      const result: DocumentData = { _id: "d1" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/api/scenes/s1/drawings/d1").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "d1" });
  });

  void it("POST /api/scenes/:sceneId/drawings creates an embedded drawing from the body's `data`", async () => {
    const app = buildApp(((type: string, payload: PlaceableCreateInput) => {
      assert.equal(type, "placeableCreate");
      assert.deepEqual(payload, {
        documentType: "Drawing",
        sceneId: "s1",
        data: { shape: { type: "r" } },
      });
      const result: DocumentData = { _id: "d2", shape: { type: "r" } };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/scenes/s1/drawings")
      .set(API_KEY_HEADER, API_KEY)
      .send({ data: { shape: { type: "r" } } });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "d2", shape: { type: "r" } });
  });

  void it("PUT /api/scenes/:sceneId/drawings/:placeableId sends ids from the path and changes from the body", async () => {
    const app = buildApp(((type: string, payload: PlaceableUpdateInput) => {
      assert.equal(type, "placeableUpdate");
      assert.deepEqual(payload, {
        documentType: "Drawing",
        sceneId: "s1",
        placeableId: "d1",
        changes: { hidden: true },
      });
      const result: DocumentData = { _id: "d1", hidden: true };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .put("/api/scenes/s1/drawings/d1")
      .set(API_KEY_HEADER, API_KEY)
      .send({ changes: { hidden: true } });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "d1", hidden: true });
  });

  void it("DELETE /api/scenes/:sceneId/drawings/:placeableId deletes an embedded drawing", async () => {
    const app = buildApp(((type: string, payload: PlaceableIdInput) => {
      assert.equal(type, "placeableDelete");
      assert.deepEqual(payload, { documentType: "Drawing", sceneId: "s1", placeableId: "d1" });
      const result: DocumentDeleteResult = { id: "d1" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .delete("/api/scenes/s1/drawings/d1")
      .set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { id: "d1" });
  });

  void it("GET /api/scenes/:sceneId/walls lists a scene's embedded walls with documentType: Wall", async () => {
    const app = buildApp(((type: string, payload: PlaceableParentInput) => {
      assert.equal(type, "placeableList");
      assert.deepEqual(payload, { documentType: "Wall", sceneId: "s1" });
      const result: DocumentData[] = [{ _id: "w1" }];
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/api/scenes/s1/walls").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [{ _id: "w1" }]);
  });

  void it("POST /api/canvas/pan forwards x/y/scale to the bridge", async () => {
    const app = buildApp(((type: string, payload: CanvasPanInput) => {
      assert.equal(type, "canvasPan");
      assert.deepEqual(payload, { x: 100, y: 200, scale: 1.5 });
      const result: CanvasPanResult = { x: 100, y: 200, scale: 1.5 };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/canvas/pan")
      .set(API_KEY_HEADER, API_KEY)
      .send({ x: 100, y: 200, scale: 1.5 });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { x: 100, y: 200, scale: 1.5 });
  });

  void it("rejects a request with a missing/incorrect API key with 401", async () => {
    const app = buildApp((() => Promise.resolve({})) as FoundryClient["call"]);

    const res = await request(app).get("/api/scenes/s1/drawings");
    assert.equal(res.status, 401);
  });
});
