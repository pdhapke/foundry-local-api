import assert from "node:assert/strict";
import test from "node:test";
import { setGamePausedConfirmed } from "./game-state.js";

const gm = { id: "gm", isGM: true, active: true };
let n = 0;
function input(paused = true) {
  const id = `validation-${++n}`;
  return {
    paused,
    worldId: "world",
    userId: "gm",
    requestId: id,
    correlationId: id,
    origin: "ai-dm" as const,
  };
}
function fixture() {
  let calls = 0;
  let marker: unknown;
  const state = {
    world: { id: "world" },
    user: gm,
    users: { get: () => gm },
    paused: false,
    togglePause(desired: boolean) {
      calls++;
      marker = (globalThis as any).foundryLocalApiPauseOrigin;
      state.paused = desired;
      return desired;
    },
  };
  (globalThis as any).game = state;
  return {
    state,
    get calls() {
      return calls;
    },
    get marker() {
      return marker;
    },
  };
}
void test("independent module exact world/active GM, same-state, conflicting duplicate and scoped origin", () => {
  const f = fixture();
  const a = input();
  assert.equal(setGamePausedConfirmed({ ...a, worldId: "wrong" }).outcome, "failure");
  f.state.user = { ...gm, isGM: false };
  assert.equal(setGamePausedConfirmed(a).outcome, "failure");
  f.state.user = gm;
  assert.equal(setGamePausedConfirmed(a).outcome, "confirmed");
  assert.equal(f.calls, 1);
  assert.equal((f.marker as any).correlationId, a.correlationId);
  assert.equal((globalThis as any).foundryLocalApiPauseOrigin, undefined);
  assert.equal(setGamePausedConfirmed(a).outcome, "confirmed");
  assert.equal(f.calls, 1);
  assert.equal(setGamePausedConfirmed({ ...a, paused: false }).outcome, "failure");
  assert.equal(setGamePausedConfirmed(input()).mutated, false);
  assert.equal(f.calls, 1);
});
void test("independent module ambiguous mutation remains sticky uncertain", () => {
  const f = fixture();
  f.state.togglePause = () => {
    throw new Error("lost acknowledgement");
  };
  const a = input();
  assert.equal(setGamePausedConfirmed(a).outcome, "uncertain");
  f.state.togglePause = () => {
    assert.fail("ambiguous mutation retried");
  };
  assert.equal(setGamePausedConfirmed(a).outcome, "uncertain");
});
