// Integration test for Phase 8 — Generic Document CRUD Core, built on the
// Phase 6 template (see meta.test.ts's header comment): a real Express app
// via createApp() with a fake FoundryClient swapped onto
// `app.locals["foundryClient"]`, driven with supertest. No real
// WebSocket/bridge/Foundry instance is involved.
//
// Exercises both the exported `journalEntryEndpointDescriptors` (proving the
// real REST wiring, mounted on the shared `apiRouter` singleton — see
// routes/api.ts) and a second, made-up document type built directly with
// `makeDocumentEndpoints()` (proving the factory itself is generic — its
// output is shaped correctly for any document type, not just the one it's
// actually mounted for).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import request from "supertest";

import type {
  DocumentCreateInput,
  DocumentData,
  DocumentDeleteResult,
  DocumentIdInput,
  DocumentTypeInput,
  DocumentUpdateInput,
} from "@foundry-local-api/shared";

import { createApp } from "../app.js";
import { FoundryBridgeError } from "../bridge/errors.js";
import type { FoundryClient } from "../bridge/foundry-client.js";
import { API_KEY_HEADER } from "../middleware/auth.js";
import { makeDocumentEndpoints } from "./documents.js";
import type { EndpointContext } from "./types.js";

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

void describe("Phase 8 generic document CRUD (JournalEntry)", () => {
  void it("GET /api/journal-entries lists documents", async () => {
    const app = buildApp(((type: string, payload: DocumentTypeInput) => {
      assert.equal(type, "documentList");
      assert.deepEqual(payload, { documentType: "JournalEntry" });
      const result: DocumentData[] = [{ _id: "j1", name: "Notes" }];
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/api/journal-entries").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [{ _id: "j1", name: "Notes" }]);
  });

  void it("GET /api/journal-entries/:id reads a single document", async () => {
    const app = buildApp(((type: string, payload: DocumentIdInput) => {
      assert.equal(type, "documentGet");
      assert.deepEqual(payload, { documentType: "JournalEntry", id: "j1" });
      const result: DocumentData = { _id: "j1", name: "Notes" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/api/journal-entries/j1").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "j1", name: "Notes" });
  });

  void it("POST /api/journal-entries creates a document from the body's `data`", async () => {
    const app = buildApp(((type: string, payload: DocumentCreateInput) => {
      assert.equal(type, "documentCreate");
      assert.deepEqual(payload, {
        documentType: "JournalEntry",
        data: { name: "New Entry" },
      });
      const result: DocumentData = { _id: "j2", name: "New Entry" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/journal-entries")
      .set(API_KEY_HEADER, API_KEY)
      .send({ data: { name: "New Entry" } });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "j2", name: "New Entry" });
  });

  void it("PUT /api/journal-entries/:id sends id from the path and changes from the body", async () => {
    const app = buildApp(((type: string, payload: DocumentUpdateInput) => {
      assert.equal(type, "documentUpdate");
      assert.deepEqual(payload, {
        documentType: "JournalEntry",
        id: "j1",
        changes: { name: "Renamed" },
      });
      const result: DocumentData = { _id: "j1", name: "Renamed" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .put("/api/journal-entries/j1")
      .set(API_KEY_HEADER, API_KEY)
      .send({ changes: { name: "Renamed" } });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "j1", name: "Renamed" });
  });

  void it("DELETE /api/journal-entries/:id deletes a document", async () => {
    const app = buildApp(((type: string, payload: DocumentIdInput) => {
      assert.equal(type, "documentDelete");
      assert.deepEqual(payload, { documentType: "JournalEntry", id: "j1" });
      const result: DocumentDeleteResult = { id: "j1" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).delete("/api/journal-entries/j1").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { id: "j1" });
  });

  void it("propagates a module-side rejection (e.g. unknown document) as a 500", async () => {
    const app = buildApp((() =>
      Promise.reject(
        new FoundryBridgeError("HANDLER_ERROR", 'JournalEntry "missing" not found'),
      )) as FoundryClient["call"]);

    const res = await request(app).get("/api/journal-entries/missing").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 500);
    assert.equal(res.body.error.code, "HANDLER_ERROR");
  });

  void it("rejects a request with a missing/incorrect API key with 401", async () => {
    const app = buildApp((() => Promise.resolve([])) as FoundryClient["call"]);

    const res = await request(app).get("/api/journal-entries");
    assert.equal(res.status, 401);
  });
});

void describe("makeDocumentEndpoints() is generic across document types", () => {
  void it("builds five correctly-shaped descriptors for an unrelated document type", () => {
    const descriptors = makeDocumentEndpoints({
      documentType: "RollTable",
      routeBase: "roll-tables",
      toolSingular: "roll_table",
      toolPlural: "roll_tables",
    });

    assert.deepEqual(
      descriptors.map((d) => ({ name: d.name, method: d.method, path: d.path })),
      [
        { name: "foundry_list_roll_tables", method: "get", path: "/roll-tables" },
        { name: "foundry_get_roll_table", method: "get", path: "/roll-tables/:id" },
        { name: "foundry_create_roll_table", method: "post", path: "/roll-tables" },
        { name: "foundry_update_roll_table", method: "put", path: "/roll-tables/:id" },
        { name: "foundry_delete_roll_table", method: "delete", path: "/roll-tables/:id" },
      ],
    );
  });

  void it("closes over the given documentType, independent of any other call", async () => {
    const [listDescriptor] = makeDocumentEndpoints({
      documentType: "RollTable",
      routeBase: "roll-tables",
      toolSingular: "roll_table",
      toolPlural: "roll_tables",
    });

    const ctx: EndpointContext = {
      foundryClient: {
        call: ((type: string, payload: DocumentTypeInput) => {
          assert.equal(type, "documentList");
          assert.deepEqual(payload, { documentType: "RollTable" });
          return Promise.resolve([]);
        }) as FoundryClient["call"],
      } as unknown as FoundryClient,
    };

    const result = await listDescriptor?.handler(undefined, ctx);

    assert.deepEqual(result, []);
  });
});
