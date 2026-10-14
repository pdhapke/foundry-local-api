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
              for (const [key, value] of Object.entries(updates))
                data.flags["foundry-local-api"][key.split(".").at(-1)!] = value;
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

import "./attack-sequences.js";
import { dispatch } from "../command-registry.js";
import { ATTACK_SEQUENCE_COMMAND } from "@foundry-local-api/shared";
const sequence = (id = "seq") => ({
  schemaVersion: "attack-sequence-v1",
  worldId: "w",
  userId: "gm",
  requestId: id,
  correlationId: id,
  origin: "ai-dm",
  action: {
    mode: "execute",
    maxDurationMs: 8000,
    steps: [
      { stepId: "one", attack: request().action },
      { stepId: "two", attack: request().action },
    ],
  },
});
const send = (input: any) =>
  dispatch({ id: crypto.randomUUID(), type: ATTACK_SEQUENCE_COMMAND, payload: input } as any);
// Node's test runner owns completion of these registered tests.
void test("independent registered sequence commits two hits with cumulative native damage and exact duplicate replay", async () => {
  const f = fixture();
  const input = sequence();
  const result: any = await send(input);
  assert.equal(result.result.outcome, "confirmed", JSON.stringify(result));
  assert.equal(result.result.state.completedStepCount, 2);
  assert.equal(result.result.state.steps.length, 2);
  assert.equal(f.calls().attackCalls, 2);
  assert.equal(f.calls().applyCalls, 2);
  assert.equal(f.target.system.attributes.hp.value, 17);
  assert.equal(f.target.system.attributes.hp.temp, 0);
  assert.deepEqual(((await send(input)) as any).result, result.result);
  assert.equal(f.calls().attackCalls, 2);
  assert.equal(f.calls().applyCalls, 2);
  const changed: any = await send({
    ...input,
    action: { ...input.action, steps: [input.action.steps[0]!] },
  });
  assert.equal(changed.result.outcome, "failure");
});
void test("independent native rejects invalid advantage and unknown attack fields before rolling", async () => {
  for (const attack of [
    { ...request().action, advantage: "bogus" },
    { ...request().action, ignoreResources: true },
    { ...request().action, actorId: "a".repeat(129) },
  ]) {
    const f = fixture();
    const input = sequence();
    input.action.steps = [{ stepId: "one", attack } as any];
    const result: any = await send(input);
    assert.equal(result.result.outcome, "failure", JSON.stringify(result));
    assert.equal(f.calls().attackCalls, 0);
  }
});
void test("independent sequence miss still reports consumed activity resources", async () => {
  const f = fixture({ miss: true });
  f.activity.uses = { max: 3, spent: 0 };
  f.activity.consumption.targets = [{ type: "activityUses", target: "", value: "1" }];
  f.activity.use = async () => {
    f.activity.uses.spent++;
    return { updates: { activity: {} } };
  };
  const input = sequence();
  input.action.steps = [input.action.steps[0]!];
  const result: any = await send(input);
  assert.equal(result.result.outcome, "confirmed", JSON.stringify(result));
  assert.equal(f.activity.uses.spent, 1);
  assert.equal(result.result.mutated, true);
  assert.equal(result.result.state.steps[0].rollReceipt.mutated, true);
  assert.equal(f.calls().damageCalls, 0);
});
void test("independent resource cancellation after spend is uncertain and replay cannot spend again", async () => {
  const f = fixture();
  f.activity.uses = { max: 3, spent: 0 };
  f.activity.consumption.targets = [{ type: "activityUses", target: "", value: "1" }];
  f.activity.use = async () => {
    f.activity.uses.spent++;
    return undefined;
  };
  const result: any = await send(sequence());
  assert.equal(result.result.outcome, "uncertain", JSON.stringify(result));
  assert.equal(f.activity.uses.spent, 1);
  assert.equal(f.calls().attackCalls, 0);
  await send(sequence());
  assert.equal(f.activity.uses.spent, 1);
});

void test("independent activation counter must be supported with verified evidence or rejected before usage", async () => {
  const f = fixture({ miss: true });
  f.activity.uses = { max: 3, spent: 0 };
  f.activity.consumption.targets = [{ type: "activityUses", target: "", value: "1" }];
  f.activity.activation = { type: "bonus", value: 1 };
  const globals = globalThis as any;
  globals.CONFIG.DND5E.activityActivationTypes = {
    bonus: { consume: { property: "system.resources.bonus" } },
  };
  let activations = 0;
  f.activity.use = async () => {
    activations++;
    f.activity.uses.spent++;
    return { updates: { actor: { "system.resources.bonus.value": 0 } } };
  };
  const input = sequence();
  input.action.steps = [input.action.steps[0]!];
  const result: any = await send(input);
  if (result.result.outcome === "confirmed") {
    const evidence = result.result.state.steps[0].rollReceipt.state.resourceConsumption;
    assert.ok(
      evidence.activation?.verified,
      "Configured native activation resource consumed without verified readback evidence",
    );
  } else {
    assert.equal(activations, 0, "Unsupported activation resource must fail before native usage");
  }
});

void test("independent durable pending after native instance loss fences duplicate and fresh sequence", async () => {
  const f = fixture();
  await send(sequence());
  const entry =
    f.journals.get("ledger").data.flags["foundry-local-api"].attackSequenceLedger["gm:seq"];
  entry.pending = true;
  entry.result.outcome = "uncertain";
  (globalThis as any).game = { ...(globalThis as any).game };
  const before = f.calls();
  const duplicate: any = await send(sequence());
  assert.equal(duplicate.result.outcome, "uncertain");
  const fresh = await send(sequence("fresh-after-crash"));
  assert.equal(fresh.ok, false);
  assert.deepEqual(f.calls(), before);
});
for (const mutation of ["hp", "target"] as const)
  void test(`independent ${mutation} drift between rolled and applied damage prevents application`, async () => {
    const f = fixture();
    const original = f.activity.rollDamage;
    f.activity.rollDamage = async (config: any) => {
      const rolls = await original(config);
      if (mutation === "hp") f.target.system.attributes.hp.value = 15;
      else
        (globalThis as any).game.collections
          .get("Scene")
          .get("s")
          .getEmbeddedCollection("Token")
          .delete("t-token");
      return rolls;
    };
    const result: any = await send(sequence());
    assert.notEqual(result.result.outcome, "confirmed");
    assert.equal(f.calls().attackCalls, 1);
    assert.equal(f.calls().applyCalls, 0);
  });
void test("independent clean partial deadline resumes immutable cumulative plan without rerolling prefix", async () => {
  const f = fixture();
  const original = f.target.applyDamage;
  let first = true;
  f.target.applyDamage = async (parts: any[], options: any) => {
    const result = await original(parts, options);
    if (first) {
      first = false;
      await new Promise((r) => setTimeout(r, 1050));
    }
    return result;
  };
  const input = sequence();
  input.action.maxDurationMs = 1000;
  const partial: any = await send(input);
  assert.equal(partial.result.outcome, "partial", JSON.stringify(partial));
  assert.equal(partial.result.state.completedStepCount, 1);
  assert.equal(f.calls().attackCalls, 1);
  const ticket = partial.result.state.continuation;
  const resume: any = await send({
    ...sequence("resumed"),
    action: {
      mode: "resume",
      priorSequenceRequestId: "seq",
      continuationId: ticket.id,
      maxDurationMs: 8000,
    },
  });
  assert.equal(resume.result.outcome, "confirmed", JSON.stringify(resume));
  assert.equal(resume.result.state.steps.length, 2);
  assert.equal(resume.result.state.sequenceRequestId, "seq");
  assert.equal(f.calls().attackCalls, 2);
  assert.equal(f.calls().applyCalls, 2);
});

import "./session-actions.js";
void test("independent registered sequence retains shared mutation slot across steps before queued core HP", async () => {
  const f = fixture();
  const original = f.activity.rollAttack;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const started = new Promise<void>((r) => (entered = r));
  let first = true;
  f.activity.rollAttack = async (config: any) => {
    if (first) {
      first = false;
      entered();
      await gate;
    }
    return original(config);
  };
  let hpCalls = 0;
  f.target.toObject = () => ({ system: structuredClone(f.target.system) });
  f.target.update = async (changes: any) => {
    hpCalls++;
    f.target.system.attributes.hp.value = changes["system.attributes.hp.value"];
    return f.target;
  };
  const seq = send(sequence());
  await Promise.race([
    started,
    seq.then((r) => {
      throw Error(JSON.stringify(r));
    }),
  ]);
  const hp = dispatch({
    id: "core-conflict",
    type: "coreActionConfirmed",
    payload: {
      schemaVersion: "core-actions-v1",
      worldId: "w",
      userId: "gm",
      requestId: "core-conflict",
      correlationId: "core-conflict",
      origin: "ai-dm",
      action: { kind: "actor.hp", sceneId: "s", targetId: "t", value: 12 },
    },
  } as any);
  await new Promise((r) => setImmediate(r));
  assert.equal(hpCalls, 0);
  release();
  const [seqResult, hpResult]: any = await Promise.all([seq, hp]);
  assert.equal(seqResult.result.outcome, "confirmed");
  assert.equal(hpResult.result.outcome, "confirmed");
  assert.equal(f.calls().applyCalls, 2);
  assert.equal(hpCalls, 1);
  assert.equal(f.target.system.attributes.hp.value, 12);
});

function foundryExpand(value: any): any {
  if (Array.isArray(value)) return value.map(foundryExpand);
  if (!value || typeof value !== "object") return value;
  const out: any = {};
  for (const [key, v] of Object.entries(value)) {
    let cursor = out;
    const parts = key.split(".");
    for (const part of parts.slice(0, -1)) cursor = cursor[part] ??= {};
    cursor[parts.at(-1)!] = foundryExpand(v);
  }
  return out;
}
void test("independent Foundry recursive dotted flag expansion preserves successful resource receipts and duplicate no-spend", async () => {
  const f = fixture({ miss: true });
  f.item.system.uses = { max: 3, spent: 0 };
  f.activity.consumption.targets = [{ type: "itemUses", target: "", value: "1" }];
  f.activity.use = async () => {
    f.item.system.uses.spent++;
    return {
      updates: {
        actor: {},
        activity: {},
        create: [],
        delete: [],
        item: [{ _id: "i", "system.uses.spent": 1 }],
        rolls: [],
      },
    };
  };
  const globals = globalThis as any,
    create = globals.CONFIG.JournalEntry.documentClass.create;
  globals.CONFIG.JournalEntry.documentClass.create = async (data: any) => {
    const doc = await create(data);
    doc.update = async (updates: any) => {
      const expanded = foundryExpand(updates);
      Object.assign(data.flags["foundry-local-api"], expanded.flags["foundry-local-api"]);
      return doc;
    };
    return doc;
  };
  const input = sequence();
  input.action.steps = [input.action.steps[0]!];
  const first: any = await send(input);
  assert.equal(first.result.outcome, "confirmed", JSON.stringify(first));
  assert.equal(first.result.state.completedStepCount, 1);
  assert.equal(f.item.system.uses.spent, 1);
  const duplicate: any = await send(input);
  assert.equal(duplicate.result.outcome, "confirmed");
  assert.equal(f.item.system.uses.spent, 1);
  assert.equal(f.calls().attackCalls, 1);
});
