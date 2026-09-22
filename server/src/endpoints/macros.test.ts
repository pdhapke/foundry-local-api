// Integration test for Phase 15 — Macros, built on the Phase 8 template (see
// documents.test.ts's header comment): a real Express app via createApp()
// with a fake FoundryClient swapped onto `app.locals["foundryClient"]`,
// driven with supertest. No real WebSocket/bridge/Foundry instance is
// involved.
//
// Base CRUD is already proven generic by documents.test.ts's
// `makeDocumentEndpoints()` tests, so this file only exercises the one
// macro-specific extra (execute) plus a smoke check that
// macroEndpointDescriptors actually mounts CRUD under `/api/macros`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import request from "supertest";

import type {
  DocumentData,
  DocumentTypeInput,
  MacroExecuteResult,
  MacroIdInput,
} from "@foundry-local-api/shared";

import { createApp } from "../app.js";
import { FoundryBridgeError } from "../bridge/errors.js";
import type { FoundryClient } from "../bridge/foundry-client.js";
import { API_KEY_HEADER } from "../middleware/auth.js";
import { macroEndpointDescriptors } from "./macros.js";

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

void describe("Phase 15 macros", () => {
  void it("GET /api/macros lists documents via the generic Macro CRUD factory", async () => {
    const app = buildApp(((type: string, payload: DocumentTypeInput) => {
      assert.equal(type, "documentList");
      assert.deepEqual(payload, { documentType: "Macro" });
      const result: DocumentData[] = [{ _id: "m1", name: "Fireball" }];
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/api/macros").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [{ _id: "m1", name: "Fireball" }]);
  });

  void it("POST /api/macros/:id/execute executes the macro", async () => {
    const app = buildApp(((type: string, payload: MacroIdInput) => {
      assert.equal(type, "macroExecute");
      assert.deepEqual(payload, { id: "m1" });
      const result: MacroExecuteResult = { id: "m1", executed: true };
      return Promise.resolve(result);
    }) as FoundryClient["call"]);

    const res = await request(app).post("/api/macros/m1/execute").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { id: "m1", executed: true });
  });

  void it("execute tool carries an explicit destructive-hint annotation", () => {
    const executeDescriptor = macroEndpointDescriptors.find(
      (d) => d.name === "foundry_execute_macro",
    );
    assert.ok(executeDescriptor);
    assert.equal(executeDescriptor?.annotations?.destructiveHint, true);
  });

  void it("rejects a request with a missing/incorrect API key with 401", async () => {
    const app = buildApp((() => Promise.resolve({})) as FoundryClient["call"]);

    const res = await request(app).post("/api/macros/m1/execute");
    assert.equal(res.status, 401);
  });

  void it("propagates a FoundryBridgeError from a failed execution as a normalized HTTP error", async () => {
    const app = buildApp((() =>
      Promise.reject(
        new FoundryBridgeError("HANDLER_ERROR", "macro script threw during execution"),
      )) as FoundryClient["call"]);

    const res = await request(app).post("/api/macros/m1/execute").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 500);
    assert.equal(res.body.error.code, "HANDLER_ERROR");
  });
});
