// Integration test for Phase 27 — Localization & Misc Utilities, built on
// the same template every phase since Phase 20 uses (see users.test.ts's
// header comment): a real Express app via createApp() with a fake
// FoundryClient swapped onto `app.locals["foundryClient"]`, driven with
// supertest. No real WebSocket/bridge/Foundry instance is involved.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import request from "supertest";

import type {
  EnrichHtmlInput,
  EnrichHtmlResult,
  LocalizeInput,
  LocalizeResult,
  SearchInput,
  SearchResult,
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

void describe("Phase 27 localization & misc utilities", () => {
  void it("GET /api/localize resolves a plain key", async () => {
    const app = buildApp(((type: string, payload: LocalizeInput) => {
      assert.equal(type, "localize");
      assert.deepEqual(payload, { key: "MYMODULE.greeting" });
      const result: LocalizeResult = { key: "MYMODULE.greeting", text: "Hello" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .get("/api/localize")
      .query({ key: "MYMODULE.greeting" })
      .set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { key: "MYMODULE.greeting", text: "Hello" });
  });

  void it("GET /api/localize parses a JSON `data` query param into an interpolation object", async () => {
    const app = buildApp(((type: string, payload: LocalizeInput) => {
      assert.equal(type, "localize");
      assert.deepEqual(payload, { key: "MYMODULE.welcome", data: { name: "Bob" } });
      const result: LocalizeResult = { key: "MYMODULE.welcome", text: "Welcome, Bob" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .get("/api/localize")
      .query({ key: "MYMODULE.welcome", data: JSON.stringify({ name: "Bob" }) })
      .set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { key: "MYMODULE.welcome", text: "Welcome, Bob" });
  });

  void it("POST /api/enrich-html enriches raw content into HTML", async () => {
    const app = buildApp(((type: string, payload: EnrichHtmlInput) => {
      assert.equal(type, "enrichHtml");
      assert.deepEqual(payload, { content: "@UUID[Actor.abc]{Bob}" });
      const result: EnrichHtmlResult = { html: '<a class="content-link">Bob</a>' };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/enrich-html")
      .set(API_KEY_HEADER, API_KEY)
      .send({ content: "@UUID[Actor.abc]{Bob}" });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { html: '<a class="content-link">Bob</a>' });
  });

  void it("GET /api/search searches every collection when `types` is omitted", async () => {
    const app = buildApp(((type: string, payload: SearchInput) => {
      assert.equal(type, "search");
      assert.deepEqual(payload, { query: "gob" });
      const result: SearchResult = {
        matches: [{ documentType: "Actor", id: "a1", name: "Goblin" }],
      };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/api/search").query({ query: "gob" }).set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      matches: [{ documentType: "Actor", id: "a1", name: "Goblin" }],
    });
  });

  void it("GET /api/search splits a comma-separated `types` into a list", async () => {
    const app = buildApp(((type: string, payload: SearchInput) => {
      assert.equal(type, "search");
      assert.deepEqual(payload, { query: "sword", types: ["Actor", "Item"] });
      const result: SearchResult = { matches: [] };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .get("/api/search")
      .query({ query: "sword", types: "Actor,Item" })
      .set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { matches: [] });
  });

  void it("rejects a request with a missing/incorrect API key with 401", async () => {
    const app = buildApp((() => Promise.resolve({})) as FoundryClient["call"]);

    const res = await request(app).get("/api/localize").query({ key: "x" });
    assert.equal(res.status, 401);
  });
});
