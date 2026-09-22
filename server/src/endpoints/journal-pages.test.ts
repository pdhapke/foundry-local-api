// Integration test for Phase 13 — Journal Entries & Pages, built on the
// Phase 10/12 template (see tokens.test.ts's header comment): a real Express
// app via createApp() with a fake FoundryClient swapped onto
// `app.locals["foundryClient"]`, driven with supertest. No real
// WebSocket/bridge/Foundry instance is involved.
//
// JournalEntry's own CRUD is already covered generically by Phase 8's
// `makeDocumentEndpoints()` tests (documents.test.ts) — this only exercises
// the embedded JournalEntryPage descriptors added this phase.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import request from "supertest";

import type {
  DocumentData,
  DocumentDeleteResult,
  JournalPageCreateInput,
  JournalPageIdInput,
  JournalPageListInput,
  JournalPageUpdateInput,
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

void describe("Phase 13 journal entry pages", () => {
  void it("GET /api/journal-entries/:journalEntryId/pages lists embedded pages", async () => {
    const app = buildApp(((type: string, payload: JournalPageListInput) => {
      assert.equal(type, "journalEntryListPages");
      assert.deepEqual(payload, { journalEntryId: "j1" });
      const result: DocumentData[] = [{ _id: "p1", name: "Chapter 1" }];
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .get("/api/journal-entries/j1/pages")
      .set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [{ _id: "p1", name: "Chapter 1" }]);
  });

  void it("GET /api/journal-entries/:journalEntryId/pages/:pageId reads a single page", async () => {
    const app = buildApp(((type: string, payload: JournalPageIdInput) => {
      assert.equal(type, "journalEntryGetPage");
      assert.deepEqual(payload, { journalEntryId: "j1", pageId: "p1" });
      const result: DocumentData = { _id: "p1", name: "Chapter 1" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .get("/api/journal-entries/j1/pages/p1")
      .set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "p1", name: "Chapter 1" });
  });

  void it("POST /api/journal-entries/:journalEntryId/pages creates an embedded page from the body's `data`", async () => {
    const app = buildApp(((type: string, payload: JournalPageCreateInput) => {
      assert.equal(type, "journalEntryCreatePage");
      assert.deepEqual(payload, { journalEntryId: "j1", data: { name: "Chapter 2" } });
      const result: DocumentData = { _id: "p2", name: "Chapter 2" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/journal-entries/j1/pages")
      .set(API_KEY_HEADER, API_KEY)
      .send({ data: { name: "Chapter 2" } });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "p2", name: "Chapter 2" });
  });

  void it("PUT /api/journal-entries/:journalEntryId/pages/:pageId sends ids from the path and changes from the body", async () => {
    const app = buildApp(((type: string, payload: JournalPageUpdateInput) => {
      assert.equal(type, "journalEntryUpdatePage");
      assert.deepEqual(payload, {
        journalEntryId: "j1",
        pageId: "p1",
        changes: { name: "Chapter 1 (revised)" },
      });
      const result: DocumentData = { _id: "p1", name: "Chapter 1 (revised)" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .put("/api/journal-entries/j1/pages/p1")
      .set(API_KEY_HEADER, API_KEY)
      .send({ changes: { name: "Chapter 1 (revised)" } });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "p1", name: "Chapter 1 (revised)" });
  });

  void it("DELETE /api/journal-entries/:journalEntryId/pages/:pageId deletes an embedded page", async () => {
    const app = buildApp(((type: string, payload: JournalPageIdInput) => {
      assert.equal(type, "journalEntryDeletePage");
      assert.deepEqual(payload, { journalEntryId: "j1", pageId: "p1" });
      const result: DocumentDeleteResult = { id: "p1" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .delete("/api/journal-entries/j1/pages/p1")
      .set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { id: "p1" });
  });

  void it("rejects a request with a missing/incorrect API key with 401", async () => {
    const app = buildApp((() => Promise.resolve({})) as FoundryClient["call"]);

    const res = await request(app).get("/api/journal-entries/j1/pages");
    assert.equal(res.status, 401);
  });
});
