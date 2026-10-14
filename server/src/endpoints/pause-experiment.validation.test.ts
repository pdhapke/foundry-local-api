import assert from "node:assert/strict";
import test from "node:test";
import { gameStateEndpointDescriptors } from "./game-state.js";
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
void test("independent endpoint serializes opposite desired states and deduplicates transport uncertainty", async () => {
  const descriptor = gameStateEndpointDescriptors.find(
    (d) => d.name === "foundry_set_game_paused_confirmed",
  )!;
  let calls = 0;
  let release!: () => void;
  const barrier = new Promise<void>((r) => (release = r));
  const client = {
    getCapabilityReport: () => ({
      clients: [{ userId: "gm", lane: "gm", isGM: true, optedIn: true, clientId: "client" }],
    }),
    async call(_command: string, a: any) {
      if (_command === "status") return { worldId: "world", userId: "gm" };
      if (_command === "user") return { isGM: true, active: true };
      calls++;
      if (calls === 1) await barrier;
      return {
        outcome: "confirmed",
        paused: a.paused,
        worldId: a.worldId,
        correlationId: a.correlationId,
        mutated: true,
      };
    },
  };
  const ctx = { foundryClient: client } as any;
  const a = input();
  const first = descriptor.handler(a, ctx);
  const second = descriptor.handler(input(false), ctx);
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 2);
  await descriptor.handler(a, ctx);
  assert.equal(calls, 2);
  const b = input();
  client.call = async (command: string) => {
    if (command === "status") return { worldId: "world", userId: "gm" };
    if (command === "user") return { isGM: true, active: true };
    calls++;
    throw new Error("timeout");
  };
  assert.equal(((await descriptor.handler(b, ctx)) as any).outcome, "uncertain");
  await descriptor.handler(b, ctx);
  assert.equal(calls, 3);
});
void test("independent endpoint reconnect routes fresh requests and refuses absent exact GM", async () => {
  const descriptor = gameStateEndpointDescriptors.find(
    (d) => d.name === "foundry_set_game_paused_confirmed",
  )!;
  let clientId = "old";
  let connected = true;
  const routed: string[] = [];
  const client = {
    getCapabilityReport: () => ({
      clients: connected ? [{ userId: "gm", lane: "gm", isGM: true, optedIn: true, clientId }] : [],
    }),
    async call(_command: string, a: any, options: any) {
      routed.push(options.clientId);
      return {
        outcome: "confirmed",
        paused: a.paused,
        worldId: a.worldId,
        correlationId: a.correlationId,
        mutated: true,
      };
    },
  };
  const ctx = { foundryClient: client } as any;
  assert.equal(((await descriptor.handler(input(), ctx)) as any).outcome, "confirmed");
  connected = false;
  assert.equal(((await descriptor.handler(input(), ctx)) as any).outcome, "failure");
  connected = true;
  clientId = "new";
  assert.equal(((await descriptor.handler(input(false), ctx)) as any).outcome, "confirmed");
  assert.deepEqual(routed, ["old", "new"]);
});

void test("independent endpoint uncertain fences fresh IDs and revoked GM cannot replay receipt", async () => {
  const d = gameStateEndpointDescriptors.find(
    (v) => v.name === "foundry_set_game_paused_confirmed",
  )!;
  let connected = true;
  let calls = 0;
  const c = {
    getCapabilityReport: () => ({
      clients: connected
        ? [{ userId: "gm", lane: "gm", isGM: true, optedIn: true, clientId: "c" }]
        : [],
    }),
    async call() {
      calls++;
      throw Error("ambiguous");
    },
  };
  const ctx = { foundryClient: c } as any;
  const a = input();
  assert.equal(((await d.handler(a, ctx)) as any).outcome, "uncertain");
  assert.equal(((await d.handler(input(false), ctx)) as any).outcome, "failure");
  assert.equal(calls, 1);
  connected = false;
  assert.equal(((await d.handler(a, ctx)) as any).outcome, "failure");
});

void test("independent endpoint historical replay fails after live world or connection changes", async () => {
  const d = gameStateEndpointDescriptors.find(
    (v) => v.name === "foundry_set_game_paused_confirmed",
  )!;
  let worldId = "world";
  let generation = 1;
  let mutations = 0;
  const c = {
    getCapabilityReport: () => ({
      clients: [
        {
          userId: "gm",
          lane: "gm",
          isGM: true,
          optedIn: true,
          clientId: "c",
          connectedAt: generation,
        },
      ],
    }),
    async call(command: string, a: any) {
      if (command === "status") return { worldId, userId: "gm" };
      if (command === "user") return { isGM: true, active: true };
      mutations++;
      return {
        outcome: "confirmed",
        paused: a.paused,
        worldId: a.worldId,
        correlationId: a.correlationId,
        mutated: true,
      };
    },
  };
  const ctx = { foundryClient: c } as any;
  const a = input();
  assert.equal(((await d.handler(a, ctx)) as any).outcome, "confirmed");
  worldId = "wrong";
  assert.equal(((await d.handler(a, ctx)) as any).outcome, "failure");
  worldId = "world";
  generation = 2;
  assert.equal(((await d.handler(a, ctx)) as any).outcome, "failure");
  assert.equal(mutations, 1);
});
