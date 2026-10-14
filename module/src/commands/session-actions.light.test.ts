import assert from "node:assert/strict";
import test from "node:test";
import {
  readSessionAction,
  applySessionAction,
  executeCoreAction,
  readTokenLight,
} from "./session-actions.js";
const action = {
  kind: "token.light" as const,
  sceneId: "scene",
  targetId: "token",
  light: { bright: 10.12, dim: 20, color: "#ABCDEF", alpha: 0.8 },
};
function fixture() {
  const data: any = {
    light: {
      bright: 0,
      dim: 0,
      color: null,
      alpha: 0.5,
      angle: 90,
      animation: { type: "torch", speed: 3 },
    },
    x: 1,
    y: 2,
    sight: { enabled: true },
    detectionModes: [{ id: "basicSight" }],
    hidden: true,
    actorLink: true,
  };
  const calls: any[] = [];
  const token: any = {
    id: "token",
    toObject: () => structuredClone(data),
    update: async (p: any) => {
      calls.push(structuredClone(p));
      Object.assign(data, p);
      return token;
    },
  };
  const scene: any = {
    toObject: () => ({ active: true }),
    getEmbeddedCollection: () => new Map([["token", token]]),
  };
  const gm = { id: "gm", isGM: true, active: true };
  (globalThis as any).game = {
    world: { id: "world" },
    user: gm,
    users: new Map([["gm", gm]]),
    collections: new Map([["Scene", new Map([["scene", scene]])]]),
  };
  (globalThis as any).CONFIG = {
    Token: {
      documentClass: {
        schema: {
          fields: {
            light: {
              clean: (v: any) => ({
                ...v,
                bright: Math.round(v.bright * 100) / 100,
                color: v.color?.toLowerCase() ?? null,
              }),
              validate: (v: any) => (v.angle === -1 ? { invalid: true } : undefined),
            },
          },
        },
      },
    },
  };
  const input = { worldId: "world", requestingUserId: "gm", action };
  const core = (requestId: string) => ({
    worldId: "world",
    userId: "gm",
    requestId,
    correlationId: "corr",
    origin: "ai-dm" as const,
    schemaVersion: "core-actions-v1" as const,
    action,
  });
  return { data, calls, token, input, core };
}
// Node's test runner owns completion of these registered tests.
void test("native normalized light only updates light, preserves all other data and full light fields", async () => {
  const f = fixture(),
    original = structuredClone(f.data),
    before = readSessionAction(f.input);
  const result = await applySessionAction({
    ...f.input,
    expectedState: before.state,
    correlationId: "corr",
    idempotencyKey: "id",
  });
  assert.equal((result.state.light as any).bright, 10.12);
  assert.equal((result.state.light as any).color, "#abcdef");
  assert.deepEqual(Object.keys(f.calls[0]), ["light"]);
  assert.deepEqual({ ...f.data, light: original.light }, original);
  assert.equal(f.data.light.angle, 90);
  assert.deepEqual(f.data.light.animation, original.light.animation);
  assert.deepEqual(Object.keys(result.state), ["light"]);
});
void test("bounds, unknown fields and native rejection fail before updates", () => {
  for (const light of [
    { bright: 0, dim: Infinity },
    { bright: 0, dim: 10001 },
    { bright: 0, dim: 1, color: "red" },
    { bright: 0, dim: 1, alpha: 2 },
    { bright: 0, dim: 1, angle: 90 },
  ]) {
    const f = fixture();
    assert.throws(() => readSessionAction({ ...f.input, action: { ...action, light } as any }));
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  f.data.light.angle = -1;
  assert.throws(() => readSessionAction(f.input), /Native Token/);
});
void test("full light drift prevents dispatch", async () => {
  const f = fixture(),
    before = readSessionAction(f.input);
  f.data.light.animation.speed = 4;
  await assert.rejects(
    applySessionAction({
      ...f.input,
      expectedState: before.state,
      correlationId: "c",
      idempotencyKey: "i",
    }),
    /Stale/,
  );
  assert.equal(f.calls.length, 0);
});
void test("core deduplicates and normalized no-op avoids a second mutation", async () => {
  const f = fixture();
  const first = await executeCoreAction(f.core("one"));
  assert.equal(first.outcome, "confirmed");
  assert.equal(first.mutated, true);
  assert.deepEqual(await executeCoreAction(f.core("one")), first);
  assert.equal(f.calls.length, 1);
  const noop = await executeCoreAction(f.core("two"));
  assert.equal(noop.outcome, "confirmed");
  assert.equal(noop.mutated, false);
  assert.equal(f.calls.length, 1);
});
void test("mismatch or world change after mutation fences subsequent requests", async () => {
  for (const drift of ["readback", "world"]) {
    const f = fixture();
    f.token.update = async (p: any) => {
      f.calls.push(p);
      Object.assign(f.data, p);
      if (drift === "readback") f.data.light.dim = 999;
      else (globalThis as any).game.world.id = "other";
      return f.token;
    };
    assert.equal((await executeCoreAction(f.core("one"))).outcome, "uncertain");
    (globalThis as any).game.world.id = "world";
    assert.equal((await executeCoreAction(f.core("two"))).outcome, "failure");
    assert.equal(f.calls.length, 1);
  }
});

void test("partial patch preserves omitted radii and clear preserves rendering options", async () => {
  const f = fixture();
  f.data.light.bright = 10;
  f.data.light.dim = 20;
  const partial = { ...f.core("partial"), action: { ...action, light: { alpha: 0.2 } } };
  assert.equal((await executeCoreAction(partial)).outcome, "confirmed");
  assert.equal(f.data.light.bright, 10);
  assert.equal(f.data.light.dim, 20);
  assert.equal(
    (
      await executeCoreAction({
        ...f.core("clear"),
        action: { ...action, light: { bright: 0, dim: 0 } },
      })
    ).outcome,
    "confirmed",
  );
  assert.equal(f.data.light.angle, 90);
  assert.equal(f.data.light.alpha, 0.2);
});
void test("empty/subprecision patches fail before dispatch", async () => {
  for (const light of [{}, { dim: 0.001 }]) {
    const f = fixture();
    const result = await executeCoreAction({
      ...f.core("invalid"),
      action: { ...action, light } as any,
    });
    assert.equal(result.outcome, "failure");
    assert.equal(f.calls.length, 0);
  }
});
void test("native acknowledgement is required even when local readback matches", async () => {
  const f = fixture();
  f.token.update = async (p: any) => {
    f.calls.push(p);
    Object.assign(f.data, p);
    return undefined;
  };
  assert.equal((await executeCoreAction(f.core("no-ack"))).outcome, "uncertain");
  assert.equal((await executeCoreAction(f.core("after-no-ack"))).outcome, "failure");
  assert.equal(f.calls.length, 1);
});
void test("targeted read returns only emission and never touches token vision or prototypes", () => {
  const f = fixture();
  const r = readTokenLight({ worldId: "world", userId: "gm", sceneId: "scene", tokenId: "token" });
  assert.deepEqual(r.light, f.data.light);
  assert.equal(r.scope, "placed-token");
  assert.equal(f.calls.length, 0);
  assert.throws(
    () => readTokenLight({ worldId: "world", userId: "gm", sceneId: "scene", tokenId: "actor-id" }),
    /missing/,
  );
  f.data.light.animation.type = "x".repeat(9000);
  assert.throws(
    () => readTokenLight({ worldId: "world", userId: "gm", sceneId: "scene", tokenId: "token" }),
    /budget/,
  );
});

void test("bright-only emission and partial alpha patch use independent native radii", async () => {
  const f = fixture();
  const bright = await executeCoreAction({
    ...f.core("bright-only"),
    action: { ...action, light: { bright: 20, dim: 0 } },
  });
  assert.equal(bright.outcome, "confirmed");
  assert.equal(f.data.light.bright, 20);
  assert.equal(f.data.light.dim, 0);
  const partial = await executeCoreAction({
    ...f.core("bright-alpha"),
    action: { ...action, light: { alpha: 0.2 } },
  });
  assert.equal(partial.outcome, "confirmed");
  assert.equal(f.data.light.bright, 20);
  assert.equal(f.data.light.dim, 0);
  assert.equal(f.data.light.alpha, 0.2);
});

void test("oversized preserved light state fails before native update and receipts remain bounded", async () => {
  const f = fixture();
  f.data.light.animation.type = "x".repeat(9000);
  const result = await executeCoreAction(f.core("oversized-before"));
  assert.equal(result.outcome, "failure");
  assert.equal(result.state, null);
  assert.equal(f.calls.length, 0);
  assert.throws(() => readSessionAction(f.input), /budget/);
});
void test("native normalization or post-update light growth cannot confirm an oversized receipt", async () => {
  for (const stage of ["normalize", "readback"]) {
    const f = fixture();
    if (stage === "normalize")
      (globalThis as any).CONFIG.Token.documentClass.schema.fields.light.clean = (v: any) => ({
        ...v,
        animation: { type: "x".repeat(9000) },
      });
    else
      f.token.update = async (p: any) => {
        f.calls.push(p);
        Object.assign(f.data, p);
        f.data.light.animation.type = "x".repeat(9000);
        return f.token;
      };
    const result = await executeCoreAction(f.core("oversized-" + stage));
    assert.equal(result.outcome, stage === "normalize" ? "failure" : "uncertain");
    assert.equal(result.state, null);
    assert.equal(f.calls.length, stage === "normalize" ? 0 : 1);
  }
});
