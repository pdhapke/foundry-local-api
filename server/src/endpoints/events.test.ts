// Integration test for Phase 26's MCP-side polling tool
// (`foundry_get_recent_events` / `GET /api/events/recent`), built on the same
// template every phase since Phase 20 uses (see permissions.test.ts's header
// comment): a real Express app via createApp(), driven with supertest. No
// real WebSocket/bridge/Foundry instance is involved.
//
// Unlike every other phase's descriptor tests, this one doesn't fake
// `FoundryClient.call` — the handler reads `app.locals["eventBus"]` directly
// instead of round-tripping through the bridge (see events.ts's header
// comment for why), so the fake here is a `FoundryEventBus`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import request from "supertest";

import { createApp } from "../app.js";
import type { FoundryClient } from "../bridge/foundry-client.js";
import { FoundryEventBus } from "../events/event-bus.js";
import { API_KEY_HEADER } from "../middleware/auth.js";

const API_KEY = "test-api-key-0123456789abcdef";

function buildApp(eventBus?: FoundryEventBus) {
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
  // Not exercised by this descriptor, but every request handler resolves it
  // off app.locals regardless, so it must be present for the route to work.
  app.locals["foundryClient"] = {} as unknown as FoundryClient;
  if (eventBus) {
    app.locals["eventBus"] = eventBus;
  }
  return app;
}

void describe("Phase 26 recent events (MCP polling fallback)", () => {
  void it("GET /api/events/recent returns the whole buffer when no limit is given", async () => {
    const eventBus = new FoundryEventBus();
    eventBus.publish("createActor", { _id: "a1" });
    eventBus.publish("updateToken", { _id: "t1" });
    const app = buildApp(eventBus);

    const res = await request(app).get("/api/events/recent").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.equal(res.body.events.length, 2);
    assert.equal(res.body.events[0].event, "createActor");
    assert.equal(res.body.events[1].event, "updateToken");
  });

  void it("GET /api/events/recent?limit=1 caps the returned events to the most recent", async () => {
    const eventBus = new FoundryEventBus();
    eventBus.publish("createActor", { _id: "a1" });
    eventBus.publish("updateToken", { _id: "t1" });
    const app = buildApp(eventBus);

    const res = await request(app).get("/api/events/recent?limit=1").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.events.map((e: { event: string }) => e.event),
      ["updateToken"],
    );
  });

  void it("returns 503 when no event bus is wired up on the server", async () => {
    const app = buildApp(undefined);

    const res = await request(app).get("/api/events/recent").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, "NO_EVENT_BUS");
  });

  void it("rejects a request with a missing/incorrect API key with 401", async () => {
    const app = buildApp(new FoundryEventBus());

    const res = await request(app).get("/api/events/recent");
    assert.equal(res.status, 401);
  });
});
