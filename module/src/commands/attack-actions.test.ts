import assert from "node:assert/strict";
import { test } from "node:test";
import { executeAttack, readAttackState } from "./attack-actions.js";
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
// Node's test runner owns completion of these registered tests.
void test("native bounded roll/apply persists evidence and handles adjustments/temp HP once", async () => {
  const f = fixture();
  const input = request();
  const rolled = await executeAttack(input);
  assert.equal(rolled.outcome, "confirmed");
  assert.equal(rolled.state?.["damageRolled"], 7);
  assert.equal(rolled.state?.["damageApplied"], null);
  assert.deepEqual(f.config().rolls[0].options, {});
  const apply: AttackInput = {
    ...request("apply"),
    action: { mode: "apply", priorAttackRequestId: "r" },
  };
  const applied = await executeAttack(apply);
  assert.equal(applied.outcome, "confirmed");
  assert.equal(applied.state?.["damageApplied"], 3);
  assert.deepEqual(applied.state?.["hpAfter"], { value: 20, temp: 0, max: 20 });
  assert.equal((await executeAttack(apply)).outcome, "confirmed");
  assert.deepEqual(f.calls(), { attackCalls: 1, damageCalls: 1, applyCalls: 1 });
  assert.equal(
    (await executeAttack({ ...request("apply2"), action: apply.action })).outcome,
    "failure",
  );
  assert.equal(
    (
      await executeAttack({
        ...input,
        action: { ...input.action, mode: "roll", advantage: "advantage" } as any,
      })
    ).outcome,
    "failure",
  );
});
void test("miss never rolls or applies damage; critical delegates critical damage option", async () => {
  const miss = fixture({ miss: true });
  assert.equal((await executeAttack(request())).state?.["stage"], "miss");
  assert.equal(miss.calls().damageCalls, 0);
  fixture({ critical: true });
  const result = await executeAttack(request());
  assert.equal(result.state?.["critical"], true);
  assert.equal(result.state?.["damageRolled"], 14);
});
void test("reaction stops before damage; only exact scoped ticket continues", async () => {
  const f = fixture({ reaction: true });
  const rolled = await executeAttack(request());
  assert.equal(rolled.outcome, "decision-required");
  assert.equal(f.calls().damageCalls, 0);
  assert.equal(
    (
      await executeAttack({
        ...request("apply"),
        action: { mode: "apply", priorAttackRequestId: "r" },
      })
    ).outcome,
    "decision-required",
  );
  const ticket = (rolled.state?.["decisions"] as any)[0].id;
  assert.equal(
    (
      await executeAttack({
        ...request("apply"),
        action: { mode: "apply", priorAttackRequestId: "r", decisionId: ticket },
      })
    ).outcome,
    "confirmed",
  );
  assert.equal(f.calls().attackCalls, 1);
});
void test("lost damage result leaves durable attack evidence and fences fresh attacks", async () => {
  const f = fixture({ damageFailure: true });
  const result = await executeAttack(request());
  assert.equal(result.outcome, "uncertain");
  assert.ok(result.state?.["attackRoll"]);
  assert.equal((await executeAttack(request())).outcome, "uncertain");
  assert.equal((await executeAttack(request("r2"))).outcome, "failure");
  assert.equal(f.calls().attackCalls, 1);
});
void test("native cancellation distinct from immune confirmed zero; stale targets and unsupported system fail", async () => {
  fixture({ cancelled: true });
  await executeAttack(request());
  const cancelled = await executeAttack({
    ...request("apply"),
    action: { mode: "apply", priorAttackRequestId: "r" },
  });
  assert.equal(cancelled.outcome, "decision-required");
  assert.equal(cancelled.state?.["stage"], "cancelled");
  const f = fixture({ immune: true });
  await executeAttack(request());
  const immune = await executeAttack({
    ...request("apply"),
    action: { mode: "apply", priorAttackRequestId: "r" },
  });
  assert.equal(immune.outcome, "confirmed");
  assert.equal(immune.state?.["damageApplied"], 0);
  f.target.system.attributes.hp.value = 15;
  assert.equal(
    (
      await executeAttack({
        ...request("apply2"),
        action: { mode: "apply", priorAttackRequestId: "r" },
      })
    ).outcome,
    "failure",
  );
  (globalThis as any).game.system.id = "other";
  assert.equal((await executeAttack(request("r3"))).outcome, "failure");
});
void test("live revocation denies replay; resource usage rejects before roll; bounded state uses identifiers", async () => {
  const f = fixture();
  f.activity.consumption.targets = [{ type: "itemUses" }];
  assert.equal((await executeAttack(request())).outcome, "failure");
  assert.equal(f.calls().attackCalls, 0);
  assert.equal(
    (
      readAttackState({ schemaVersion: "attack-actions-v1", worldId: "w", userId: "gm" })[
        "tokens"
      ] as any
    )[0].attacks[0].activityId,
    "act",
  );
  f.activity.consumption.targets = [];
  await executeAttack(request());
  f.gm.isGM = false;
  assert.equal((await executeAttack(request())).outcome, "failure");
});
