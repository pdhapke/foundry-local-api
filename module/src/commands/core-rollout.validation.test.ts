import assert from "node:assert/strict";
import test from "node:test";
import { applySessionAction, readSessionAction, executeCoreAction } from "./session-actions.js";
import type { CoreActionInput } from "@foundry-local-api/shared";

function fixture() {
  const gm = { id: "gm", active: true, isGM: true };
  const actor = { id: "actor", toObject: () => ({ system: { attributes: { hp: { value: 7, max: 10 } } } }) };
  const wallData = { door: 1, ds: 0 };
  let writes = 0;
  const wall = { id: "door", toObject: () => ({ ...wallData }), update: async (data: Record<string, unknown>) => { writes++; wallData.ds = Number(data["ds"]); } };
  const tokens = new Map<string, { actor: typeof actor }>([["token", { actor }]]);
  const walls = new Map([["door", wall]]);
  const scene = { toObject: () => ({ active: true, width: 100, height: 100 }), getEmbeddedCollection: (name: string) => name === "Token" ? tokens : walls };
  Object.assign(globalThis, { game: { world: { id: "w" }, user: gm, users: new Map([["gm", gm]]), system: { id: "dnd5e" }, collections: new Map([["Scene", new Map([["scene", scene]])]]) } });
  const input = { worldId: "w", requestingUserId: "gm", action: { kind: "door.state" as const, sceneId: "scene", targetId: "door", value: 1 as const } };
  return { gm, actor, wallData, walls, tokens, input, get writes() { return writes; } };
}

void test("independent current-world live authority and deleted targets fail before writes", async () => {
  const f = fixture();
  assert.throws(() => readSessionAction({ ...f.input, worldId: "other" }));
  f.gm.isGM = false;
  assert.throws(() => readSessionAction(f.input));
  f.gm.isGM = true;
  const expectedState = readSessionAction(f.input).state;
  f.walls.delete("door");
  await assert.rejects(applySessionAction({ ...f.input, expectedState, correlationId: "origin", idempotencyKey: "id" }));
  assert.equal(f.writes, 0);
});

void test("independent stale optimistic state cannot overwrite a newer door state", async () => {
  const f = fixture();
  const expectedState = readSessionAction(f.input).state;
  f.wallData.ds = 2;
  await assert.rejects(applySessionAction({ ...f.input, expectedState, correlationId: "origin", idempotencyKey: "id" }), /Stale/);
  assert.equal(f.writes, 0);
  assert.equal(f.wallData.ds, 2);
});

void test("independent ambiguous synthetic actor identity is rejected rather than guessed", () => {
  const f = fixture();
  f.tokens.set("other", { actor: { ...f.actor } });
  assert.throws(() => readSessionAction({ worldId: "w", requestingUserId: "gm", action: { kind: "actor.hp", sceneId: "scene", targetId: "actor", value: 5 } }), /Ambiguous/);
});

const rollInput = (id: string): CoreActionInput => ({ worldId: "w", userId: "gm", requestId: id, correlationId: id, schemaVersion: "core-actions-v1", origin: "ai-dm", action: { kind: "system.roll", sceneId: "scene", targetId: "actor", rollType: "skill", key: "prc" } });
void test("independent configured system roll executes once with no dialog/message and rejects unknown key", async () => {
  const f = fixture(); let rolls = 0;
  Object.assign(globalThis, { CONFIG: { DND5E: { skills: { prc: {} }, abilities: { dex: {} } } } });
  Object.assign(f.actor, { rollSkill: async (...args: unknown[]) => {
    rolls++;
    assert.deepEqual(args[0], { skill: "prc" });
    assert.deepEqual(args[1], { configure: false });
    assert.equal((args[2] as { create: boolean }).create, false);
    return [{ total: 17, formula: "1d20+3", result: "14 + 3" }];
  } });
  const input = rollInput("roll");
  assert.equal((await executeCoreAction(input)).outcome, "confirmed");
  assert.equal((await executeCoreAction(input)).outcome, "confirmed");
  assert.equal(rolls, 1);
  assert.equal((await executeCoreAction({ ...rollInput("unknown"), action: { kind: "system.roll", sceneId: "scene", targetId: "actor", rollType: "skill", key: "__proto__" } })).outcome, "failure");
  assert.equal(rolls, 1);
});
void test("independent system roll lost result is uncertain and never falls back or rerolls", async () => {
  const f = fixture(); let rolls = 0;
  Object.assign(globalThis, { CONFIG: { DND5E: { skills: { prc: {} } } } });
  Object.assign(f.actor, { rollSkill: async () => { rolls++; throw new Error("lost acknowledgement"); }, rollAbilityTest: () => assert.fail("fallback reroll") });
  assert.equal((await executeCoreAction(rollInput("uncertain-roll"))).outcome, "uncertain");
  assert.equal((await executeCoreAction(rollInput("uncertain-roll"))).outcome, "uncertain");
  assert.equal((await executeCoreAction(rollInput("different-roll"))).outcome, "failure");
  assert.equal(rolls, 1);
});

void test("independent supported combat lifecycle owns defeated-skip/round outcome and retains time/options/origin", async () => {
  for (const [event, next] of [["combatTurn", { round: 1, turn: 2 }], ["combatRound", { round: 2, turn: 0 }]] as const) {
    fixture();
    const handlers = new Map<string, (...args: unknown[]) => void>();
    let advances = 0;
    const data = { active: true, scene: "scene", round: 1, turn: 0 };
    const updateOptions: Record<string, unknown> = { direction: 1, worldTime: { delta: 6 } };
    const combat = { id: "combat", turns: [{}, {}, {}], toObject: () => ({ ...data }), nextTurn: async () => {
      advances++;
      handlers.get(event)?.(combat, next, updateOptions);
      Object.assign(data, next);
    } };
    const world = (globalThis as unknown as { game: { collections: Map<string, Map<string, unknown>> } }).game;
    world.collections.set("Combat", new Map([["combat", combat]]));
    Object.assign(globalThis, { Hooks: { on: (name: string, fn: (...args: unknown[]) => void) => { handlers.set(name, fn); return 1; }, off: (name: string) => { handlers.delete(name); } } });
    const input: CoreActionInput = { ...rollInput(event), action: { kind: "combat.next", sceneId: "scene", targetId: "combat" } };
    const receipt = await executeCoreAction(input);
    assert.equal(receipt.outcome, "confirmed");
    assert.deepEqual(receipt.state, { ...next, turnCount: 3 });
    assert.equal(advances, 1);
    assert.deepEqual(updateOptions["worldTime"], { delta: 6 });
    assert.equal(updateOptions["direction"], 1);
    assert.deepEqual(updateOptions["foundryLocalApiOrigin"], { source: "foundry-local-api.session-action", phase: "apply", correlationId: event });
    assert.equal(handlers.size, 0);
  }
});

void test("independent missing combat lifecycle acknowledgement cleans hooks and fences repeat advancement", async () => {
  fixture(); let advances = 0;
  const handlers = new Map<string, unknown>();
  const combat = { id: "combat", turns: [{}, {}], toObject: () => ({ active: true, scene: "scene", round: 1, turn: 0 }), nextTurn: async () => { advances++; } };
  (globalThis as unknown as { game: { collections: Map<string, Map<string, unknown>> } }).game.collections.set("Combat", new Map([["combat", combat]]));
  Object.assign(globalThis, { Hooks: { on: (name: string, fn: unknown) => { handlers.set(name, fn); return 1; }, off: (name: string) => handlers.delete(name) } });
  const input: CoreActionInput = { ...rollInput("missing-combat-ack"), action: { kind: "combat.next", sceneId: "scene", targetId: "combat" } };
  assert.equal((await executeCoreAction(input)).outcome, "uncertain");
  assert.equal((await executeCoreAction(input)).outcome, "uncertain");
  assert.equal(advances, 1);
  assert.equal(handlers.size, 0);
});
