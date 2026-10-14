import assert from "node:assert/strict";
import test from "node:test";
import type { AttackInput, AttackResult } from "@foundry-local-api/shared";
import { executeAttack } from "./attack-actions.js";

type Obj = Record<string, any>;
let serial = 0;
function fixture(options: { total?: number; critical?: boolean; fumble?: boolean; reaction?: boolean; canceledAttack?: boolean; canceledDamage?: boolean; cancelApply?: boolean; adjustment?: number; resource?: boolean; ammo?: boolean } = {}) {
  const state = { rolls: 0, damages: 0, applies: 0, attackConfig: {} as Obj, damageConfig: {} as Obj, appliedDamage: [] as Obj[], hp: { value: 20, temp: 3, max: 20 } };
  const hookMap = new Map<string, Map<number, (...args: any[]) => void>>();
  let hookId = 0;
  const emit = (name: string, ...args: any[]) => { for (const fn of hookMap.get(name)?.values() ?? []) fn(...args); };
  class NativeRoll {
    formula = "1d20+4"; result = "15+4"; options: Obj = {};
    total = options.total ?? 19; isCritical = options.critical ?? false; isFumble = options.fumble ?? false;
    toJSON() { return { total: this.total, isCritical: this.isCritical, isFumble: this.isFumble }; }
    static fromJSON(json: string) { const restored = new NativeRoll(); Object.assign(restored, JSON.parse(json)); return restored; }
  }
  class NativeAttackMessage { parent!: Obj; targets!: Obj[]; get evaluatedTargets() { const roll = this.parent.rolls[0]; if (!(roll instanceof NativeRoll)) return []; return this.targets.map(t => ({ ...t, isMiss: t.ac === null || (!roll.isCritical && (roll.total < t.ac || roll.isFumble)) })); } }
  const activity: Obj = { id: "activity", type: "attack", damage: { parts: [{ types: new Set(["slashing"]) }] }, activation: { type: "action" }, consumption: { targets: options.resource ? [{}] : [] }, getAttackData: () => ({}),
    rollAttack: async (config: Obj) => { state.rolls++; state.attackConfig = config; if (options.ammo) ammunition.system.quantity--; return options.canceledAttack ? null : [new NativeRoll()]; },
    rollDamage: async (config: Obj) => { state.damages++; state.damageConfig = config; return options.canceledDamage ? null : [{ formula: "1d6+2", result: "4+2", total: 6, options: { type: "slashing", properties: new Set(["mgc"]) } }]; } };
  const item: Obj = { id: "item", system: { quantity: 1, activities: new Map([["activity", activity]]), attackModes: [{ value: "oneHanded" }] }, toObject: () => ({ type: "weapon" }) };
  const ammunition = { id: "ammo", system: { quantity: 5, uses: {}, activities: new Map() } };
  if (options.ammo) item.system.ammunitionOptions = [{ value: "ammo" }];
  const attacker: Obj = { id: "actor", system: { attributes: { hp: { value: 20, temp: 0, max: 20 } } }, items: new Map([["item", item]]) };
  if (options.ammo) attacker.items.set("ammo", ammunition);
  const victim: Obj = { id: "victim", system: { attributes: { hp: state.hp, ac: { value: 16 } } }, items: new Map(), applyDamage: async (damage: Obj[], context: Obj) => {
    state.applies++;
    state.appliedDamage = damage;
    if (options.cancelApply) return victim;
    const amount = options.adjustment ?? damage.reduce((n, d) => n + d.value, 0);
    emit("dnd5e.calculateDamage", victim, [{ type: "slashing", value: amount, active: { resistance: amount === 3 } }]);
    const temp = Math.min(amount, state.hp.temp);
    state.hp.temp -= temp; state.hp.value -= amount - temp;
    emit("dnd5e.applyDamage", victim, amount, context);
    return victim;
  } };
  if (options.reaction) victim.items.set("reaction", { id: "reaction", system: { activities: new Map([["reaction", { id: "reaction", activation: { type: "reaction" } }]]) } });
  const tokens = new Map([["source", { id: "source", actor: attacker, toObject: () => ({ name: "Attacker" }) }], ["target", { id: "target", actor: victim, toObject: () => ({ name: "Target" }) }]]);
  const scene = { id: "scene", toObject: () => ({ active: true }), getEmbeddedCollection: () => tokens };
  const journals = new Map<string, Obj>();
  const gm = { id: "gm", isGM: true, active: true };
  Object.assign(globalThis, { game: { world: { id: "world" }, user: gm, users: new Map([["gm", gm]]), system: { id: "dnd5e", version: "6.0.3" }, collections: new Map([["Scene", new Map([["scene", scene]])], ["JournalEntry", journals]]) },
    CONFIG: { DND5E: { damageTypes: { slashing: {} }, abilities: { str: {} } }, Dice: { D20Roll: NativeRoll }, ChatMessage: { dataModels: { attack: NativeAttackMessage } }, JournalEntry: { documentClass: { create: async (data: Obj) => { const doc: Obj = { id: "ledger", toObject: () => structuredClone(data), update: async (changes: Obj) => { data.flags["foundry-local-api"].attackLedger = structuredClone(changes["flags.foundry-local-api.attackLedger"]); } }; journals.set("ledger", doc); return doc; } } } },
    Hooks: { on: (name: string, fn: (...args: any[]) => void) => { const index = ++hookId; if (!hookMap.has(name)) hookMap.set(name, new Map()); hookMap.get(name)!.set(index, fn); return index; }, off: (name: string, index: number) => hookMap.get(name)?.delete(index) } });
  const input: AttackInput = { schemaVersion: "attack-actions-v1", worldId: "world", userId: "gm", requestId: `roll-${++serial}`, correlationId: `correlation-${serial}`, origin: "ai-dm", action: { mode: "roll", sceneId: "scene", attackerTokenId: "source", actorId: "actor", itemId: "item", activityId: "activity", targetTokenId: "target", advantage: "advantage" } };
  if (options.ammo && input.action.mode === "roll") input.action.ammunitionId = "ammo";
  const apply = (decisionId?: string): AttackInput => ({ ...input, requestId: `apply-${++serial}`, correlationId: `correlation-${serial}`, action: { mode: "apply", priorAttackRequestId: input.requestId, ...(decisionId ? { decisionId } : {}) } });
  return { input, state, tokens, victim, item, activity, journals, apply, hooks: hookMap };
}
const resultState = (r: AttackResult) => { assert.ok(r.state); return r.state as Obj; };
void test("independent native hit damage rolling versus application, temp HP and durable duplicate application", async () => {
  const f = fixture({ adjustment: 3 });
  const rolled = await executeAttack(f.input), rs = resultState(rolled);
  assert.equal(rolled.outcome, "confirmed"); assert.equal(rs.damageRolled, 6); assert.equal(rs.damageApplied, null);
  assert.equal(f.state.applies, 0); assert.equal(f.state.hp.value, 20);
  assert.equal(f.state.attackConfig.rolls[0].options.advantage, true);
  assert.deepEqual(Object.keys(rs.source).sort(), ["sceneId", "attackerTokenId", "actorId", "itemId", "activityId", "targetTokenId"].sort());
  const command = f.apply(), applied = await executeAttack(command), as = resultState(applied);
  assert.equal(as.damageApplied, 3); assert.deepEqual(as.hpAfter, { value: 20, temp: 0, max: 20 });
  assert.deepEqual(await executeAttack(command), applied);
  assert.equal((await executeAttack(f.apply())).outcome, "failure");
  assert.equal(f.state.rolls, 1); assert.equal(f.state.damages, 1); assert.equal(f.state.applies, 1);
  assert.equal(f.state.appliedDamage[0]?.type, "slashing");
  assert.ok(f.state.appliedDamage[0]?.properties instanceof Set);
  assert.ok(f.state.appliedDamage[0]?.properties.has("mgc"));
  assert.ok([...f.hooks.values()].every(v => v.size === 0));
});
void test("independent reaction AC change uses persisted native roll reconstruction without reroll or damage", async () => {
  const f = fixture({ reaction: true }), rolled = await executeAttack(f.input), state = resultState(rolled);
  f.victim.system.attributes.ac.value = 30;
  const result = await executeAttack(f.apply(state.decisions[0].id));
  assert.equal(result.outcome, "confirmed"); assert.equal(resultState(result).stage, "miss");
  assert.equal(f.state.rolls, 1); assert.equal(f.state.damages, 0); assert.equal(f.state.applies, 0);
});
void test("independent native ammunition consumption evidence survives duplicate delivery without consuming again", async () => {
  const f = fixture({ ammo: true }), receipt = await executeAttack(f.input), state = resultState(receipt);
  assert.equal(receipt.outcome, "confirmed");
  assert.equal(state.resourcesBefore.find((r: Obj) => r.itemId === "ammo").quantity, 5);
  assert.equal(state.resourcesAfter.find((r: Obj) => r.itemId === "ammo").quantity, 4);
  assert.equal(f.state.attackConfig.ammunition, "ammo");
  await executeAttack(f.input); await executeAttack(f.apply());
  assert.equal(f.state.rolls, 1);
});
void test("independent ledger unsafe ownership, missing ammo choice and ambiguous damage type fail before rolling", async () => {
  const privateLedger = fixture();
  privateLedger.journals.set("ledger", { id: "ledger", toObject: () => ({ flags: { "foundry-local-api": { attackLedgerVersion: "attack-actions-v1", attackLedger: {} } }, ownership: { default: 0, player: 3 } }) });
  assert.equal((await executeAttack(privateLedger.input)).outcome, "failure"); assert.equal(privateLedger.state.rolls, 0);
  const ammo = fixture({ ammo: true }); if (ammo.input.action.mode === "roll") delete ammo.input.action.ammunitionId;
  assert.equal((await executeAttack(ammo.input)).outcome, "failure"); assert.equal(ammo.state.rolls, 0);
  const type = fixture(); type.activity.damage.parts[0].types = new Set(["slashing", "piercing"]);
  assert.equal((await executeAttack(type.input)).outcome, "failure"); assert.equal(type.state.rolls, 0);
  const formulaUses = fixture(); formulaUses.activity.uses = { max: "@prof", spent: 0 };
  assert.equal((await executeAttack(formulaUses.input)).outcome, "failure"); assert.equal(formulaUses.state.rolls, 0);
});
void test("independent native zero adjustment and vulnerability evidence use actual HP rather than rolled damage", async () => {
  for (const amount of [0, 12]) {
    const f = fixture({ adjustment: amount }); await executeAttack(f.input);
    const receipt = await executeAttack(f.apply()), state = resultState(receipt);
    assert.equal(receipt.outcome, "confirmed"); assert.equal(state.damageRolled, 6); assert.equal(state.damageApplied, amount);
    assert.deepEqual(state.hpAfter, amount === 0 ? { value: 20, temp: 3, max: 20 } : { value: 11, temp: 0, max: 20 });
  }
});
void test("independent disadvantage, deleted source and unsupported system are explicit and never fall back", async () => {
  const f = fixture(); if (f.input.action.mode === "roll") f.input.action.advantage = "disadvantage";
  await executeAttack(f.input); assert.equal(f.state.attackConfig.rolls[0].options.disadvantage, true);
  const deleted = fixture(); deleted.tokens.delete("source"); assert.equal((await executeAttack(deleted.input)).outcome, "failure"); assert.equal(deleted.state.rolls, 0);
  const unsupported = fixture(); (globalThis as any).game.system.id = "other";
  assert.equal((await executeAttack(unsupported.input)).outcome, "failure"); assert.equal(unsupported.state.rolls, 0);
});
void test("independent miss fumble and critical delegate native outcome and critical damage flag", async () => {
  for (const options of [{ total: 15 }, { total: 30, fumble: true }, { total: 1, critical: true }]) {
    const f = fixture(options), receipt = await executeAttack(f.input), state = resultState(receipt);
    assert.equal(receipt.outcome, "confirmed");
    assert.equal(state.hit, options.critical === true);
    assert.equal(f.state.damages, options.critical ? 1 : 0);
    if (options.critical) assert.equal(f.state.damageConfig.isCritical, true);
    else assert.deepEqual(state.damageRolls, []);
  }
});
void test("independent reaction stops before damage; unsupported resources stop before attack", async () => {
  const reaction = fixture({ reaction: true }), receipt = await executeAttack(reaction.input), state = resultState(receipt);
  assert.equal(receipt.outcome, "decision-required"); assert.equal(state.decisions.length, 1); assert.equal(reaction.state.damages, 0);
  assert.equal((await executeAttack(reaction.apply())).outcome, "decision-required"); assert.equal(reaction.state.applies, 0);
  const unsupported = fixture({ resource: true }); assert.equal((await executeAttack(unsupported.input)).outcome, "failure"); assert.equal(unsupported.state.rolls, 0);
});
void test("independent canceled rolls and damage fence new IDs, stale targets and native application cancellation", async () => {
  for (const options of [{ canceledAttack: true }, { canceledDamage: true }]) {
    const f = fixture(options), first = await executeAttack(f.input);
    assert.equal(first.outcome, "uncertain"); assert.deepEqual(await executeAttack(f.input), JSON.parse(JSON.stringify(first)));
    assert.equal((await executeAttack({ ...f.input, requestId: "new-roll", correlationId: "new-correlation" })).outcome, "failure");
    assert.equal(f.state.rolls, 1);
  }
  const stale = fixture(); await executeAttack(stale.input); stale.state.hp.value--;
  assert.equal((await executeAttack(stale.apply())).outcome, "failure"); assert.equal(stale.state.applies, 0);
  const deleted = fixture(); await executeAttack(deleted.input); deleted.tokens.delete("target");
  assert.equal((await executeAttack(deleted.apply())).outcome, "failure");
  const changedActor = fixture(); await executeAttack(changedActor.input);
  const token = changedActor.tokens.get("target")!;
  token.actor = { ...changedActor.victim, id: "different-actor" };
  assert.equal((await executeAttack(changedActor.apply())).outcome, "failure");
  assert.equal(changedActor.state.applies, 0);
  const moved = fixture(); await executeAttack(moved.input);
  moved.tokens.get("target")!.toObject = () => ({ name: "Target", x: 100 } as any);
  assert.equal((await executeAttack(moved.apply())).outcome, "failure"); assert.equal(moved.state.applies, 0);
  const changedItem = fixture(); await executeAttack(changedItem.input);
  changedItem.item.toObject = () => ({ type: "weapon", _stats: { modifiedTime: 99 } });
  assert.equal((await executeAttack(changedItem.apply())).outcome, "failure"); assert.equal(changedItem.state.applies, 0);
  const cancel = fixture({ cancelApply: true }); await executeAttack(cancel.input);
  const cancelled = await executeAttack(cancel.apply()); assert.equal(cancelled.outcome, "decision-required"); assert.equal(resultState(cancelled).stage, "cancelled");
  assert.equal((await executeAttack(cancel.apply())).outcome, "failure"); assert.equal(cancel.state.applies, 1);
});
