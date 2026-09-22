// Integration test for Phase 14 — Chat Messages, built on the established
// template (see items.test.ts's header comment): a real Express app via
// createApp() with a fake FoundryClient swapped onto
// `app.locals["foundryClient"]`, driven with supertest. No real
// WebSocket/bridge/Foundry instance is involved.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import request from "supertest";

import type { ChatListInput, ChatMessageData, ChatSendInput } from "@foundry-local-api/shared";

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

void describe("Phase 14 chat", () => {
  void it("GET /api/chat lists recent chat messages", async () => {
    const app = buildApp(((type: string, payload: ChatListInput) => {
      assert.equal(type, "chatList");
      assert.deepEqual(payload, {});
      const result: ChatMessageData[] = [{ _id: "m1", content: "Hello" }];
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/api/chat").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [{ _id: "m1", content: "Hello" }]);
  });

  void it("GET /api/chat?limit=5 forwards the limit as a number", async () => {
    const app = buildApp(((type: string, payload: ChatListInput) => {
      assert.equal(type, "chatList");
      assert.deepEqual(payload, { limit: 5 });
      const result: ChatMessageData[] = [];
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/api/chat?limit=5").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
  });

  void it("POST /api/chat sends a new chat message from the body's `data`", async () => {
    const app = buildApp(((type: string, payload: ChatSendInput) => {
      assert.equal(type, "chatSend");
      assert.deepEqual(payload, { data: { content: "Hello!" } });
      const result: ChatMessageData = { _id: "m2", content: "Hello!" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/chat")
      .set(API_KEY_HEADER, API_KEY)
      .send({ data: { content: "Hello!" } });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { _id: "m2", content: "Hello!" });
  });

  void it("rejects a request with a missing/incorrect API key with 401", async () => {
    const app = buildApp((() => Promise.resolve({})) as FoundryClient["call"]);

    const res = await request(app).get("/api/chat");
    assert.equal(res.status, 401);
  });
});
