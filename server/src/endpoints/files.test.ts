// Integration test for Phase 24 — File/Asset Management, built on the same
// template every phase since Phase 20 uses (see packs.test.ts's header
// comment): a real Express app via createApp() with a fake FoundryClient
// swapped onto `app.locals["foundryClient"]`, driven with supertest. No real
// WebSocket/bridge/Foundry instance is involved.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import request from "supertest";

import type {
  CreateDirectoryInput,
  CreateDirectoryResult,
  FileBrowseInput,
  FileBrowseResult,
  FileUploadInput,
  FileUploadResult,
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

void describe("Phase 24 file/asset management", () => {
  void it("GET /api/files/browse forwards source/target query params", async () => {
    const app = buildApp(((type: string, payload: FileBrowseInput) => {
      assert.equal(type, "fileBrowse");
      assert.deepEqual(payload, { source: "data", target: "worlds/my-world" });
      const result: FileBrowseResult = {
        target: "worlds/my-world",
        source: "data",
        dirs: ["worlds/my-world/assets"],
        files: ["worlds/my-world/map.webp"],
      };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .get("/api/files/browse")
      .query({ source: "data", target: "worlds/my-world" })
      .set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      target: "worlds/my-world",
      source: "data",
      dirs: ["worlds/my-world/assets"],
      files: ["worlds/my-world/map.webp"],
    });
  });

  void it("GET /api/files/browse works with no query params", async () => {
    const app = buildApp(((type: string, payload: FileBrowseInput) => {
      assert.equal(type, "fileBrowse");
      assert.deepEqual(payload, {});
      const result: FileBrowseResult = { target: "", source: "data", dirs: [], files: [] };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/api/files/browse").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
  });

  void it("POST /api/files/upload forwards the base64 payload", async () => {
    const app = buildApp(((type: string, payload: FileUploadInput) => {
      assert.equal(type, "fileUpload");
      assert.deepEqual(payload, {
        path: "worlds/my-world/assets",
        fileName: "token.png",
        contentBase64: "aGVsbG8=",
        mimeType: "image/png",
      });
      const result: FileUploadResult = { path: "worlds/my-world/assets/token.png" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/files/upload")
      .set(API_KEY_HEADER, API_KEY)
      .send({
        path: "worlds/my-world/assets",
        fileName: "token.png",
        contentBase64: "aGVsbG8=",
        mimeType: "image/png",
      });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { path: "worlds/my-world/assets/token.png" });
  });

  void it("POST /api/files/directories creates a directory", async () => {
    const app = buildApp(((type: string, payload: CreateDirectoryInput) => {
      assert.equal(type, "fileCreateDirectory");
      assert.deepEqual(payload, { target: "worlds/my-world/assets" });
      const result: CreateDirectoryResult = { target: "worlds/my-world/assets" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/files/directories")
      .set(API_KEY_HEADER, API_KEY)
      .send({ target: "worlds/my-world/assets" });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { target: "worlds/my-world/assets" });
  });

  void it("rejects a request with a missing/incorrect API key with 401", async () => {
    const app = buildApp((() => Promise.resolve({})) as FoundryClient["call"]);

    const res = await request(app).get("/api/files/browse");
    assert.equal(res.status, 401);
  });
});
