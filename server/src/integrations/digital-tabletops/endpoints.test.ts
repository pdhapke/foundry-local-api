// Phase 52 — unit tests for the digital-tabletops integration's REST
// descriptors, mirroring server/src/integrations/dnd5e/endpoints.test.ts's
// harness exactly: mounts `dttEndpointDescriptors` directly via
// `mountRestEndpoints` on a bare Express app with a fake `FoundryClient`, one
// happy-path test per route, asserting the exact bridge command name + input
// each route calls with and that the handler's result passes through
// untouched.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import express from "express";
import request from "supertest";

import type { DttAckResult, DttPanInput, DttStatusResult } from "@foundry-local-api/shared";

// Side-effect-only import, and deliberately first: same pre-existing
// circular-import workaround dnd5e/endpoints.test.ts documents
// (endpoints/index.ts -> events.ts -> app.js -> routes/api.ts ->
// endpoints/index.ts). Without forcing `../../app.js` to evaluate first,
// `registerRestRoute` blows up at runtime (`__name is not a function`)
// because `../../endpoints/registry.js` hasn't finished initializing yet.
import "../../app.js";
import type { FoundryClient } from "../../bridge/foundry-client.js";
import { mountRestEndpoints } from "../../endpoints/registry.js";
import { dttEndpointDescriptors } from "./endpoints.js";

function buildTestApp(call: FoundryClient["call"]): express.Express {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  mountRestEndpoints(router, dttEndpointDescriptors);
  app.use(router);
  app.locals["foundryClient"] = { call } as unknown as FoundryClient;
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: { message: (err as Error).message } });
    },
  );
  return app;
}

const ACK_FIXTURE: DttAckResult = { acknowledged: true };

const STATUS_FIXTURE: DttStatusResult = {
  moduleActive: true,
  tvUser: { found: true, active: true, name: "TV" },
  settings: { hideUI: true, lockPan: true, displayWidth: 955, portNumber: 50000 },
};

void describe("digital-tabletops integration endpoints", () => {
  void it("POST /digital-tabletops/pan calls PAN with the request body and returns its result untouched", async () => {
    const app = buildTestApp(((type: string, payload: DttPanInput) => {
      assert.equal(type, "dttPan");
      assert.deepEqual(payload, { x: 100, y: 200, targetWidth: 40, targetHeight: 30 });
      return Promise.resolve(ACK_FIXTURE);
    }) as FoundryClient["call"]);

    const res = await request(app)
      .post("/digital-tabletops/pan")
      .send({ x: 100, y: 200, targetWidth: 40, targetHeight: 30 });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, ACK_FIXTURE);
  });

  void it("POST /digital-tabletops/pan omits targetWidth/targetHeight when not given", async () => {
    const app = buildTestApp(((type: string, payload: DttPanInput) => {
      assert.equal(type, "dttPan");
      assert.deepEqual(payload, { x: 5, y: 10 });
      return Promise.resolve(ACK_FIXTURE);
    }) as FoundryClient["call"]);

    const res = await request(app).post("/digital-tabletops/pan").send({ x: 5, y: 10 });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, ACK_FIXTURE);
  });

  void it("POST /digital-tabletops/scale-to-physical calls SCALE_TO_PHYSICAL with no input and returns its result untouched", async () => {
    const app = buildTestApp(((type: string, payload: unknown) => {
      assert.equal(type, "dttScaleToPhysical");
      assert.equal(payload, undefined);
      return Promise.resolve(ACK_FIXTURE);
    }) as FoundryClient["call"]);

    const res = await request(app).post("/digital-tabletops/scale-to-physical").send({});

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, ACK_FIXTURE);
  });

  void it("POST /digital-tabletops/mirror-gm-view calls MIRROR_GM_VIEW with no input and returns its result untouched", async () => {
    const app = buildTestApp(((type: string, payload: unknown) => {
      assert.equal(type, "dttMirrorGmView");
      assert.equal(payload, undefined);
      return Promise.resolve(ACK_FIXTURE);
    }) as FoundryClient["call"]);

    const res = await request(app).post("/digital-tabletops/mirror-gm-view").send({});

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, ACK_FIXTURE);
  });

  void it("GET /digital-tabletops/status calls GET_STATUS and returns its result untouched", async () => {
    const app = buildTestApp(((type: string, payload: unknown) => {
      assert.equal(type, "dttGetStatus");
      assert.equal(payload, undefined);
      return Promise.resolve(STATUS_FIXTURE);
    }) as FoundryClient["call"]);

    const res = await request(app).get("/digital-tabletops/status");

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, STATUS_FIXTURE);
  });
});
