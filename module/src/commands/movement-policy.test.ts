import assert from "node:assert/strict";
import test from "node:test";
import { moveTokenVerified, preflightTokenTravel } from "./movement-policy.js";
function configuration() { Object.assign(globalThis, { CONFIG: { Token: { movement: { actions: { walk: { walls: "move" }, displace: { walls: null, teleport: true } } } } } }); }

void test("ordinary GM movement uses native walls and terrain constraints with provenance", async () => {
  let observed: unknown;
  configuration();
  await moveTokenVerified({ move: async (destination, options) => { observed = { destination, options }; return true; } },
    { x: 20, y: 30 }, { correlationId: "request", aiDmOrigin: "ai-dm" });
  assert.deepEqual(observed, { destination: { x: 20, y: 30, action: "walk" }, options: {
    correlationId: "request", aiDmOrigin: "ai-dm", showRuler: false,
    constrainOptions: { ignoreWalls: false, ignoreCost: false },
  } });
});
void test("native preflight rejects blocked travel before a partial move and keeps elevation", () => {
  let seen: Record<string, unknown>[] | undefined;
  const token = { toObject: () => ({ x: 0, y: 0, elevation: 5, level: "level", action: "displace" }),
    object: { constrainMovementPath: (path: Record<string, unknown>[]) => { seen = path; return [path, true]; } } };
  assert.throws(() => preflightTokenTravel(token, { x: 20, y: 30 }), /no movement dispatched/);
  assert.equal(seen?.[1]?.["elevation"], 5);
  assert.equal(seen?.[1]?.["action"], "walk");
  assert.throws(() => preflightTokenTravel({ toObject: token.toObject }, { x: 20, y: 30 }), /unavailable/);
});
void test("teleportation is an explicit native displacement and never inferred from blocked travel", async () => {
  let observed: unknown;
  configuration();
  await moveTokenVerified({ move: async (destination, options) => { observed = { destination, options }; return true; } },
    { x: 20, y: 30, mode: "teleport" }, {});
  assert.deepEqual(observed, { destination: { x: 20, y: 30, action: "displace" }, options: {
    showRuler: false, constrainOptions: { ignoreWalls: true, ignoreCost: true },
  } });
  let calls = 0;
  await assert.rejects(moveTokenVerified({ move: async () => { calls++; return false; } }, { x: 20, y: 30 }, {}), /reconcile/);
  assert.equal(calls, 1);
  await assert.rejects(moveTokenVerified({}, { x: 20, y: 30 }, {}), /API unavailable/);
});
