import assert from "node:assert/strict";
import test from "node:test";
import { readGmScene, applyGmScene } from "./gm-scene.js";
import { inspectGmReceipt } from "./gm-receipts.js";
import type { NativeGmApplyInput, NativeGmInput } from "@foundry-local-api/shared";
type Obj = Record<string, any>;
class Doc {
  object?: { constrainMovementPath(path: unknown, options: unknown): unknown };
  async move(destination: Obj, options: Obj) {
    this.data.x = destination.x;
    this.data.y = destination.y;
    this.data.lastMove = { destination, options };
    return true;
  }
  children = new Map<string, Doc>();
  constructor(
    readonly id: string,
    readonly data: Obj,
  ) {}
  toObject() {
    return structuredClone(this.data);
  }
  getEmbeddedCollection() {
    return this.children;
  }
  async update(patch: Obj) {
    for (const [key, value] of Object.entries(patch)) {
      const bits = key.split(".");
      let target = this.data;
      for (const bit of bits.slice(0, -1)) target = target[bit] ??= {};
      target[bits.at(-1)!] = structuredClone(value);
    }
    return this;
  }
}
function fixture() {
  const gm = { id: "gm", isGM: true, active: true };
  const scene = new Doc("scene", { active: true });
  const token = new Doc("token", { x: 1, y: 2, elevation: 0 });
  scene.children.set(token.id, token);
  const journal = new Doc("journal", {
    ownership: { default: 0 },
    flags: { "foundry-local-api": { nativeGmVersion: "gm-actions-v1", nativeGmReceipts: {} } },
  });
  const time = {
    worldTime: 100,
    advances: 0,
    async advance(seconds: number) {
      this.advances++;
      this.worldTime += seconds;
      return this.worldTime;
    },
  };
  Object.assign(globalThis, {
    CONFIG: {
      Token: {
        movement: {
          actions: { walk: { walls: "move", teleport: false }, displace: { teleport: true } },
        },
      },
    },
    game: {
      world: { id: "world" },
      release: { version: "14.368" },
      system: { id: "dnd5e", version: "6.0.3" },
      user: gm,
      users: new Map([[gm.id, gm]]),
      time,
      collections: new Map([
        ["Scene", new Map([[scene.id, scene]])],
        ["JournalEntry", new Map([[journal.id, journal]])],
      ]),
    },
    canvas: { scene },
  });
  const scope: NativeGmInput = {
    schemaVersion: "gm-actions-v1",
    worldId: "world",
    userId: "gm",
    sceneId: "scene",
    action: {
      kind: "world-time.advance",
      seconds: 600,
      decision: "GM chooses ten minutes of travel",
    },
  };
  const input: NativeGmApplyInput = {
    ...scope,
    expectedState: readGmScene(scope),
    idempotencyKey: "travel",
    correlationId: "travel",
  };
  return { input, time, token, journal };
}
void test("world travel uses native time once with durable exact replay and receipt lookup", async () => {
  const { input, time } = fixture();
  const result = await applyGmScene(input);
  assert.equal(result.outcome, "confirmed");
  assert.deepEqual(await applyGmScene(input), result);
  assert.equal(time.advances, 1);
  assert.equal(time.worldTime, 700);
  const inspected = inspectGmReceipt({
    ...input,
    action: { kind: "receipt", idempotencyKey: "travel" },
  });
  assert.equal(inspected.status, "terminal");
  assert.deepEqual(inspected.receipt, result);
});
void test("scoped walking uses native collision preflight and verified constrained movement", async () => {
  const { input, token } = fixture();
  let preflights = 0;
  token.object = {
    constrainMovementPath: (_path, options) => {
      preflights++;
      assert.deepEqual(options, { ignoreWalls: false, ignoreCost: false });
      return [[], false];
    },
  };
  input.action = {
    kind: "token.move",
    tokenId: "token",
    x: 11,
    y: 12,
    mode: "walk",
    movementCost: 5,
    ruling: "GM confirms five scene units and no opportunity trigger",
  };
  input.expectedState = readGmScene(input);
  const result = await applyGmScene(input);
  assert.equal(result.outcome, "confirmed");
  assert.equal(preflights, 2);
  assert.equal(token.data.x, 11);
  assert.equal(token.data.lastMove.destination.action, "walk");
  assert.deepEqual(token.data.lastMove.options.constrainOptions, {
    ignoreWalls: false,
    ignoreCost: false,
  });
  await applyGmScene(input);
  assert.equal(preflights, 2);
});
void test("native wall refusal stops before reservation and stopped movement remains uncertain", async () => {
  let setup = fixture();
  setup.token.object = { constrainMovementPath: () => [[], true] };
  setup.input.action = {
    kind: "token.move",
    tokenId: "token",
    x: 11,
    y: 12,
    mode: "walk",
    movementCost: 5,
    ruling: "Explicit movement choice",
  };
  setup.input.expectedState = readGmScene(setup.input);
  assert.equal((await applyGmScene(setup.input)).outcome, "failure");
  assert.equal(setup.token.data.x, 1);
  assert.deepEqual(setup.journal.data.flags["foundry-local-api"].nativeGmReceipts, {});
  setup = fixture();
  setup.token.object = { constrainMovementPath: () => [[], false] };
  setup.token.move = async () => {
    setup.token.data.x = 8;
    return false;
  };
  setup.input.action = {
    kind: "token.move",
    tokenId: "token",
    x: 11,
    y: 12,
    mode: "walk",
    movementCost: 5,
    ruling: "Explicit movement choice",
  };
  setup.input.expectedState = readGmScene(setup.input);
  assert.equal((await applyGmScene(setup.input)).outcome, "uncertain");
  assert.equal(setup.token.data.x, 8);
});
void test("elevation updates exact placed token and expected scene state, no falling arithmetic", async () => {
  const { input, token } = fixture();
  input.action = {
    kind: "token.elevation",
    tokenId: "token",
    elevation: 15,
    decision: "Explicit native flying height",
  };
  input.expectedState = readGmScene(input);
  const result = await applyGmScene(input);
  assert.equal(result.outcome, "confirmed");
  assert.equal(token.data.elevation, 15);
  assert.equal(token.data.x, 1);
});
void test("stale time, wrong actor and private journal checks refuse native travel", async () => {
  const { input, time, journal } = fixture();
  time.worldTime++;
  await assert.rejects(applyGmScene(input), /state changed/);
  assert.equal(time.advances, 0);
  journal.data.ownership.player = 2;
  assert.throws(
    () => inspectGmReceipt({ ...input, action: { kind: "receipt", idempotencyKey: "travel" } }),
    /privacy/,
  );
});
void test("native time veto remains uncertain across restart and never advances again", async () => {
  const { input, time, journal } = fixture();
  time.advance = async function (seconds: number) {
    this.advances++;
    this.worldTime += seconds;
    throw Error("lost acknowledgement");
  };
  assert.equal((await applyGmScene(input)).outcome, "uncertain");
  const entries = structuredClone(journal.data.flags["foundry-local-api"].nativeGmReceipts);
  const restarted = fixture();
  restarted.journal.data.flags["foundry-local-api"].nativeGmReceipts = entries;
  await assert.rejects(
    applyGmScene({ ...restarted.input, idempotencyKey: "new-travel" }),
    /uncertain/,
  );
  assert.equal(restarted.time.advances, 0);
});
void test("journal-only recipe reservation persists exact evidence without gameplay and survives a native session restart", async () => {
  const { input, time, token } = fixture();
  input.action = {
    kind: "recipe.reservation",
    recipeId: "native-document-preparation",
    requestFingerprint: "a".repeat(64),
  };
  input.idempotencyKey = "specialized-reservation";
  input.expectedState = readGmScene(input);
  const result = await applyGmScene(input);
  assert.equal(result.outcome, "confirmed");
  assert.equal((result.data as Record<string, unknown>).reservationOnly, true);
  assert.equal(time.advances, 0);
  assert.deepEqual(token.toObject(), { x: 1, y: 2, elevation: 0 });
  const session = (globalThis as Obj).game;
  (globalThis as Obj).game = { ...session };
  const duplicate = await applyGmScene(input);
  assert.equal(duplicate.outcome, "failure");
  assert.equal((duplicate.data as Record<string, unknown>).reservationAlreadyExists, true);
  const retained = inspectGmReceipt({
    ...input,
    action: { kind: "receipt", idempotencyKey: input.idempotencyKey },
  });
  assert.equal(retained.status, "terminal");
  assert.deepEqual(retained.receipt, result);
  assert.equal(time.advances, 0);
  await assert.rejects(() =>
    applyGmScene({ ...input, action: { ...input.action, requestFingerprint: "b".repeat(64) } }),
  );
});
void test("concurrent recipe marker requests admit exactly one caller", async () => {
  const { input } = fixture();
  input.action = {
    kind: "recipe.reservation",
    recipeId: "tv-camera-vision",
    requestFingerprint: "c".repeat(64),
  };
  input.idempotencyKey = "concurrent-marker";
  input.expectedState = readGmScene(input);
  const results = await Promise.all([applyGmScene(input), applyGmScene(input)]);
  assert.equal(results.filter((r) => r.outcome === "confirmed").length, 1);
  assert.equal(
    results.filter(
      (r) =>
        r.outcome === "failure" &&
        (r.data as Record<string, unknown>).reservationAlreadyExists === true,
    ).length,
    1,
  );
  assert.equal(
    (
      inspectGmReceipt({
        ...input,
        action: { kind: "receipt", idempotencyKey: input.idempotencyKey },
      }).receipt as { outcome?: string } | undefined
    )?.outcome,
    "confirmed",
  );
});
void test("recipe reservation rejects unknown fields and missing request identity before journal writes", () => {
  const { input, journal } = fixture();
  for (const action of [
    { kind: "recipe.reservation", recipeId: "tv-camera-vision" },
    {
      kind: "recipe.reservation",
      recipeId: "tv-camera-vision",
      requestFingerprint: "a".repeat(64),
      camera: { x: 1, y: 2 },
    },
  ])
    assert.throws(() => readGmScene({ ...input, action }));
  assert.deepEqual(journal.data.flags["foundry-local-api"].nativeGmReceipts, {});
});
