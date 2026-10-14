import assert from "node:assert/strict";
import { test } from "node:test";
import { executeAttackSequence } from "./attack-sequences.js";
import type { AttackSequenceInput } from "@foundry-local-api/shared";
const request = (): AttackSequenceInput => ({
  schemaVersion: "attack-sequence-v1",
  worldId: "w",
  userId: "gm",
  requestId: "seq",
  correlationId: "cseq",
  origin: "ai-dm",
  action: {
    mode: "execute",
    maxDurationMs: 8000,
    steps: [
      {
        stepId: "one",
        attack: {
          mode: "roll",
          sceneId: "s",
          attackerTokenId: "a-token",
          actorId: "a",
          itemId: "i",
          activityId: "act",
          targetTokenId: "t-token",
          advantage: "normal",
        },
      },
      {
        stepId: "two",
        attack: {
          mode: "roll",
          sceneId: "s",
          attackerTokenId: "a-token",
          actorId: "a",
          itemId: "i",
          activityId: "act",
          targetTokenId: "t-token",
          advantage: "normal",
        },
      },
    ],
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
    resource?: boolean;
    resourceCancel?: boolean;
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
  const expandDottedKeys = (value: any): any => {
    if (Array.isArray(value)) return value.map(expandDottedKeys);
    if (!value || typeof value !== "object") return value;
    const result: any = {};
    for (const [path, child] of Object.entries(value)) {
      const keys = path.split(".");
      let owner = result;
      for (const key of keys.slice(0, -1)) owner = owner[key] ??= {};
      owner[keys.at(-1)!] = expandDottedKeys(child);
    }
    return result;
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
      assert.ok(
        Object.values(journals.get("ledger").data.flags["foundry-local-api"].attackLedger).some(
          (v: any) => v.pending,
        ),
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
              for (const [key, value] of Object.entries(updates))
                data.flags["foundry-local-api"][key.split(".").at(-1)!] = expandDottedKeys(value);
              return doc;
            },
          };
          journals.set("ledger", doc);
          return doc;
        },
      },
    },
  };
  if (options.resource) {
    item.system.uses = { max: 3, spent: 0 };
    activity.consumption = { targets: [{ type: "itemUses", target: "", value: "1" }] };
    activity.use = async (usage: any, dialog: any, message: any) => {
      assert.equal(usage.subsequentActions, false);
      assert.equal(dialog.configure, false);
      assert.equal(message.create, false);
      item.system.uses.spent++;
      return options.resourceCancel
        ? undefined
        : {
            updates: {
              actor: {},
              activity: {},
              item: [{ _id: "i", "system.uses.spent": item.system.uses.spent }],
              create: [],
              delete: [],
              rolls: [],
            },
          };
    };
  }
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
// Node's test runner owns completion of these registered tests.
void test("explicit two-step sequence applies native damage once per step and replay never rerolls", async () => {
  const f = fixture();
  const input = request();
  const result = await executeAttackSequence(input);
  assert.equal(result.outcome, "confirmed");
  assert.equal(result.state?.completedStepCount, 2);
  assert.deepEqual(f.calls(), { attackCalls: 2, damageCalls: 2, applyCalls: 2 });
  assert.deepEqual(await executeAttackSequence(input), result);
  assert.equal(f.calls().attackCalls, 2);
});
void test("resource usage verified once before each attack and never on replay", async () => {
  const f = fixture({ resource: true, miss: true });
  const input = request();
  const result = await executeAttackSequence(input);
  assert.equal(result.outcome, "confirmed");
  assert.equal(f.item.system.uses.spent, 2);
  assert.equal(
    (result.state?.steps[0]?.rollReceipt.state?.resourceConsumption as any)?.verified,
    true,
  );
  await executeAttackSequence(input);
  assert.equal(f.item.system.uses.spent, 2);
});
void test("native use cancellation after spend is uncertain and no attack or replay", async () => {
  const f = fixture({ resource: true, resourceCancel: true });
  const input = request();
  const result = await executeAttackSequence(input);
  assert.equal(result.outcome, "uncertain");
  assert.equal(f.item.system.uses.spent, 1);
  assert.equal(f.calls().attackCalls, 0);
  await executeAttackSequence(input);
  assert.equal(f.item.system.uses.spent, 1);
});
void test("reaction stops remaining sequence without a model-resolvable continuation", async () => {
  const f = fixture({ reaction: true });
  const result = await executeAttackSequence(request());
  assert.equal(result.outcome, "decision-required");
  assert.equal(result.state?.continuation, null);
  assert.equal(f.calls().attackCalls, 1);
  assert.equal(f.calls().applyCalls, 0);
});

void test("clean between-step deadline resume validates immutable observations and cumulative receipts", async () => {
  const f = fixture({ miss: true });
  const original = globalThis.performance;
  let clock = 0;
  Object.defineProperty(globalThis, "performance", {
    configurable: true,
    value: { now: () => clock },
  });
  try {
    const native = f.activity.rollAttack;
    f.activity.rollAttack = async (config: any) => {
      const result = await native(config);
      clock += 1001;
      return result;
    };
    const input = request();
    input.action.maxDurationMs = 1000;
    const partial = await executeAttackSequence(input);
    assert.equal(partial.outcome, "partial");
    assert.equal(partial.state?.completedStepCount, 1);
    const ticket = partial.state!.continuation!;
    const resumed = await executeAttackSequence({
      ...input,
      requestId: "resume",
      action: {
        mode: "resume",
        priorSequenceRequestId: ticket.priorSequenceRequestId,
        continuationId: ticket.id,
        maxDurationMs: 8000,
      },
    });
    assert.equal(resumed.outcome, "confirmed");
    assert.equal(resumed.state?.sequenceRequestId, "seq");
    assert.equal(resumed.state?.completedStepCount, 2);
    assert.equal(f.calls().attackCalls, 2);
  } finally {
    Object.defineProperty(globalThis, "performance", { configurable: true, value: original });
  }
});
void test("delayed resource consumption exceeding budget fences before roll", async () => {
  const f = fixture({ resource: true });
  const original = globalThis.performance;
  let clock = 0;
  Object.defineProperty(globalThis, "performance", {
    configurable: true,
    value: { now: () => clock },
  });
  try {
    const native = f.activity.use;
    f.activity.use = async (...args: any[]) => {
      const result = await native(...args);
      clock = 1001;
      return result;
    };
    const input = request();
    input.action.maxDurationMs = 1000;
    const result = await executeAttackSequence(input);
    assert.equal(result.outcome, "uncertain");
    assert.equal(f.calls().attackCalls, 0);
    assert.equal(f.item.system.uses.spent, 1);
    assert.equal(result.state?.continuation, null);
  } finally {
    Object.defineProperty(globalThis, "performance", { configurable: true, value: original });
  }
});
