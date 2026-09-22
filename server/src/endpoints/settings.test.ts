// Integration test for Phase 7 — Settings Read/Write, built on the Phase 6
// template (see meta.test.ts's header comment): a real Express app via
// createApp() with a fake FoundryClient swapped onto
// `app.locals["foundryClient"]`, driven with supertest. No real
// WebSocket/bridge/Foundry instance is involved.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import request from "supertest";

import type { GetSettingInput, SetSettingInput, SettingValue } from "@foundry-local-api/shared";

import { createApp } from "../app.js";
import { FoundryBridgeError } from "../bridge/errors.js";
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

void describe("Phase 7 settings read/write endpoints", () => {
  void it("GET /api/settings/:namespace/:key returns 200 with the bridge result", async () => {
    const app = buildApp(((type: string, payload: GetSettingInput) => {
      assert.equal(type, "getSetting");
      assert.deepEqual(payload, { namespace: "core", key: "someSetting" });
      const result: SettingValue = { namespace: "core", key: "someSetting", value: true };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .get("/api/settings/core/someSetting")
      .set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { namespace: "core", key: "someSetting", value: true });
  });

  void it("PUT /api/settings/:namespace/:key sends namespace/key from the path and value from the body", async () => {
    const app = buildApp(((type: string, payload: SetSettingInput) => {
      assert.equal(type, "setSetting");
      assert.deepEqual(payload, { namespace: "my-module", key: "volume", value: 0.5 });
      const result: SettingValue = { namespace: "my-module", key: "volume", value: 0.5 };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .put("/api/settings/my-module/volume")
      .set(API_KEY_HEADER, API_KEY)
      .send({ value: 0.5 });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { namespace: "my-module", key: "volume", value: 0.5 });
  });

  void it("propagates a module-side rejection (e.g. non-GM writing a world setting) as a 500", async () => {
    const app = buildApp((() =>
      Promise.reject(
        new FoundryBridgeError(
          "HANDLER_ERROR",
          'Only a GM may change the world-scope setting "core.worldSetting".',
        ),
      )) as FoundryClient["call"]);

    const res = await request(app)
      .put("/api/settings/core/worldSetting")
      .set(API_KEY_HEADER, API_KEY)
      .send({ value: false });

    assert.equal(res.status, 500);
    assert.equal(res.body.error.code, "HANDLER_ERROR");
  });

  void it("rejects a request with a missing/incorrect API key with 401", async () => {
    const app = buildApp((() =>
      Promise.resolve({
        namespace: "core",
        key: "someSetting",
        value: true,
      })) as FoundryClient["call"]);

    const res = await request(app).get("/api/settings/core/someSetting");
    assert.equal(res.status, 401);
  });
});
