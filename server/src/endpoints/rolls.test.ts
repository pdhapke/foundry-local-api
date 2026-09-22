// Integration test for Phase 14 — Dice Rolling, built on the established
// template (see items.test.ts's header comment): a real Express app via
// createApp() with a fake FoundryClient swapped onto
// `app.locals["foundryClient"]`, driven with supertest. No real
// WebSocket/bridge/Foundry instance is involved.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import request from "supertest";

import type { RollEvaluateInput, RollEvaluateResult } from "@foundry-local-api/shared";

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

void describe("Phase 14 rolls", () => {
  void it("POST /api/rolls evaluates a formula and returns the normalized result", async () => {
    const app = buildApp(((type: string, payload: RollEvaluateInput) => {
      assert.equal(type, "rollEvaluate");
      assert.deepEqual(payload, { formula: "2d6+3" });
      const result: RollEvaluateResult = {
        formula: "2d6 + 3",
        total: 11,
        result: "(4 + 4) + 3",
        dice: [{ faces: 6, results: [4, 4] }],
      };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/rolls")
      .set(API_KEY_HEADER, API_KEY)
      .send({ formula: "2d6+3" });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      formula: "2d6 + 3",
      total: 11,
      result: "(4 + 4) + 3",
      dice: [{ faces: 6, results: [4, 4] }],
    });
  });

  void it("POST /api/rolls forwards optional roll `data`", async () => {
    const app = buildApp(((type: string, payload: RollEvaluateInput) => {
      assert.equal(type, "rollEvaluate");
      assert.deepEqual(payload, { formula: "1d20+@mod", data: { mod: 5 } });
      const result: RollEvaluateResult = {
        formula: "1d20 + 5",
        total: 17,
        result: "12 + 5",
        dice: [{ faces: 20, results: [12] }],
      };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/api/rolls")
      .set(API_KEY_HEADER, API_KEY)
      .send({ formula: "1d20+@mod", data: { mod: 5 } });

    assert.equal(res.status, 200);
    assert.equal(res.body.total, 17);
  });

  void it("rejects a missing formula with 400", async () => {
    const app = buildApp((() => Promise.resolve({})) as FoundryClient["call"]);

    const res = await request(app).post("/api/rolls").set(API_KEY_HEADER, API_KEY).send({});

    assert.equal(res.status, 400);
  });

  void it("rejects a request with a missing/incorrect API key with 401", async () => {
    const app = buildApp((() => Promise.resolve({})) as FoundryClient["call"]);

    const res = await request(app).post("/api/rolls").send({ formula: "1d20" });
    assert.equal(res.status, 401);
  });
});
