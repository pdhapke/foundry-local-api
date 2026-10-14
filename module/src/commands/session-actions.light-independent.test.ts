import assert from "node:assert/strict";
import test from "node:test";
import { executeCoreAction } from "./session-actions.js";
function fixture() {
  const light: any = {
    bright: 0,
    dim: 0,
    color: null,
    alpha: 0.5,
    angle: 270,
    animation: { type: "torch", speed: 2 },
  };
  let writes = 0;
  const token: any = {
    toObject: () => ({ light: structuredClone(light) }),
    update: async (p: any) => {
      writes++;
      Object.assign(light, p.light);
      return token;
    },
  };
  const gm = { id: "gm", isGM: true, active: true };
  (globalThis as any).game = {
    world: { id: "world" },
    user: gm,
    users: new Map([["gm", gm]]),
    collections: new Map([
      [
        "Scene",
        new Map([
          [
            "scene",
            {
              toObject: () => ({ active: true }),
              getEmbeddedCollection: () => new Map([["token", token]]),
            },
          ],
        ]),
      ],
    ]),
  };
  (globalThis as any).CONFIG = {
    Token: {
      documentClass: {
        schema: {
          fields: { light: { clean: (v: any) => structuredClone(v), validate: () => undefined } },
        },
      },
    },
  };
  const input: any = {
    worldId: "world",
    userId: "gm",
    requestId: "independent",
    correlationId: "c",
    origin: "ai-dm",
    schemaVersion: "core-actions-v1",
    action: {
      kind: "token.light",
      sceneId: "scene",
      targetId: "token",
      light: { bright: 10, dim: 20 },
    },
  };
  return { light, token, input, writes: () => writes };
}
// Node's test runner owns completion of these registered tests.
void test("independent light gate rejects revoked native GM authority before mutation", async () => {
  const f = fixture();
  (globalThis as any).game.user.isGM = false;
  assert.equal((await executeCoreAction(f.input)).outcome, "failure");
  assert.equal(f.writes(), 0);
});
void test("independent light gate detects nested preserved-field readback drift", async () => {
  const f = fixture();
  f.token.update = async (p: any) => {
    Object.assign(f.light, p.light);
    f.light.animation.speed = 9;
    return f.token;
  };
  assert.equal((await executeCoreAction(f.input)).outcome, "uncertain");
});
void test("independent light gate fails closed without native validation API", async () => {
  const f = fixture();
  delete (globalThis as any).CONFIG.Token.documentClass.schema.fields.light.validate;
  assert.equal((await executeCoreAction(f.input)).outcome, "failure");
  assert.equal(f.writes(), 0);
});
