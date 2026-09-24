// Integration test for Phase 42 — UI Notifications (see shared/src/
// notifications.ts), built on the standard template (see
// game-state.test.ts's header comment): a real Express app via createApp()
// with a fake FoundryClient swapped onto `app.locals["foundryClient"]`,
// driven with supertest. No real WebSocket/bridge/Foundry instance is
// involved.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import request from "supertest";

import type { NotifyInput, NotifyResult } from "@foundry-local-api/shared";

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

void describe("Phase 42 UI notifications", () => {
  void it("POST /api/notify forwards message/type/target and returns delivery confirmation", async () => {
    const app = buildApp(((type: string, payload: NotifyInput) => {
      assert.equal(type, "notify");
      assert.deepEqual(payload, { message: "Round 3 begins", type: "warning", target: "all" });
      const result: NotifyResult = { delivered: "all" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/notify")
      .set(API_KEY_HEADER, API_KEY)
      .send({ message: "Round 3 begins", type: "warning", target: "all" });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { delivered: "all" });
  });

  void it("POST /api/notify defaults to omitted type/target, letting the module apply its own defaults", async () => {
    const app = buildApp(((type: string, payload: NotifyInput) => {
      assert.equal(type, "notify");
      assert.deepEqual(payload, { message: "Saved" });
      const result: NotifyResult = { delivered: "caller" };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/notify")
      .set(API_KEY_HEADER, API_KEY)
      .send({ message: "Saved" });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { delivered: "caller" });
  });

  void it("POST /api/notify rejects a body missing `message`", async () => {
    const app = buildApp((() => Promise.resolve({})) as FoundryClient["call"]);

    const res = await request(app).post("/api/notify").set(API_KEY_HEADER, API_KEY).send({});

    assert.equal(res.status, 400);
  });

  void it("POST /api/notify rejects an invalid `type` value", async () => {
    const app = buildApp((() => Promise.resolve({})) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/notify")
      .set(API_KEY_HEADER, API_KEY)
      .send({ message: "hi", type: "warn" });

    assert.equal(res.status, 400);
  });

  void it("rejects a request with a missing/incorrect API key with 401", async () => {
    const app = buildApp((() => Promise.resolve({})) as FoundryClient["call"]);

    const res = await request(app).post("/api/notify").send({ message: "hi" });
    assert.equal(res.status, 401);
  });
});
