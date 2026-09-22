// Integration test for Phase 19 — Folders, built on the Phase 16/17/18
// template (see roll-tables.test.ts's header comment): a real Express app via
// createApp() with a fake FoundryClient swapped onto
// `app.locals["foundryClient"]`, driven with supertest. No real
// WebSocket/bridge/Foundry instance is involved.
//
// Base CRUD is already proven generic by documents.test.ts's
// `makeDocumentEndpoints()` tests, so this file only exercises the one
// Folder-specific extra (move-document) plus a smoke check that
// folderEndpointDescriptors actually mounts CRUD under `/api/folders`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import request from "supertest";

import type {
  DocumentData,
  DocumentTypeInput,
  FolderMoveDocumentInput,
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

void describe("Phase 19 folders", () => {
  void it("GET /api/folders lists documents via the generic Folder CRUD factory", async () => {
    const app = buildApp(((type: string, payload: DocumentTypeInput) => {
      assert.equal(type, "documentList");
      assert.deepEqual(payload, { documentType: "Folder" });
      const result: DocumentData[] = [{ _id: "f1", name: "NPCs", type: "Actor" }];
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/api/folders").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [{ _id: "f1", name: "NPCs", type: "Actor" }]);
  });

  void it("POST /api/folders/move-document moves a document into a folder", async () => {
    const app = buildApp(((type: string, payload: FolderMoveDocumentInput) => {
      assert.equal(type, "folderMoveDocument");
      assert.deepEqual(payload, { documentType: "Actor", id: "a1", folderId: "f1" });
      const result: DocumentData = { _id: "a1", name: "Grog", folder: "f1" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/folders/move-document")
      .set(API_KEY_HEADER, API_KEY)
      .send({ documentType: "Actor", id: "a1", folderId: "f1" });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "a1", name: "Grog", folder: "f1" });
  });

  void it("POST /api/folders/move-document moves a document to the root with folderId: null", async () => {
    const app = buildApp(((type: string, payload: FolderMoveDocumentInput) => {
      assert.equal(type, "folderMoveDocument");
      assert.deepEqual(payload, { documentType: "Actor", id: "a1", folderId: null });
      const result: DocumentData = { _id: "a1", name: "Grog", folder: null };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/folders/move-document")
      .set(API_KEY_HEADER, API_KEY)
      .send({ documentType: "Actor", id: "a1", folderId: null });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "a1", name: "Grog", folder: null });
  });

  void it("rejects a request with a missing/incorrect API key with 401", async () => {
    const app = buildApp((() => Promise.resolve({})) as FoundryClient["call"]);

    const res = await request(app).post("/api/folders/move-document");
    assert.equal(res.status, 401);
  });
});
