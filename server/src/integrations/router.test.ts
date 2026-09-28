// Phase 32 — unit tests for the dynamic integration router
// (applyActiveIntegrations/integrationRouterMiddleware).
//
// Follows registry.test.ts's "build a small standalone Express app" harness
// style, not createApp() (which always mounts the real, fixed production
// integration registry). Registers small fake integrations directly by
// passing them as the explicit `allRegistered` parameter, rather than
// mutating the real ./registry.js singleton.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import express from "express";
import request from "supertest";

// Side-effect-only import, and deliberately first: this file is a fresh
// entry point into the pre-existing circular import documented in Phase
// 30's deviation log (endpoints/index.ts -> events.ts -> app.js ->
// routes/api.ts -> endpoints/index.ts). `./router.js` (below) transitively
// imports `../endpoints/registry.js` -> `../bridge/errors.js` -> `../app.js`,
// which is the same cycle entered from a different edge; without forcing
// `../app.js` to evaluate first, `routes/api.ts`'s top-level
// `mountRestEndpoints(apiRouter, allEndpointDescriptors)` call runs before
// `../endpoints/registry.js` has finished initializing. Same workaround as
// server/src/scripts/generate-docs.ts and server/src/endpoints/
// registry.test.ts (the latter gets this for free because `../app.js`
// happens to sort alphabetically before its other imports).
import "../app.js";
import type { FoundryClient } from "../bridge/foundry-client.js";
import type { AnyEndpointDescriptor } from "../endpoints/types.js";
import { applyActiveIntegrations, integrationRouterMiddleware } from "./router.js";
import { trailsOfDestinyIntegration } from "./trails-of-destiny/index.js";
import type { Integration } from "./types.js";

function buildTestApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/integrations", integrationRouterMiddleware);
  return app;
}

function makeIntegration(id: string, kind: Integration["kind"]): Integration {
  const endpoint: AnyEndpointDescriptor = {
    name: `${id}_ping`,
    description: "test",
    method: "get",
    path: `/${id}/ping`,
    handler: () => ({ id }),
  };
  return { id, kind, detect: () => true, endpoints: [endpoint] };
}

void describe("applyActiveIntegrations / integrationRouterMiddleware", () => {
  void it("an active integration's route responds 200 with its handler's result", async () => {
    const active = makeIntegration("alpha", "system");
    const inactive = makeIntegration("beta", "module");
    applyActiveIntegrations([active], [active, inactive]);
    const app = buildTestApp();

    const res = await request(app).get("/api/integrations/alpha/ping");

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { id: "alpha" });
  });

  void it("an inactive-but-registered integration's namespace 404s with INTEGRATION_INACTIVE naming its id", async () => {
    const active = makeIntegration("alpha", "system");
    const inactive = makeIntegration("beta", "module");
    applyActiveIntegrations([active], [active, inactive]);
    const app = buildTestApp();

    const res = await request(app).get("/api/integrations/beta/ping");

    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, "INTEGRATION_INACTIVE");
    assert.match(res.body.error.message, /beta/);

    // Also covers the bare no-trailing-segment case.
    const bare = await request(app).get("/api/integrations/beta");
    assert.equal(bare.status, 404);
    assert.equal(bare.body.error.code, "INTEGRATION_INACTIVE");
  });

  void it("returns INTEGRATION_INACTIVE for a real Trails route when Trails is inactive", async () => {
    applyActiveIntegrations([], [trailsOfDestinyIntegration]);
    const app = buildTestApp();

    const res = await request(app).get("/api/integrations/trails-of-destiny/config");

    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, "INTEGRATION_INACTIVE");
    assert.match(res.body.error.message, /trails-of-destiny/);
  });

  void it("mounts the real Trails descriptors only at the exact active REST namespace", async () => {
    applyActiveIntegrations([trailsOfDestinyIntegration], [trailsOfDestinyIntegration]);
    const app = buildTestApp();
    const calls: Array<{ command: string; payload: unknown }> = [];
    app.locals["foundryClient"] = {
      call: (command: string, payload: unknown) => {
        calls.push({ command, payload });
        return Promise.resolve({ packageVersion: "0.1.0" });
      },
    } as unknown as FoundryClient;

    const exact = await request(app).get("/api/integrations/trails-of-destiny/config");
    assert.equal(exact.status, 200);
    assert.deepEqual(exact.body, { packageVersion: "0.1.0" });
    assert.deepEqual(calls, [{ command: "trails-of-destiny.get-config", payload: undefined }]);

    const wrongNamespace = await request(app).get("/api/integrations/trails/config");
    assert.equal(wrongNamespace.status, 404);
    assert.equal(calls.length, 1);
  });

  void it("falls through (this router's own miss) for a path outside any registered integration's namespace", async () => {
    const active = makeIntegration("alpha", "system");
    applyActiveIntegrations([active], [active]);
    const app = buildTestApp();

    const res = await request(app).get("/api/integrations/nonexistent/ping");

    // Express's own default-router-miss behavior (no route matched at all,
    // as opposed to this router's deliberate INTEGRATION_INACTIVE 404) is
    // fine to assert here too — confirming this router calls next()/falls
    // through, which is app.ts's job to turn into the app-wide 404, not
    // this router's.
    assert.equal(res.status, 404);
    assert.equal(res.body.error?.code, undefined);
  });

  void it("re-calling applyActiveIntegrations with a different active set changes behavior on the next request", async () => {
    const alpha = makeIntegration("alpha", "system");
    const beta = makeIntegration("beta", "module");
    applyActiveIntegrations([alpha], [alpha, beta]);
    const app = buildTestApp();

    const before = await request(app).get("/api/integrations/beta/ping");
    assert.equal(before.status, 404);

    applyActiveIntegrations([beta], [alpha, beta]);

    const afterBeta = await request(app).get("/api/integrations/beta/ping");
    assert.equal(afterBeta.status, 200);
    assert.deepEqual(afterBeta.body, { id: "beta" });

    const afterAlpha = await request(app).get("/api/integrations/alpha/ping");
    assert.equal(afterAlpha.status, 404);
    assert.equal(afterAlpha.body.error.code, "INTEGRATION_INACTIVE");
  });
});
