// Integration test for Phase 20 — Compendium Packs, built on the Phase
// 12/13 template (see journal-pages.test.ts's header comment): a real
// Express app via createApp() with a fake FoundryClient swapped onto
// `app.locals["foundryClient"]`, driven with supertest. No real
// WebSocket/bridge/Foundry instance is involved.
//
// Unlike every document-CRUD phase since Phase 8, packs have no generic
// factory to fall back on (no `game.collections` entry of their own), so
// this exercises all seven descriptors directly.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import request from "supertest";

import type {
  DocumentData,
  DocumentDeleteResult,
  PackCreateEntryInput,
  PackEntryIdInput,
  PackIdInput,
  PackIndexEntry,
  PackInfo,
  PackUpdateEntryInput,
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

void describe("Phase 20 compendium packs", () => {
  void it("GET /api/packs lists every compendium pack", async () => {
    const app = buildApp((() => {
      const result: PackInfo[] = [
        {
          id: "world.my-macros",
          label: "My Macros",
          type: "Macro",
          package: "my-world",
          packageType: "world",
          path: "packs/my-macros",
        },
      ];
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/api/packs").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [
      {
        id: "world.my-macros",
        label: "My Macros",
        type: "Macro",
        package: "my-world",
        packageType: "world",
        path: "packs/my-macros",
      },
    ]);
  });

  void it("GET /api/packs/:packId/index reads a pack's index", async () => {
    const app = buildApp(((type: string, payload: PackIdInput) => {
      assert.equal(type, "packGetIndex");
      assert.deepEqual(payload, { packId: "dnd5e.monsters" });
      const result: PackIndexEntry[] = [{ _id: "e1", name: "Goblin" }];
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .get("/api/packs/dnd5e.monsters/index")
      .set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [{ _id: "e1", name: "Goblin" }]);
  });

  void it("GET /api/packs/:packId/entries/:entryId reads a single entry", async () => {
    const app = buildApp(((type: string, payload: PackEntryIdInput) => {
      assert.equal(type, "packGetEntry");
      assert.deepEqual(payload, { packId: "dnd5e.monsters", entryId: "e1" });
      const result: DocumentData = { _id: "e1", name: "Goblin" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .get("/api/packs/dnd5e.monsters/entries/e1")
      .set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "e1", name: "Goblin" });
  });

  void it("POST /api/packs/:packId/entries creates an entry from the body's `data`", async () => {
    const app = buildApp(((type: string, payload: PackCreateEntryInput) => {
      assert.equal(type, "packCreateEntry");
      assert.deepEqual(payload, {
        packId: "world.my-macros",
        data: { name: "New Macro", type: "script" },
      });
      const result: DocumentData = { _id: "m1", name: "New Macro", type: "script" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/packs/world.my-macros/entries")
      .set(API_KEY_HEADER, API_KEY)
      .send({ data: { name: "New Macro", type: "script" } });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "m1", name: "New Macro", type: "script" });
  });

  void it("PUT /api/packs/:packId/entries/:entryId sends ids from the path and changes from the body", async () => {
    const app = buildApp(((type: string, payload: PackUpdateEntryInput) => {
      assert.equal(type, "packUpdateEntry");
      assert.deepEqual(payload, {
        packId: "world.my-macros",
        entryId: "m1",
        changes: { name: "Renamed Macro" },
      });
      const result: DocumentData = { _id: "m1", name: "Renamed Macro" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .put("/api/packs/world.my-macros/entries/m1")
      .set(API_KEY_HEADER, API_KEY)
      .send({ changes: { name: "Renamed Macro" } });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "m1", name: "Renamed Macro" });
  });

  void it("DELETE /api/packs/:packId/entries/:entryId deletes an entry", async () => {
    const app = buildApp(((type: string, payload: PackEntryIdInput) => {
      assert.equal(type, "packDeleteEntry");
      assert.deepEqual(payload, { packId: "world.my-macros", entryId: "m1" });
      const result: DocumentDeleteResult = { id: "m1" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .delete("/api/packs/world.my-macros/entries/m1")
      .set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { id: "m1" });
  });

  void it("POST /api/packs/:packId/entries/:entryId/import imports an entry into the world", async () => {
    const app = buildApp(((type: string, payload: PackEntryIdInput) => {
      assert.equal(type, "packImportEntry");
      assert.deepEqual(payload, { packId: "dnd5e.monsters", entryId: "e1" });
      const result: DocumentData = { _id: "a1", name: "Goblin" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/packs/dnd5e.monsters/entries/e1/import")
      .set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "a1", name: "Goblin" });
  });

  void it("rejects a request with a missing/incorrect API key with 401", async () => {
    const app = buildApp((() => Promise.resolve({})) as FoundryClient["call"]);

    const res = await request(app).get("/api/packs");
    assert.equal(res.status, 401);
  });
});
