import assert from "node:assert/strict";
import { test } from "node:test";
import "./attack-actions.js";
import type { AttackInput } from "@foundry-local-api/shared";
const request = (requestId = "r"): AttackInput => ({
  schemaVersion: "attack-actions-v1",
  worldId: "w",
  userId: "gm",
  requestId,
  correlationId: `c-${requestId}`,
  origin: "ai-dm",
  action: {
    mode: "roll",
    sceneId: "s",
    attackerTokenId: "a-token",
    actorId: "a",
    itemId: "i",
    activityId: "act",
    targetTokenId: "t-token",
    advantage: "normal",
  },
});
function fixture(
  options: {
    miss?: boolean;
    critical?: boolean;
    reaction?: boolean;
    damageFailure?: boolean;
    cancelled?: boolean;
    immune?: boolean;
  } = {},
) {
  const globals = globalThis as unknown as Record<string, any>;
  const hooks = new Map<number, { name: string; callback: (...args: any[]) => void }>();
  let counter = 0;
  const emit = (name: string, ...args: unknown[]) => {
    for (const hook of hooks.values()) if (hook.name === name) hook.callback(...args);
  };
  globals.Hooks = {
    on: (name: string, callback: (...args: any[]) => void) => {
      hooks.set(++counter, { name, callback });
      return counter;
    },
    off: (_name: string, id: number) => hooks.delete(id),
  };
  const journals = new Map<string, any>();
  let attackCalls = 0,
    damageCalls = 0,
    applyCalls = 0;
  let attackConfig: any;
  const activity: any = {
    id: "act",
    name: "Sword",
    type: "attack",
    uses: {},
    effects: [],
    behaviors: [],
    consumption: {},
    damage: { parts: [{ types: new Set(["slashing"]) }] },
    getAttackData: () => ({ parts: ["1d20", "5"] }),
    rollAttack: async (config: any) => {
      attackConfig = config;
      attackCalls++;
      assert.equal(
        journals.get("ledger").data.flags["foundry-local-api"].attackLedger["gm:r"].pending,
        true,
      );
      return [
        {
          total: options.miss ? 2 : 19,
          formula: "1d20+5",
          result: "14+5",
          isCritical: options.critical ?? false,
          isFumble: false,
        },
      ];
    },
    rollDamage: async (config: any) => {
      damageCalls++;
      assert.equal(config.isCritical, options.critical ?? false);
      if (options.damageFailure) throw Error("damage transport lost");
      return [
        {
          total: options.critical ? 14 : 7,
          formula: options.critical ? "2d8+3" : "1d8+3",
          result: "4+3",
          options: { type: "slashing", properties: ["mgc"] },
        },
      ];
    },
  };
  const item: any = {
    id: "i",
    system: {
      quantity: 1,
      uses: {},
      attackModes: [{ value: "oneHanded" }],
      activities: new Map([["act", activity]]),
    },
    toObject: () => ({ type: "weapon" }),
  };
  const actor: any = {
    id: "a",
    system: { attributes: { hp: { value: 20, temp: 0, max: 20 } } },
    items: new Map([["i", item]]),
  };
  const target: any = {
    id: "t",
    items: new Map(),
    system: { attributes: { ac: { value: 15 }, hp: { value: 20, temp: 3, max: 20 } } },
    applyDamage: async (parts: any[], applyOptions: any) => {
      applyCalls++;
      assert.ok(applyOptions.origin.getFlag("dnd5e", "context").foundryLocalApiOrigin);
      if (options.cancelled) return target;
      const amount = options.immune ? 0 : Math.floor(parts[0].value / 2);
      emit("dnd5e.calculateDamage", target, [
        { type: "slashing", value: amount, active: { resistance: true } },
      ]);
      const tempDamage = Math.min(target.system.attributes.hp.temp, amount);
      target.system.attributes.hp.temp -= tempDamage;
      target.system.attributes.hp.value -= amount - tempDamage;
      emit("dnd5e.applyDamage", target, amount, applyOptions);
      return target;
    },
  };
  if (options.reaction)
    target.items.set("reaction", {
      id: "reaction",
      system: {
        activities: new Map([["react", { id: "react", activation: { type: "reaction" } }]]),
      },
    });
  const tokens = new Map([
    ["a-token", { id: "a-token", actor, toObject: () => ({ name: "A" }) }],
    ["t-token", { id: "t-token", actor: target, toObject: () => ({ name: "T" }) }],
  ]);
  const scene: any = {
    id: "s",
    toObject: () => ({ active: true }),
    getEmbeddedCollection: () => tokens,
  };
  const gm = { id: "gm", isGM: true, active: true };
  globals.game = {
    world: { id: "w" },
    system: { id: "dnd5e", version: "6.0.3" },
    user: gm,
    users: new Map([["gm", gm]]),
    collections: new Map([
      ["Scene", new Map([["s", scene]])],
      ["JournalEntry", journals],
    ]),
  };
  class AttackMessage {
    get evaluatedTargets() {
      return (this as any).targets.map((target: any) => ({
        ...target,
        isMiss:
          !(this as any).parent.rolls[0].isCritical &&
          ((this as any).parent.rolls[0].total < target.ac ||
            (this as any).parent.rolls[0].isFumble),
      }));
    }
  }
  globals.CONFIG = {
    DND5E: { abilities: { str: {} }, damageTypes: { slashing: {} } },
    ChatMessage: { dataModels: { attack: AttackMessage } },
    JournalEntry: {
      documentClass: {
        create: async (data: any) => {
          const doc = {
            id: "ledger",
            data,
            toObject: () => data,
            update: async (updates: any) => {
              data.flags["foundry-local-api"].attackLedger =
                updates["flags.foundry-local-api.attackLedger"];
              return doc;
            },
          };
          journals.set("ledger", doc);
          return doc;
        },
      },
    },
  };
  return {
    activity,
    item,
    target,
    journals,
    gm,
    calls: () => ({ attackCalls, damageCalls, applyCalls }),
    config: () => attackConfig,
  };
}

import { dispatch } from "../command-registry.js";
import "./attack-actions.js";
import "./session-actions.js";
import "./game-state.js";
import { ATTACK_COMMAND, CORE_ACTION_COMMAND } from "@foundry-local-api/shared";
const call = (type: string, payload: unknown) =>
  dispatch({ id: crypto.randomUUID(), type, payload } as any);
function enrich(f: ReturnType<typeof fixture>, events: string[]) {
  const g = (globalThis as any).game;
  f.target.toObject = () => ({ system: structuredClone(f.target.system) });
  f.target.update = async (changes: any) => {
    events.push("hp");
    f.target.system.attributes.hp.value = changes["system.attributes.hp.value"];
    return f.target;
  };
  g.paused = false;
  g.togglePause = (paused: boolean) => {
    events.push("pause");
    g.paused = paused;
  };
  return g;
}
const hpInput = (requestId: string) => ({
  schemaVersion: "core-actions-v1",
  worldId: "w",
  userId: "gm",
  origin: "ai-dm",
  requestId,
  correlationId: requestId,
  action: { kind: "actor.hp", sceneId: "s", targetId: "t", value: 12 },
});
const pauseInput = (requestId: string) => ({
  worldId: "w",
  userId: "gm",
  origin: "ai-dm",
  requestId,
  correlationId: requestId,
  paused: true,
});
// Node's test runner owns completion of these registered tests.
void test("registered attack ingress holds core HP and confirmed pause in FIFO until native mechanics end", async () => {
  const f = fixture();
  const events: string[] = [];
  enrich(f, events);
  const original = f.activity.rollAttack;
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>((r) => (entered = r));
  const gate = new Promise<void>((r) => (release = r));
  f.activity.rollAttack = async (config: any) => {
    events.push("attack-start");
    entered();
    await gate;
    const result = await original(config);
    events.push("attack-end");
    return result;
  };
  const attack = call(ATTACK_COMMAND, request());
  await Promise.race([
    enteredPromise,
    attack.then((result) => {
      throw new Error(JSON.stringify(result));
    }),
  ]);
  const hp = call(CORE_ACTION_COMMAND, hpInput("hp-fifo"));
  const pause = call("gameSetPausedConfirmed", pauseInput("pause-fifo"));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(events, ["attack-start"]);
  release();
  const results = await Promise.all([attack, hp, pause]);
  assert.ok(
    results.every((r) => r.ok),
    JSON.stringify(results),
  );
  assert.deepEqual(
    results.map((r: any) => r.result.outcome),
    ["confirmed", "confirmed", "confirmed"],
  );
  assert.deepEqual(events, ["attack-start", "attack-end", "hp", "pause"]);
  assert.equal(f.target.system.attributes.hp.value, 12);
});
void test("registered uncertain attack outcome fences later HP and pause without mutation", async () => {
  const f = fixture({ damageFailure: true });
  const events: string[] = [];
  enrich(f, events);
  const attack: any = await call(ATTACK_COMMAND, request());
  assert.equal(attack.result.outcome, "uncertain");
  const hp = await call(CORE_ACTION_COMMAND, hpInput("hp-denied"));
  const pause = await call("gameSetPausedConfirmed", pauseInput("pause-denied"));
  assert.equal(hp.ok, false);
  assert.equal(pause.ok, false);
  assert.deepEqual(events, []);
  assert.equal(f.target.system.attributes.hp.value, 20);
});
void test("native ordering lane is scoped to game identity, not a permanent global grant", async () => {
  const f = fixture({ damageFailure: true });
  enrich(f, []);
  await call(ATTACK_COMMAND, request());
  const fresh = fixture();
  const events: string[] = [];
  enrich(fresh, events);
  const hp: any = await call(CORE_ACTION_COMMAND, hpInput("fresh-world"));
  assert.equal(hp.result.outcome, "confirmed");
  assert.deepEqual(events, ["hp"]);
  (globalThis as any).game.user.isGM = false;
  const denied: any = await call(CORE_ACTION_COMMAND, hpInput("revoked"));
  assert.equal(denied.result.outcome, "failure");
  assert.deepEqual(events, ["hp"]);
});

const sessionHp = (key: string) => ({
  worldId: "w",
  requestingUserId: "gm",
  action: { kind: "actor.hp", sceneId: "s", targetId: "t", value: 12 },
  expectedState: { value: 20, max: 20 },
  correlationId: key,
  idempotencyKey: key,
});
for (const failure of ["throw", "readback"] as const)
  void test(`registered session ${failure} after mutation start fences attacks and pause`, async () => {
    const f = fixture();
    const events: string[] = [];
    enrich(f, events);
    f.target.update = async () => {
      events.push("attempted-hp");
      if (failure === "throw") throw Error("lost update acknowledgement");
      return f.target;
    };
    const applied = await call("sessionActionApply", sessionHp(`uncertain-${failure}`));
    assert.equal(applied.ok, false);
    const attack = await call(ATTACK_COMMAND, request());
    const pause = await call("gameSetPausedConfirmed", pauseInput(`blocked-${failure}`));
    assert.equal(attack.ok, false);
    assert.equal(pause.ok, false);
    assert.equal(f.calls().attackCalls, 0);
    assert.deepEqual(events, ["attempted-hp"]);
  });
void test("registered pre-dispatch stale session rejection permits subsequent authorized controls", async () => {
  const f = fixture();
  const events: string[] = [];
  enrich(f, events);
  const rejected = await call("sessionActionApply", {
    ...sessionHp("stale"),
    expectedState: { value: 19, max: 20 },
  });
  assert.equal(rejected.ok, false);
  const hp: any = await call(CORE_ACTION_COMMAND, hpInput("after-stale"));
  assert.equal(hp.result.outcome, "confirmed");
  assert.deepEqual(events, ["hp"]);
});
