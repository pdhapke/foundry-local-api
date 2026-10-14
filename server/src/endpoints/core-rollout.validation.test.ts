import assert from "node:assert/strict";
import test from "node:test";
import { CORE_ACTION_COMMAND, type CoreActionInput, type CoreActionResult } from "@foundry-local-api/shared";
import { sessionActionEndpointDescriptors } from "./session-actions.js";
import { gameStateEndpointDescriptors } from "./game-state.js";
import type { EndpointContext, EndpointDescriptor } from "./types.js";

const core = sessionActionEndpointDescriptors.find(d => d.name === "foundry_core_action_confirmed") as EndpointDescriptor<CoreActionInput, CoreActionResult>;
const input = (id: string): CoreActionInput => ({ worldId: "w", userId: "gm", requestId: id, correlationId: id, origin: "ai-dm", schemaVersion: "core-actions-v1", action: { kind: "door.state", sceneId: "s", targetId: "d", value: 1 } });
function fixture() {
  let worldId = "w", active = true, generation = 1, mutations = 0, ambiguous = false;
  const calls: string[] = [];
  const client = {
    getCapabilityReport: () => ({ clients: [{ userId: "gm", lane: "gm", isGM: true, optedIn: true, clientId: "client", connectedAt: generation }] }),
    async call(command: string, args: CoreActionInput) {
      calls.push(command);
      if (command === "status") return { worldId, userId: "gm" };
      if (command === "user") return { isGM: true, active };
      mutations++;
      if (ambiguous) throw new Error("ambiguous transport");
      return { outcome: "confirmed", worldId: args.worldId, correlationId: args.correlationId, schemaVersion: "core-actions-v1", action: args.action, state: { ds: 1 }, mutated: true };
    },
  };
  return { ctx: { foundryClient: client } as unknown as EndpointContext, calls, get mutations() { return mutations; }, revoke: () => { active = false; }, wrongWorld: () => { worldId = "other"; }, reconnect: () => { generation++; }, ambiguous: () => { ambiguous = true; } };
}
void test("independent core request rechecks current authority/world on replay and fences reconnect history", async () => {
  for (const change of ["revoke", "wrongWorld", "reconnect"] as const) {
    const f = fixture();
    assert.equal((await core.handler(input(change), f.ctx)).outcome, "confirmed");
    f[change]();
    assert.equal((await core.handler(input(change), f.ctx)).outcome, "failure");
    assert.equal(f.mutations, 1);
  }
});
void test("independent core duplicate delivery dispatches once and changed arguments fail", async () => {
  const f = fixture(), a = input("dedup");
  const results = await Promise.all([core.handler(a, f.ctx), core.handler(a, f.ctx)]);
  assert.ok(results.every(r => r.outcome === "confirmed"));
  assert.equal(f.mutations, 1);
  assert.equal((await core.handler({ ...a, action: { ...a.action, kind: "door.state", sceneId: "s", targetId: "d", value: 2 } }, f.ctx)).outcome, "failure");
  assert.equal(f.mutations, 1);
  assert.equal(f.calls.filter(c => c === CORE_ACTION_COMMAND).length, 1);
});
void test("independent uncertain core outcome fences a different pause mutation on the shared lane", async () => {
  const f = fixture(); f.ambiguous();
  assert.equal((await core.handler(input("uncertain"), f.ctx)).outcome, "uncertain");
  const pause = gameStateEndpointDescriptors.find(d => d.name === "foundry_set_game_paused_confirmed")!;
  const result = await pause.handler({ worldId: "w", userId: "gm", requestId: "pause-next", correlationId: "pause-next", paused: false, origin: "ai-dm" }, f.ctx) as { outcome: string };
  assert.equal(result.outcome, "failure");
  assert.equal(f.mutations, 1);
});
