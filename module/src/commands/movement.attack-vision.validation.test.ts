import assert from "node:assert/strict";
import test from "node:test";
import { moveTokenVerified, preflightTokenTravel } from "./movement-policy.js";
function configure() { Object.assign(globalThis, { CONFIG: { Token: { movement: { actions: { walk: { walls: "move", teleport: false }, displace: { walls: null, teleport: true } } } } } }); }

void test("independent walk cannot inherit an unconstrained displacement action or caller bypass flags", async () => {
  let seen: { destination: Record<string, unknown>; options: Record<string, unknown> } | undefined;
  configure();
  const token = { movementAction: "displace", move: async (destination: Record<string, unknown>, options: Record<string, unknown>) => { seen = { destination, options }; return true; } };
  await moveTokenVerified(token, { x: 100, y: 200 }, { constrainOptions: { ignoreWalls: true, ignoreCost: true }, correlationId: "correlation" });
  assert.equal(seen?.destination["action"], "walk");
  assert.deepEqual(seen?.options["constrainOptions"], { ignoreWalls: false, ignoreCost: false });
  assert.equal(seen?.options["correlationId"], "correlation");
});
void test("independent travel preflight uses native source path and preserves elevation, no GM displacement", () => {
  const source = { x: 0, y: 0, elevation: 10, level: "level", movementAction: "displace" };
  let observed: unknown;
  const token = { toObject: () => source, object: { constrainMovementPath: (path: unknown, options: unknown) => { observed = { path, options }; return [path, false]; } } };
  preflightTokenTravel(token, { x: 100, y: 200 });
  assert.deepEqual(observed, { path: [{ ...source, action: "walk" }, { ...source, x: 100, y: 200, action: "walk", explicit: true }], options: { ignoreWalls: false, ignoreCost: false } });
  assert.deepEqual(source, { x: 0, y: 0, elevation: 10, level: "level", movementAction: "displace" });
  assert.throws(() => preflightTokenTravel({ ...token, object: { constrainMovementPath: () => [[], true] } }, { x: 100, y: 200 }), /no movement dispatched/);
  assert.throws(() => preflightTokenTravel({ ...token, object: { constrainMovementPath: () => null } }, { x: 100, y: 200 }), /unavailable/);
  assert.throws(() => preflightTokenTravel({ toObject: () => source }, { x: 100, y: 200 }), /unavailable/);
  preflightTokenTravel({ toObject: () => source }, { x: 100, y: 200, mode: "teleport" });
});
void test("independent stopped partial movement has one native call and no fallback displacement", async () => {
  let calls = 0;
  configure();
  await assert.rejects(moveTokenVerified({ move: async () => { calls++; return false; } }, { x: 100, y: 200 }, {}), /reconcile/);
  assert.equal(calls, 1);
  await assert.rejects(moveTokenVerified({}, { x: 100, y: 200 }, {}), /unavailable/);
});
void test("independent absent or changed movement action fails before native mutation", async () => {
  let calls = 0;
  const token = { move: async () => { calls++; return true; } };
  Object.assign(globalThis, { CONFIG: { Token: { movement: { actions: { walk: { walls: null, teleport: true } } } } } });
  await assert.rejects(moveTokenVerified(token, { x: 10, y: 10 }, {}), /configuration unavailable/);
  await assert.rejects(moveTokenVerified(token, { x: 10, y: 10, mode: "teleport" }, {}), /configuration unavailable/);
  assert.equal(calls, 0);
});
