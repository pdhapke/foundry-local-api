// Integration test for Phase 17 — Playlists & Audio, built on the Phase 16
// template (see combats.test.ts's header comment): a real Express app via
// createApp() with a fake FoundryClient swapped onto
// `app.locals["foundryClient"]`, driven with supertest. No real
// WebSocket/bridge/Foundry instance is involved.
//
// Base CRUD is already proven generic by documents.test.ts's
// `makeDocumentEndpoints()` tests, so this file only exercises the
// playlist-specific extras (play/stop/pause sound) plus a smoke check that
// playlistEndpointDescriptors actually mounts CRUD under `/api/playlists`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import request from "supertest";

import type {
  DocumentData,
  DocumentTypeInput,
  PlaylistIdInput,
  PlaylistSoundIdInput,
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

void describe("Phase 17 playlists", () => {
  void it("GET /api/playlists lists documents via the generic Playlist CRUD factory", async () => {
    const app = buildApp(((type: string, payload: DocumentTypeInput) => {
      assert.equal(type, "documentList");
      assert.deepEqual(payload, { documentType: "Playlist" });
      const result: DocumentData[] = [{ _id: "p1", name: "Tavern" }];
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/api/playlists").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [{ _id: "p1", name: "Tavern" }]);
  });

  void it("POST /api/playlists/:id/sounds/:soundId/play starts the sound", async () => {
    const app = buildApp(((type: string, payload: PlaylistSoundIdInput) => {
      assert.equal(type, "playlistPlaySound");
      assert.deepEqual(payload, { id: "p1", soundId: "s1" });
      const result: DocumentData = { _id: "s1", playing: true };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/playlists/p1/sounds/s1/play")
      .set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "s1", playing: true });
  });

  void it("POST /api/playlists/:id/sounds/:soundId/stop stops the sound", async () => {
    const app = buildApp(((type: string, payload: PlaylistSoundIdInput) => {
      assert.equal(type, "playlistStopSound");
      assert.deepEqual(payload, { id: "p1", soundId: "s1" });
      const result: DocumentData = { _id: "s1", playing: false, pausedTime: null };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/playlists/p1/sounds/s1/stop")
      .set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "s1", playing: false, pausedTime: null });
  });

  void it("POST /api/playlists/:id/sounds/:soundId/pause pauses the sound", async () => {
    const app = buildApp(((type: string, payload: PlaylistSoundIdInput) => {
      assert.equal(type, "playlistPauseSound");
      assert.deepEqual(payload, { id: "p1", soundId: "s1" });
      const result: DocumentData = { _id: "s1", playing: false, pausedTime: 12.5 };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/playlists/p1/sounds/s1/pause")
      .set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "s1", playing: false, pausedTime: 12.5 });
  });

  void it("POST /api/playlists/:id/play-all starts simultaneous playback of every sound", async () => {
    const app = buildApp(((type: string, payload: PlaylistIdInput) => {
      assert.equal(type, "playlistPlayAll");
      assert.deepEqual(payload, { id: "p1" });
      const result: DocumentData = { _id: "p1", playing: true };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).post("/api/playlists/p1/play-all").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "p1", playing: true });
  });

  void it("POST /api/playlists/:id/stop-all stops every currently-playing sound", async () => {
    const app = buildApp(((type: string, payload: PlaylistIdInput) => {
      assert.equal(type, "playlistStopAll");
      assert.deepEqual(payload, { id: "p1" });
      const result: DocumentData = { _id: "p1", playing: false };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).post("/api/playlists/p1/stop-all").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "p1", playing: false });
  });

  void it("rejects a request with a missing/incorrect API key with 401", async () => {
    const app = buildApp((() => Promise.resolve({})) as FoundryClient["call"]);

    const res = await request(app).post("/api/playlists/p1/sounds/s1/play");
    assert.equal(res.status, 401);
  });
});
