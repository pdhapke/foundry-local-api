// Integration test for Phase 53 — Adventure Document Import/Export, built on
// the Phase 20/51 template (see packs.test.ts's header comment): a real
// Express app via createApp() with a fake FoundryClient swapped onto
// `app.locals["foundryClient"]`, driven with supertest. No real
// WebSocket/bridge/Foundry instance is involved.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import request from "supertest";

import type {
  AdventureExportInput,
  AdventureImportResult,
  DocumentData,
  PackEntryIdInput,
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

void describe("Phase 53 adventure document import/export", () => {
  void it("POST /api/packs/:packId/adventures assembles world document ids into a new adventure entry", async () => {
    const app = buildApp(((type: string, payload: AdventureExportInput) => {
      assert.equal(type, "adventureExport");
      assert.deepEqual(payload, {
        packId: "world.my-adventures",
        name: "The Sunless Citadel",
        actorIds: ["a1", "a2"],
        sceneIds: ["s1"],
      });
      const result: DocumentData = {
        _id: "adv1",
        name: "The Sunless Citadel",
        actors: [{ _id: "a1" }, { _id: "a2" }],
        scenes: [{ _id: "s1" }],
      };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/packs/world.my-adventures/adventures")
      .set(API_KEY_HEADER, API_KEY)
      .send({
        name: "The Sunless Citadel",
        actorIds: ["a1", "a2"],
        sceneIds: ["s1"],
      });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      _id: "adv1",
      name: "The Sunless Citadel",
      actors: [{ _id: "a1" }, { _id: "a2" }],
      scenes: [{ _id: "s1" }],
    });
  });

  void it("POST /api/packs/:packId/adventures/:entryId/import imports an adventure into the world", async () => {
    const app = buildApp(((type: string, payload: PackEntryIdInput) => {
      assert.equal(type, "adventureImport");
      assert.deepEqual(payload, { packId: "world.my-adventures", entryId: "adv1" });
      const result: AdventureImportResult = {
        actors: [{ _id: "a1" }],
        scenes: [{ _id: "s1" }],
      };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/packs/world.my-adventures/adventures/adv1/import")
      .set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      actors: [{ _id: "a1" }],
      scenes: [{ _id: "s1" }],
    });
  });

  void it("rejects a request with a missing/incorrect API key with 401", async () => {
    const app = buildApp((() => Promise.resolve({})) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/packs/world.my-adventures/adventures")
      .send({ name: "The Sunless Citadel" });
    assert.equal(res.status, 401);
  });

  void it("foundry_import_adventure carries a destructiveHint annotation", async () => {
    const { adventureEndpointDescriptors } = await import("./adventures.js");
    const importDescriptor = adventureEndpointDescriptors.find(
      (descriptor) => descriptor.name === "foundry_import_adventure",
    );
    assert.equal(importDescriptor?.annotations?.destructiveHint, true);
  });
});
