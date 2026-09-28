import assert from "node:assert/strict";
import { describe, it } from "node:test";

import express from "express";
import request, { type Test } from "supertest";

import { TRAILS_COMMANDS } from "@foundry-local-api/shared";

// Deliberately evaluate app.ts before the endpoint registry. This preserves
// the same circular-import workaround used by the other integration route
// tests (registry -> endpoints -> events -> app -> routes -> registry).
import { HttpError } from "../../app.js";
import type { FoundryClient } from "../../bridge/foundry-client.js";
import { mountRestEndpoints } from "../../endpoints/registry.js";
import { trailsEndpointDescriptors } from "./endpoints.js";

interface BridgeCall {
  command: string;
  payload: unknown;
}

function buildTestApp(calls: BridgeCall[], result: unknown = { bridged: true }): express.Express {
  const app = express();
  app.use(express.json({ limit: "3mb" }));
  const router = express.Router();
  mountRestEndpoints(router, trailsEndpointDescriptors);
  app.use(router);
  app.locals["foundryClient"] = {
    call(command: string, payload?: unknown) {
      calls.push({ command, payload });
      return Promise.resolve(result);
    },
  } as unknown as FoundryClient;
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const status = err instanceof HttpError ? err.status : 500;
      const code = err instanceof HttpError ? err.code : undefined;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: { message, ...(code ? { code } : {}) } });
    },
  );
  return app;
}

const citation = {
  chapter: 3,
  printedPages: [10, 11],
  sections: ["Core", "Actions"],
  entry: "Test entry",
};

const actionInput = {
  kind: "skill",
  abilityId: "agility",
  skillId: "stealth",
  abilityDice: 2,
  skillDice: 3,
  otherDice: 1,
  abilityChallenges: 1,
  challenges: 2,
  chances: 1,
  charges: 2,
  vs: 17,
  conditionalDice: [
    { id: "darkness", label: "Darkness", selected: true, dice: 2, source: citation },
    { id: "high-ground", label: "High ground", selected: false, dice: 1, source: null },
  ],
};

const initiativeInput = {
  participants: [
    {
      id: "actor-a",
      label: "Estelle",
      bonusDice: 2,
      challenges: 1,
      charges: 1,
      chances: 0,
      sources: [citation],
    },
    {
      id: "actor-b",
      bonusDice: 0,
      challenges: 0,
      charges: 0,
      sources: [],
    },
  ],
};

const resources = {
  durability: { value: 3, max: 8 },
  health: { value: 7, max: 10 },
  vigor: { value: 2, max: 6 },
  mana: { value: 1, max: 5 },
  energy: { value: 4, max: 4 },
};

const eligibility = {
  durability: true,
  health: true,
  vigor: false,
  mana: true,
  energy: false,
};

const recoveryInput = {
  kind: "sleep",
  resources,
  stamina: 4,
  staminaBonusDice: 2,
  soulBonusDice: 1,
  staminaDice: [7, 9],
  soulDice: [6],
  eligibility,
};

type RequestFactory = (app: express.Express) => Test;

interface HappyRoute {
  name: string;
  request: RequestFactory;
  command: string;
  payload: unknown;
}

const happyRoutes: HappyRoute[] = [
  {
    name: "GET /trails-of-destiny/config",
    request: (app) => request(app).get("/trails-of-destiny/config"),
    command: TRAILS_COMMANDS.CONFIG,
    payload: undefined,
  },
  {
    name: "GET /trails-of-destiny/actors/:id/sheet",
    request: (app) => request(app).get("/trails-of-destiny/actors/actor-1/sheet"),
    command: TRAILS_COMMANDS.ACTOR_SHEET,
    payload: { id: "actor-1" },
  },
  {
    name: "GET /trails-of-destiny/actors/:id/inventory",
    request: (app) => request(app).get("/trails-of-destiny/actors/actor-2/inventory"),
    command: TRAILS_COMMANDS.ACTOR_INVENTORY,
    payload: { id: "actor-2" },
  },
  {
    name: "GET /trails-of-destiny/catalogs",
    request: (app) => request(app).get("/trails-of-destiny/catalogs"),
    command: TRAILS_COMMANDS.LIST_CATALOGS,
    payload: undefined,
  },
  {
    name: "GET /trails-of-destiny/catalogs/:packId",
    request: (app) =>
      request(app).get("/trails-of-destiny/catalogs/trails-of-destiny.character-options"),
    command: TRAILS_COMMANDS.GET_CATALOG,
    payload: { packId: "trails-of-destiny.character-options" },
  },
  {
    name: "GET /trails-of-destiny/actors/:id/creation-readiness",
    request: (app) => request(app).get("/trails-of-destiny/actors/actor-3/creation-readiness"),
    command: TRAILS_COMMANDS.EVALUATE_CREATION,
    payload: { id: "actor-3" },
  },
  {
    name: "POST /trails-of-destiny/rolls/action",
    request: (app) => request(app).post("/trails-of-destiny/rolls/action").send(actionInput),
    command: TRAILS_COMMANDS.ROLL_ACTION,
    payload: actionInput,
  },
  {
    name: "POST /trails-of-destiny/previews/initiative",
    request: (app) =>
      request(app).post("/trails-of-destiny/previews/initiative").send(initiativeInput),
    command: TRAILS_COMMANDS.PREVIEW_INITIATIVE,
    payload: initiativeInput,
  },
  {
    name: "POST /trails-of-destiny/previews/threat-contest",
    request: (app) =>
      request(app).post("/trails-of-destiny/previews/threat-contest").send({
        classification: "assault",
        actionTotal: 18,
        passiveDefense: 14,
        reactionTotal: 19,
      }),
    command: TRAILS_COMMANDS.PREVIEW_THREAT_CONTEST,
    payload: {
      classification: "assault",
      actionTotal: 18,
      passiveDefense: 14,
      reactionTotal: 19,
    },
  },
  {
    name: "POST /trails-of-destiny/previews/damage",
    request: (app) =>
      request(app).post("/trails-of-destiny/previews/damage").send({
        durability: 5,
        health: 9,
        damage: 7,
        lifeState: "active",
      }),
    command: TRAILS_COMMANDS.PREVIEW_DAMAGE,
    payload: { durability: 5, health: 9, damage: 7, lifeState: "active" },
  },
  {
    name: "POST /trails-of-destiny/previews/recovery",
    request: (app) => request(app).post("/trails-of-destiny/previews/recovery").send(recoveryInput),
    command: TRAILS_COMMANDS.PREVIEW_RECOVERY,
    payload: recoveryInput,
  },
  {
    name: "GET /trails-of-destiny/experience/:totalExperience",
    request: (app) => request(app).get("/trails-of-destiny/experience/12345"),
    command: TRAILS_COMMANDS.EXPERIENCE_PROGRESS,
    // This also proves that the GET path parameter is merged and coerced by
    // the shared schema before reaching the bridge.
    payload: { totalExperience: 12345 },
  },
  {
    name: "POST /trails-of-destiny/builder/preview",
    request: (app) =>
      request(app)
        .post("/trails-of-destiny/builder/preview")
        .send({ raw: '{"version":1,"actor":{"name":"Estelle"}}' }),
    command: TRAILS_COMMANDS.PREVIEW_BUILDER,
    payload: { raw: '{"version":1,"actor":{"name":"Estelle"}}' },
  },
];

interface InvalidRoute {
  name: string;
  request: RequestFactory;
}

const invalidRoutes: InvalidRoute[] = [
  {
    name: "rejects a blank actor id",
    request: (app) => request(app).get("/trails-of-destiny/actors/%20/sheet"),
  },
  {
    name: "rejects an overlong actor id",
    request: (app) => request(app).get(`/trails-of-destiny/actors/${"a".repeat(257)}/inventory`),
  },
  {
    name: "rejects a catalog outside the allowlist",
    request: (app) => request(app).get("/trails-of-destiny/catalogs/world.private-pack"),
  },
  {
    name: "rejects an invalid action kind",
    request: (app) =>
      request(app)
        .post("/trails-of-destiny/rolls/action")
        .send({ ...actionInput, kind: "attack" }),
  },
  {
    name: "rejects an action pool above its aggregate bound",
    request: (app) =>
      request(app)
        .post("/trails-of-destiny/rolls/action")
        .send({ ...actionInput, abilityDice: 99, skillDice: 2 }),
  },
  {
    name: "rejects duplicate initiative participant ids",
    request: (app) =>
      request(app)
        .post("/trails-of-destiny/previews/initiative")
        .send({
          participants: [initiativeInput.participants[0], initiativeInput.participants[0]],
        }),
  },
  {
    name: "rejects initiative Chances",
    request: (app) =>
      request(app)
        .post("/trails-of-destiny/previews/initiative")
        .send({ participants: [{ ...initiativeInput.participants[0], chances: 1 }] }),
  },
  {
    name: "rejects an invalid threat classification",
    request: (app) =>
      request(app).post("/trails-of-destiny/previews/threat-contest").send({
        classification: "ambush",
        actionTotal: 1,
        passiveDefense: 1,
      }),
  },
  {
    name: "rejects negative threat totals",
    request: (app) =>
      request(app).post("/trails-of-destiny/previews/threat-contest").send({
        classification: "attack",
        actionTotal: -1,
        passiveDefense: 1,
      }),
  },
  {
    name: "rejects an invalid damage life state",
    request: (app) =>
      request(app).post("/trails-of-destiny/previews/damage").send({
        durability: 1,
        health: 1,
        damage: 1,
        lifeState: "unconscious",
      }),
  },
  {
    name: "rejects a negative damage value",
    request: (app) =>
      request(app)
        .post("/trails-of-destiny/previews/damage")
        .send({ durability: 1, health: 1, damage: -1 }),
  },
  {
    name: "rejects a malformed nested recovery resource",
    request: (app) =>
      request(app)
        .post("/trails-of-destiny/previews/recovery")
        .send({ ...recoveryInput, resources: { ...resources, health: 7 } }),
  },
  {
    name: "rejects recorded recovery dice whose count does not match the declared pool",
    request: (app) =>
      request(app)
        .post("/trails-of-destiny/previews/recovery")
        .send({ ...recoveryInput, staminaBonusDice: 2, staminaDice: [8] }),
  },
  {
    name: "rejects Soul dice for a break",
    request: (app) =>
      request(app)
        .post("/trails-of-destiny/previews/recovery")
        .send({ ...recoveryInput, kind: "break", soulBonusDice: 1, soulDice: [5] }),
  },
  {
    name: "rejects negative experience",
    request: (app) => request(app).get("/trails-of-destiny/experience/-1"),
  },
  {
    name: "rejects non-numeric experience",
    request: (app) => request(app).get("/trails-of-destiny/experience/not-a-number"),
  },
  {
    name: "rejects a non-string builder body",
    request: (app) =>
      request(app)
        .post("/trails-of-destiny/builder/preview")
        .send({ raw: { version: 1 } }),
  },
];

void describe("Trails of Destiny integration REST descriptors", () => {
  for (const route of happyRoutes) {
    void it(`${route.name} calls the exact bridge command and payload`, async () => {
      const calls: BridgeCall[] = [];
      const result = { route: route.name, nested: { preserved: true } };
      const app = buildTestApp(calls, result);

      const response = await route.request(app);

      assert.equal(response.status, 200);
      assert.deepEqual(response.body, result);
      assert.deepEqual(calls, [{ command: route.command, payload: route.payload }]);
    });
  }

  void it("keeps POST object and list inputs in their named body fields", async () => {
    const calls: BridgeCall[] = [];
    const app = buildTestApp(calls);

    await request(app)
      .post("/trails-of-destiny/previews/initiative")
      .send(initiativeInput)
      .expect(200);
    await request(app).post("/trails-of-destiny/previews/recovery").send(recoveryInput).expect(200);

    assert.deepEqual(calls, [
      { command: TRAILS_COMMANDS.PREVIEW_INITIATIVE, payload: initiativeInput },
      { command: TRAILS_COMMANDS.PREVIEW_RECOVERY, payload: recoveryInput },
    ]);
    assert.ok(Array.isArray((calls[0]?.payload as { participants: unknown[] }).participants));
    assert.deepEqual(
      (calls[1]?.payload as { resources: unknown }).resources,
      resources,
      "the resources object must not be flattened into top-level fields",
    );
  });

  for (const route of invalidRoutes) {
    void it(route.name, async () => {
      const calls: BridgeCall[] = [];
      const response = await route.request(buildTestApp(calls));

      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, "VALIDATION_ERROR");
      assert.equal(calls.length, 0, "invalid input must not reach Foundry");
    });
  }
});
