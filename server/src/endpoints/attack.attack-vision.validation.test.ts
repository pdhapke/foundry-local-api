import assert from "node:assert/strict";
import test from "node:test";
import type { AttackInput, AttackResult } from "@foundry-local-api/shared";
import { attackEndpointDescriptors } from "./attack-actions.js";
import { gameStateEndpointDescriptors } from "./game-state.js";
import type { EndpointContext, EndpointDescriptor } from "./types.js";
const attack = attackEndpointDescriptors.find(d => d.name === "foundry_attack_confirmed") as EndpointDescriptor<AttackInput, AttackResult>;
const input = (requestId: string): AttackInput => ({ schemaVersion: "attack-actions-v1", worldId: "world", userId: "gm", requestId, correlationId: requestId, origin: "ai-dm", action: { mode: "roll", sceneId: "scene", attackerTokenId: "source", actorId: "actor", itemId: "item", activityId: "attack", targetTokenId: "target", advantage: "normal" } });
function fixture(patch: Record<string, unknown> = {}, lost = false) {
  let active = true, worldId = "world", generation = 1, mutations = 0;
  const client = { getCapabilityReport: () => ({ clients: [{ userId: "gm", lane: "gm", isGM: true, optedIn: true, clientId: "client", connectedAt: generation }] }),
    call: async (command: string, args: AttackInput) => {
      if (command === "status") return { worldId, userId: "gm" };
      if (command === "user") return { isGM: true, active };
      mutations++;
      if (lost) throw new Error("lost acknowledgement");
      return { ...args, outcome: "confirmed", mutated: true, state: { stage: "miss" }, ...patch };
    } };
  return { ctx: { foundryClient: client } as unknown as EndpointContext, revoke: () => { active = false; }, world: () => { worldId = "other"; }, reconnect: () => { generation++; }, get mutations() { return mutations; } };
}
void test("independent attack endpoint duplicate delivery and changed arguments preserve once-only dispatch", async () => {
  const f = fixture(), command = input("once");
  assert.ok((await Promise.all([attack.handler(command, f.ctx), attack.handler(command, f.ctx)])).every(r => r.outcome === "confirmed"));
  assert.equal(f.mutations, 1);
  assert.equal((await attack.handler({ ...command, action: { ...command.action, mode: "roll", advantage: "advantage" } as any }, f.ctx)).outcome, "failure");
  assert.equal(f.mutations, 1);
});
void test("independent attack replay revocation and world switch fail before a second mutation", async () => {
  for (const change of ["revoke", "world"] as const) {
    const f = fixture(); await attack.handler(input("once"), f.ctx); f[change]();
    assert.equal((await attack.handler(input("once"), f.ctx)).outcome, "failure");
    assert.equal(f.mutations, 1);
  }
});
void test("independent lost or drifted attack acknowledgement fences pause and fresh attacks", async () => {
  for (const [patch, lost] of [[{}, true], [{ worldId: "other" }, false], [{ userId: "other" }, false], [{ schemaVersion: "other" }, false], [{ action: {} }, false]] as const) {
    const f = fixture(patch, lost), first = await attack.handler(input("uncertain"), f.ctx);
    assert.equal(first.outcome, "uncertain");
    assert.deepEqual(await attack.handler(input("uncertain"), f.ctx), first);
    assert.equal((await attack.handler(input("new"), f.ctx)).outcome, "failure");
    const pause = gameStateEndpointDescriptors.find(d => d.name === "foundry_set_game_paused_confirmed")!;
    assert.equal((await pause.handler({ worldId: "world", userId: "gm", requestId: "pause", correlationId: "pause", origin: "ai-dm", paused: false }, f.ctx) as { outcome: string }).outcome, "failure");
    assert.equal(f.mutations, 1);
  }
});
