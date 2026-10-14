import assert from "node:assert/strict";
import test from "node:test";
import { assertHeldSpellRelease } from "./gm-combat.js";
import { gmActivitiesApply, gmActivitiesRead } from "./gm-activities.js";
import type { GmActivityInput } from "@foundry-local-api/shared";

type Obj = Record<string, any>;
class Doc {
  constructor(
    readonly id: string,
    public data: Obj,
  ) {}
  toObject() {
    return structuredClone(this.data);
  }
  async update(changes: Obj) {
    for (const [path, value] of Object.entries(changes)) {
      const parts = path.split(".");
      let at = this.data;
      for (const part of parts.slice(0, -1)) at = at[part] ??= {};
      at[parts.at(-1)!] = structuredClone(value);
    }
    return this;
  }
}
function fixture(type = "attack") {
  const listeners = new Map<number, { event: string; fn: (...args: any[]) => void }>();
  let next = 0,
    uses = 0,
    attacks = 0,
    damages = 0;
  const hooks = {
    on(event: string, fn: (...args: any[]) => void) {
      listeners.set(++next, { event, fn });
      return next;
    },
    off(_event: string, key: number) {
      listeners.delete(key);
    },
    call() {
      return true;
    },
    callAll(event: string, ...args: any[]) {
      for (const v of listeners.values()) if (event === v.event) v.fn(...args);
    },
  };
  const actor = Object.assign(new Doc("actor", { _stats: { modifiedTime: 1 } }), {
    uuid: "Actor.actor",
    system: {
      attributes: { ac: { value: 14 }, concentration: { limit: 1 } },
      spells: { spell1: { value: 2, level: 1 }, spell3: { value: 1, level: 3 } },
      resources: {},
    },
    items: new Map<string, Obj>(),
    effects: new Map<string, Obj>(),
    concentration: { effects: new Map<string, Obj>() },
  });
  const targetActor = Object.assign(new Doc("victim", { _stats: { modifiedTime: 1 } }), {
    uuid: "Actor.victim",
    system: { attributes: { ac: { value: 14 } } },
  });
  const token = Object.assign(new Doc("source", { x: 0, y: 0, elevation: 0 }), {
    actor,
    uuid: "Scene.scene.Token.source",
  });
  const target = Object.assign(new Doc("target", { x: 100, y: 0, elevation: 0 }), {
    actor: targetActor,
    uuid: "Scene.scene.Token.target",
  });
  const other = Object.assign(new Doc("other", { x: 200, y: 0, elevation: 0 }), {
    actor: targetActor,
  });
  const tokens = new Map<string, Obj>([
    [token.id, token],
    [target.id, target],
    [other.id, other],
  ]);
  const scene = Object.assign(
    new Doc("scene", { active: true, width: 1000, height: 1000, grid: { units: "ft" } }),
    {
      getEmbeddedCollection: () => tokens,
    },
  );
  const item = Object.assign(
    new Doc("item", {
      type: "spell",
      _stats: { modifiedTime: 1 },
      system: { activities: { activity: { activation: { type: "action" } } } },
    }),
    {
      actor,
      uuid: "Actor.actor.Item.item",
      isOwner: true,
      isEmbedded: true,
      system: {
        level: 1,
        quantity: 2,
        uses: { spent: 0, max: 5 },
        activities: new Map<string, Obj>(),
        attackModes: [{ value: "ranged" }],
        ammunitionOptions: [],
        masteryOptions: [],
      },
    },
  );
  const messages = new Map<string, Doc>();
  function messageDoc(messageId: string, config: Obj) {
    const doc = Object.assign(
      new Doc(messageId, {
        flags: config.data.flags,
        whisper: config.rollMode === "publicroll" ? [] : ["gm"],
        blind: config.rollMode === "blindroll",
        speaker: { actor: "actor", scene: "scene" },
        system: {
          ...config.data.system,
          targets:
            config.data.system?.targets ??
            [...(user.targets as Set<Obj>)].map((t) => ({ token: t.uuid })),
        },
      }),
      { flags: config.data.flags },
    );
    if (activity?.badPrivacy) doc.data.whisper = [];
    if (activity?.badTarget) doc.data.system.targets = [{ token: "Scene.scene.Token.other" }];
    if (activity?.badSpeaker) doc.data.speaker.actor = "victim";
    messages.set(messageId, doc);
    return doc;
  }
  const activity: Obj = {
    id: "activity",
    uuid: "Actor.actor.Item.item.Activity.activity",
    item,
    actor,
    type,
    canUse: true,
    requiresSpellSlot: true,
    consumption: { spellSlot: true, targets: [] },
    target: {},
    save: type === "save" ? { ability: ["dex"], dc: { value: 13 } } : null,
    activation: { type: "action" },
    _getAbilityOptions: () => [{ value: "int" }],
    getDamageConfig: () => ({ rolls: [{ options: { types: new Set(["fire"]) } }] }),
    async use(usage: Obj, dialog: Obj, message: Obj) {
      uses++;
      assert.equal(dialog.configure, false);
      assert.equal(usage.subsequentActions, false);
      assert.equal(usage.create, false);
      assert.deepEqual(
        [...(user.targets as Set<Obj>)].map((v) => v.id),
        input.action.targetTokenIds,
      );
      activity.lastUsage = usage;
      if (usage.consume !== false) {
        actor.system.spells[usage.spell.slot as "spell1"].value--;
        item.system.uses.spent++;
      }
      if (activity.cancel) return undefined;
      if (activity.throwAfterSpend) throw Error("Disconnected after spend");
      if (activity.deleteItem) actor.items.delete("item");
      if (activity.loseProfile) activity.availableProfiles = [];
      if (activity.usedScalingActivity) activity.usedActivity = activity.usedScalingActivity;
      if (activity.moveTarget) target.data.x = 999;
      if (activity.switchLevel) (canvas as unknown as Obj).level.id = "other-level";
      if (activity.changeTargets) user.updateTokenTargets(["other"]);
      if (activity.sourceRevisionUpdate) actor.data._stats.modifiedTime++;
      const concentrationEffects: Doc[] = [];
      if (usage.concentration) {
        if (usage.concentration.begin && !activity.vetoBegin) {
          const effect = new Doc(
            activity.numberEffects ? "new-concentration-" + uses : "new-concentration",
            {
              origin: "Actor.actor.Item.item",
              flags: {
                dnd5e: {
                  item: { uuid: "Actor.actor.Item.item", id: "item", type: "spell" },
                  activity: {
                    uuid: "Actor.actor.Item.item.Activity.activity",
                    id: "activity",
                    type,
                  },
                },
              },
            },
          );
          actor.concentration.effects.set(effect.id, effect);
          concentrationEffects.push(effect);
        }
        if (usage.concentration.end && !activity.vetoEnd)
          actor.concentration.effects.delete(usage.concentration.end);
      }
      const result = {
        message: messageDoc(activity.uniqueMessages ? "message-" + uses : "message", message),
        updates: { actor: { spent: 1 } },
        effects: concentrationEffects,
      };
      hooks.callAll("dnd5e.postUseActivity", activity.usedActivity ?? activity, usage, result);
      return result;
    },
    async rollAttack(config: Obj, _dialog: Obj, message: Obj) {
      attacks++;
      assert.equal(config.ability, "int");
      assert.equal(message.rollMode, "gmroll");
      const doc = messageDoc("attack-message", message);
      const ammunition = actor.items.get(config.ammunition);
      if (ammunition) {
        ammunition.system.quantity--;
        if (ammunition.system.quantity === 0) actor.items.delete(ammunition.id);
      }
      return [
        {
          parent: doc,
          formula: "1d20+4",
          total: 18,
          isCritical: activity.critical === true,
          isFumble: false,
          options: {
            advantage: false,
            ability: "int",
            attackMode: "ranged",
            ammunition: config.ammunition,
          },
        },
      ];
    },
    async rollDamage(config: Obj, dialog: Obj, message: Obj) {
      damages++;
      assert.equal(dialog.configure, false);
      activity.damageConfig = config;
      if (activity.cancelDamage) return undefined;
      const doc = messageDoc("damage-message", message);
      return [
        {
          parent: doc,
          formula: config.isCritical ? "2d6+4" : "1d6+4",
          total: config.isCritical ? 14 : 9,
          isCritical: config.isCritical === true,
          options: { type: "fire", isCritical: config.isCritical, properties: new Set(["mgc"]) },
        },
      ];
    },
  };
  item.system.activities.set("activity", activity);
  actor.items.set("item", item);
  const journals = new Map<string, Doc>();
  const combats = new Map<string, Obj>();
  const user: Obj = {
    id: "gm",
    active: true,
    isGM: true,
    targets: new Set([other]),
    updateTokenTargets(ids: string[]) {
      this.targets = new Set(ids.map((v) => tokens.get(v)));
    },
  };
  const game = {
    world: { id: "world" },
    user,
    users: new Map([["gm", user]]),
    release: { version: "14.368" },
    system: { id: "dnd5e", version: "6.0.3" },
    settings: { get: () => false },
    collections: new Map<string, unknown>([
      ["Scene", new Map([["scene", scene]])],
      ["JournalEntry", journals],
      ["ChatMessage", messages],
      ["Combat", combats],
    ]),
  };
  class NativeAttack {
    get evaluatedTargets() {
      const s = this as unknown as Obj;
      return s.targets.map((v: Obj) => ({ isMiss: s.parent.rolls[0].total < v.ac }));
    }
  }
  Object.assign(globalThis, {
    game,
    canvas: { scene, level: { id: "native-level" } },
    Hooks: hooks,
    CONFIG: {
      DND5E: { damageTypes: { fire: {} }, healingTypes: { healing: {} } },
      ChatMessage: { dataModels: { attack: NativeAttack } },
      JournalEntry: {
        documentClass: {
          async create(data: Obj) {
            const doc = new Doc("ledger", data);
            journals.set(doc.id, doc);
            return doc;
          },
        },
      },
    },
  });
  const input: GmActivityInput = {
    schemaVersion: "gm-actions-v1",
    worldId: "world",
    userId: "gm",
    sceneId: "scene",
    action: {
      mode: "use",
      tokenId: "source",
      actorId: "actor",
      itemId: "item",
      activityId: "activity",
      targetTokenIds: ["target"],
      rulesDecisions: [
        {
          targetTokenId: "target",
          decisionId: "ruling",
          edition: "2024",
          range: "in-range",
          reach: "not-applicable",
          lineOfEffect: true,
          cover: "half",
          reason: "GM checked wall and range",
        },
      ],
      advantage: "normal",
      rollMode: "gmroll",
      spellSlot: "spell1",
      ...(type === "attack" ? { attack: { abilityId: "int", attackMode: "ranged" } } : {}),
    },
  };
  const apply = () => ({
    ...input,
    expectedState: gmActivitiesRead(input),
    idempotencyKey: "use-once",
    correlationId: "correlation",
  });
  return {
    input,
    apply,
    actor,
    activity,
    item,
    target,
    user,
    journals,
    game,
    listeners,
    messages,
    combats,
    scene,
    tokens,
    hooks,
    counts: () => ({ uses, attacks }),
    damageCount: () => damages,
  };
}
void test("native activation spends exactly once, rolls once, returns target hit evidence and restores ambient targets", async () => {
  const f = fixture(),
    input = f.apply();
  const first = await gmActivitiesApply(input),
    repeated = await gmActivitiesApply(input);
  assert.equal(first.outcome, "confirmed");
  assert.deepEqual(repeated, first);
  assert.deepEqual(f.counts(), { uses: 1, attacks: 1 });
  assert.equal(f.actor.system.spells.spell1.value, 1);
  assert.equal(f.item.system.uses.spent, 1);
  assert.deepEqual(
    [...(f.user.targets as Set<Obj>)].map((v) => v.id),
    ["other"],
  );
  assert.equal(f.listeners.size, 0);
  assert.equal((first.data as Obj).attack.hit, true);
  assert.equal((first.data as Obj).attack.coverBonus, 2);
});
void test("native cancellation after consumption is uncertain and cannot spend under a new key", async () => {
  const f = fixture();
  f.activity.cancel = true;
  const input = f.apply();
  assert.equal((await gmActivitiesApply(input)).outcome, "uncertain");
  assert.equal((await gmActivitiesApply(input)).outcome, "uncertain");
  await assert.rejects(
    gmActivitiesApply({ ...f.apply(), idempotencyKey: "other-key" }),
    /uncertain/,
  );
  assert.deepEqual(f.counts(), { uses: 1, attacks: 0 });
  assert.equal(f.listeners.size, 0);
  assert.deepEqual(
    [...(f.user.targets as Set<Obj>)].map((v) => v.id),
    ["other"],
  );
});
void test("disconnect after native spend remains uncertain with restored targeting", async () => {
  const f = fixture();
  f.activity.throwAfterSpend = true;
  assert.equal((await gmActivitiesApply(f.apply())).outcome, "uncertain");
  assert.equal(f.actor.system.spells.spell1.value, 1);
  assert.deepEqual(
    [...(f.user.targets as Set<Obj>)].map((v) => v.id),
    ["other"],
  );
});
void test("stale target revision/position refuses before native usage", async () => {
  const f = fixture(),
    input = f.apply();
  f.target.data.x = 300;
  await assert.rejects(gmActivitiesApply(input), /expected state changed/);
  assert.equal(f.counts().uses, 0);
});
void test("template, invalid slot, total cover and unresolved choices fail before reservation", async () => {
  for (const mode of ["template", "slot", "cover", "ability"]) {
    const f = fixture();
    if (mode === "template") f.activity.target = { template: { type: "cone" } };
    if (mode === "slot") f.input.action.spellSlot = "spell9";
    if (mode === "cover") f.input.action.rulesDecisions[0]!.cover = "total";
    if (mode === "ability") f.input.action.attack!.abilityId = "invalid";
    const result = await gmActivitiesApply(f.apply());
    assert.equal(result.outcome, "failure");
    assert.equal((result.data as Obj).decisionRequired, true);
    assert.equal(f.counts().uses, 0);
    assert.deepEqual(
      f.journals.get("ledger")?.data.flags["foundry-local-api"].nativeGmReceipts,
      {},
    );
  }
});
void test("native upcast save activation keeps native DC metadata without inventing saves", async () => {
  const f = fixture("save");
  f.input.action.spellSlot = "spell3";
  f.input.action.scaling = 2;
  const receipt = await gmActivitiesApply(f.apply());
  assert.equal(receipt.outcome, "confirmed");
  assert.equal(f.actor.system.spells.spell3.value, 0);
  assert.equal((receipt.data as Obj).save.dc.value, 13);
  assert.equal(f.counts().attacks, 0);
});
void test("native auto-destroyed item remains observable in terminal receipt and deduplicates", async () => {
  const f = fixture("save");
  f.activity.deleteItem = true;
  const input = f.apply();
  const receipt = await gmActivitiesApply(input);
  assert.equal(receipt.outcome, "confirmed");
  assert.equal(receipt.after?.itemMissing, true);
  assert.equal((await gmActivitiesApply(input)).outcome, "confirmed");
  assert.equal(f.counts().uses, 1);
});
void test("invalid scope, duplicate targets and changed idempotency payload cannot dispatch", async () => {
  const f = fixture();
  assert.throws(() => gmActivitiesRead({ ...f.input, sceneId: "wrong" }), /scene/);
  f.input.action.targetTokenIds.push("target");
  assert.throws(() => gmActivitiesRead(f.input), /Invalid/);
  f.input.action.targetTokenIds.pop();
  const input = f.apply();
  await gmActivitiesApply(input);
  await assert.rejects(
    gmActivitiesApply({ ...input, action: { ...input.action, advantage: "advantage" } }),
    /reused/,
  );
  assert.equal(f.counts().uses, 1);
});
void test("existing concentration never auto-selects a replacement", async () => {
  const f = fixture("save");
  f.activity.requiresConcentration = true;
  f.actor.concentration.effects.set("old", new Doc("old", {}));
  f.input.action.concentration = { begin: true };
  assert.match(String(gmActivitiesRead(f.input).humanRequired), /replacement effect required/);
  assert.equal((await gmActivitiesApply(f.apply())).outcome, "failure");
  assert.equal(f.counts().uses, 0);
});
void test("native message privacy, speaker and target disagreement are uncertain after spend", async () => {
  for (const field of ["badPrivacy", "badTarget", "badSpeaker"]) {
    const f = fixture();
    f.activity[field] = true;
    assert.equal((await gmActivitiesApply(f.apply())).outcome, "uncertain");
    assert.equal(f.counts().uses, 1);
    assert.equal(f.counts().attacks, 0);
    assert.equal(f.listeners.size, 0);
  }
});
void test("explicit cover is not added twice when native target AC already includes cover", async () => {
  const f = fixture();
  const ac = f.target.actor.system.attributes.ac as Obj;
  ac.value = 16;
  ac.cover = 2;
  const receipt = await gmActivitiesApply(f.apply());
  assert.equal(receipt.outcome, "confirmed");
  assert.equal((receipt.data as Obj).attack.targetAC, 16);
  assert.equal((receipt.data as Obj).attack.nativeCover, 2);
});
void test("safe human-required refusal allows a later supported intent without uncertainty fence", async () => {
  const f = fixture();
  f.activity.target = { template: { type: "cone" } };
  assert.equal((await gmActivitiesApply(f.apply())).outcome, "failure");
  f.activity.target = {};
  const result = await gmActivitiesApply({ ...f.apply(), idempotencyKey: "supported" });
  assert.equal(result.outcome, "confirmed");
  assert.equal(f.counts().uses, 1);
});
void test("target movement during native consumption is uncertain and prevents attack dispatch", async () => {
  const f = fixture();
  f.activity.moveTarget = true;
  const receipt = await gmActivitiesApply(f.apply());
  assert.equal(receipt.outcome, "uncertain");
  assert.equal(f.counts().uses, 1);
  assert.equal(f.counts().attacks, 0);
  assert.equal(f.actor.system.spells.spell1.value, 1);
  assert.deepEqual(
    [...(f.user.targets as Set<Obj>)].map((v) => v.id),
    ["other"],
  );
});
void test("direct MCP activity cannot bypass initialized native turn budget and spends it once", async () => {
  const f = fixture();
  const combatant = Object.assign(new Doc("c-source", { tokenId: "source", actorId: "actor" }), {
    actor: f.actor,
  });
  f.combats.set(
    "combat",
    Object.assign(new Doc("combat", { scene: "scene", round: 1, turn: 0 }), {
      combatants: new Map([["c-source", combatant]]),
      turns: [combatant],
    }),
  );
  assert.equal((await gmActivitiesApply(f.apply())).outcome, "failure");
  assert.equal(f.counts().uses, 0);
  const budget = {
    action: 1,
    bonus: 1,
    reaction: 1,
    movement: 30,
    movementBase: 30,
    movementMode: "walk",
    turnKey: "1:0:c-source",
  };
  const journal = new Doc("combat-ledger", {
    ownership: { default: 0 },
    flags: {
      "foundry-local-api": {
        gmCombatLedger: {
          worldId: "world",
          combatId: "combat",
          ledger: {
            version: 1,
            revision: 0,
            cursor: "1:0:c-source",
            budgets: { "c-source": budget },
            ready: [],
            interrupts: [],
            decisions: [],
          },
        },
      },
    },
  });
  f.journals.set(journal.id, journal);
  const input = { ...f.apply(), idempotencyKey: "budgeted" };
  const receipt = await gmActivitiesApply(input);
  assert.equal(receipt.outcome, "confirmed");
  assert.equal(
    journal.data.flags["foundry-local-api"].gmCombatLedger.ledger.budgets["c-source"].action,
    0,
  );
  assert.equal((await gmActivitiesApply(input)).outcome, "confirmed");
  assert.equal(f.counts().uses, 1);
  assert.equal(
    (await gmActivitiesApply({ ...f.apply(), idempotencyKey: "overspend" })).outcome,
    "failure",
  );
  assert.equal(f.counts().uses, 1);
});
void test("native critical-linked typed damage uses original attack options and rolls once across retry", async () => {
  const f = fixture();
  f.activity.critical = true;
  f.input.action.damage = true;
  const input = f.apply();
  const receipt = await gmActivitiesApply(input);
  assert.equal(receipt.outcome, "confirmed");
  assert.equal(f.activity.damageConfig.isCritical, true);
  assert.equal(f.activity.damageConfig.ability, "int");
  assert.equal(f.activity.damageConfig.attackMode, "ranged");
  const component = (receipt.data as Obj).damage[0];
  assert.equal(component.value, 14);
  assert.equal(component.type, "fire");
  assert.equal(component.critical, true);
  assert.deepEqual(component.properties, ["mgc"]);
  assert.equal(component.sourceMessageId, "attack-message");
  assert.equal((await gmActivitiesApply(input)).outcome, "confirmed");
  assert.equal(f.damageCount(), 1);
  assert.deepEqual(f.counts(), { uses: 1, attacks: 1 });
  assert.equal(f.item.system.uses.spent, 1);
});
void test("native damage cancellation cannot reroll or reactivate after resource consumption", async () => {
  const f = fixture();
  f.activity.cancelDamage = true;
  f.input.action.damage = true;
  const input = f.apply();
  assert.equal((await gmActivitiesApply(input)).outcome, "uncertain");
  assert.equal((await gmActivitiesApply(input)).outcome, "uncertain");
  assert.equal(f.damageCount(), 1);
  assert.deepEqual(f.counts(), { uses: 1, attacks: 1 });
  assert.equal(f.actor.system.spells.spell1.value, 1);
});
void test("unresolved native damage type selections refuse before usage", async () => {
  const f = fixture();
  f.input.action.damage = true;
  f.activity.getDamageConfig = () => ({
    rolls: [{ options: { types: new Set(["fire", "cold"]) } }],
  });
  assert.equal((await gmActivitiesApply(f.apply())).outcome, "failure");
  assert.equal(f.counts().uses, 0);
  assert.equal(f.damageCount(), 0);
});
void test("concentration replacement requires maintained native membership before use", async () => {
  const f = fixture("save");
  f.activity.requiresConcentration = true;
  f.actor.effects.set("unrelated", new Doc("unrelated", {}));
  f.input.action.concentration = { begin: true, endEffectId: "unrelated" };
  assert.equal((await gmActivitiesApply(f.apply())).outcome, "failure");
  assert.equal(f.counts().uses, 0);
});
void test("native concentration begin/end veto remains uncertain without reactivating", async () => {
  for (const field of ["vetoBegin", "vetoEnd"]) {
    const f = fixture("save");
    f.activity.requiresConcentration = true;
    f.activity[field] = true;
    const old = new Doc("old-concentration", {});
    f.actor.effects.set(old.id, old);
    f.actor.concentration.effects.set(old.id, old);
    f.input.action.concentration = { begin: true, endEffectId: old.id };
    const input = f.apply();
    assert.equal((await gmActivitiesApply(input)).outcome, "uncertain");
    assert.equal((await gmActivitiesApply(input)).outcome, "uncertain");
    assert.equal(f.counts().uses, 1);
  }
});
void test("damage preserves captured native ammunition data after native attack auto-destroys ammo", async () => {
  const f = fixture();
  f.input.action.damage = true;
  f.input.action.attack!.ammunitionId = "ammo";
  (f.item.system.ammunitionOptions as Obj[]).push({ value: "ammo" });
  const ammo = Object.assign(new Doc("ammo", {}), {
    system: { quantity: 1, magicalBonus: 2, uses: {} },
  });
  f.actor.items.set(ammo.id, ammo);
  const input = f.apply();
  const receipt = await gmActivitiesApply(input);
  assert.equal(receipt.outcome, "confirmed");
  assert.equal(f.actor.items.has("ammo"), false);
  assert.equal(f.activity.damageConfig.ammunition, ammo);
  assert.equal(f.activity.damageConfig.ammunition.system.magicalBonus, 2);
  assert.equal((await gmActivitiesApply(input)).outcome, "confirmed");
  assert.equal(f.damageCount(), 1);
  assert.equal(ammo.system.quantity, 0);
});
void test("target selection changed during native use cannot influence a later attack", async () => {
  const f = fixture();
  f.activity.changeTargets = true;
  assert.equal((await gmActivitiesApply(f.apply())).outcome, "uncertain");
  assert.equal(f.counts().attacks, 0);
  assert.equal(f.counts().uses, 1);
});
void test("self healing tolerates native source resource revision while preserving token binding", async () => {
  const f = fixture("heal");
  f.target.actor = f.actor;
  f.input.action.damage = true;
  f.activity.sourceRevisionUpdate = true;
  const receipt = await gmActivitiesApply(f.apply());
  assert.equal(receipt.outcome, "confirmed");
  assert.equal(f.damageCount(), 1);
  assert.equal(f.counts().uses, 1);
});
function placementFixture(kind: "template" | "summon") {
  const f = fixture(kind === "template" ? "save" : "summon");
  const templates = new Map<string, Obj>();
  let creations = 0,
    countRolls = 0;
  Object.assign(f.scene, {
    grid: { units: "ft", size: 100, distance: 5 },
    getEmbeddedCollection: (name: string) => (name === "Region" ? templates : f.tokens),
    async createEmbeddedDocuments(name: string, data: Obj[]) {
      creations++;
      const map = name === "Region" ? templates : f.tokens;
      return data.map((d, i) => {
        const doc = Object.assign(
          new Doc("created-" + i, { ...structuredClone(d), _id: "created-" + i }),
          {
            uuid: `Scene.scene.${name}.created-${i}`,
            actorLink: false,
            actor: { effects: new Map([["native-summon-effect", {}]]) },
          },
        );
        map.set(doc.id, doc);
        return doc;
      });
    },
  });
  Object.assign(globalThis, {
    foundry: {
      documents: {
        BaseRegion: {
          _migrateMeasuredTemplateData(t: Obj, o: Obj) {
            return {
              shapes: [
                {
                  type: "circle",
                  x: Math.round(t.x),
                  y: Math.round(t.y),
                  radius: (t.distance * o.grid.size) / o.grid.distance,
                },
              ],
              flags: t.flags,
              ownership: { default: 0, [t.author]: 3 },
              levels: [],
              behaviors: [],
              elevation: { bottom: 0, top: null },
              visibility: 0,
            };
          },
        },
      },
    },
  });
  if (kind === "template") {
    f.activity.target = { template: { type: "sphere", count: 1, size: 20, units: "ft" } };
    f.input.action.template = {
      placements: [{ x: 200, y: 300, direction: 90 }],
      ruling: "GM selected explicit geometry; targets resolved separately",
    };
    Object.assign(globalThis, {
      dnd5e: {
        canvas: {
          AbilityTemplate: {
            fromActivity(activity: Obj, p: Obj) {
              const document = new Doc("template", {
                t: "circle",
                author: "gm",
                distance: activity.target.template.size,
                ...p,
                flags: {
                  dnd5e: {
                    origin: activity.uuid,
                    item: activity.item.uuid,
                    spellLevel: 1,
                    dimensions: { size: 20 },
                  },
                },
              });
              Object.assign(document, {
                updateSource(d: Obj) {
                  Object.assign(document.data, d);
                },
              });
              return [{ document }];
            },
          },
        },
      },
    });
  } else {
    const actor = Object.assign(
      new Doc("wolf", {
        ownership: { default: 0, gm: 3 },
        system: { details: { type: { value: "beast" } } },
      }),
      {
        uuid: "Actor.wolf",
        isOwner: true,
        prototypeToken: Object.assign(
          new Doc("prototype", { actorLink: false, actorId: "wolf", width: 1, height: 1 }),
          { actorLink: false, randomImg: false },
        ),
      },
    );
    f.game.collections.set("Actor", new Map([["wolf", actor]]));
    Object.assign(f.activity, {
      canSummon: true,
      summon: { mode: "profile" },
      profiles: [{ _id: "wolves", uuid: "Actor.wolf", count: "1d2" }],
      availableProfiles: [{ _id: "wolves", uuid: "Actor.wolf", count: "1d2" }],
      creatureSizes: new Set(["med"]),
      creatureTypes: new Set(["beast"]),
      getRollData: () => ({ item: { level: 1 } }),
      async getChanges() {
        return {
          actorUpdates: {
            "flags.dnd5e.summon": { origin: f.item.uuid, activity: "activity", profile: "wolves" },
            effects: [{ _id: "native-summon-effect" }],
            items: [],
          },
          tokenUpdates: {},
        };
      },
      async getTokenData(c: Obj) {
        return { actorId: c.actor.id, actorLink: false, ...c.placement, delta: c.actorUpdates };
      },
    });
    (CONFIG as unknown as Obj).DND5E.actorSizes = { med: { token: 1 } };
    Object.assign(globalThis, {
      Roll: class {
        total = 2;
        formula: string;
        constructor(formula: string) {
          this.formula = formula;
        }
        async evaluate() {
          countRolls++;
          return this;
        }
      },
    });
    f.input.action.summon = {
      profileId: "wolves",
      actorId: "wolf",
      creatureSize: "med",
      creatureType: "beast",
      placements: [
        { x: 400, y: 400, elevation: 0, rotation: 0 },
        { x: 500, y: 400, elevation: 0, rotation: 0 },
      ],
      ruling: "GM explicit legal native positions",
    };
  }
  return {
    ...f,
    scene: f.scene as unknown as Obj,
    templates,
    creationCount: () => creations,
    countRolls: () => countRolls,
  };
}
void test("explicit AOE persists native template geometry/origins once without invented saves", async () => {
  const f = placementFixture("template"),
    request = f.apply();
  const result = await gmActivitiesApply(request);
  assert.equal(result.outcome, "confirmed");
  const t = (result.data as Obj).placement.templates[0];
  assert.equal(t.nativeData.shapes[0].type, "circle");
  assert.equal(t.nativeData.shapes[0].radius, 400);
  assert.equal(t.nativeData.shapes[0].x, 200);
  assert.equal(t.nativeData.flags.dnd5e.activity, f.activity.uuid);
  assert.equal(t.nativeData.flags.dnd5e.origin, "Scene.scene.Token.source");
  assert.equal(t.regionId, "created-0");
  assert.equal(
    (gmActivitiesRead(f.input).placement as Obj).existingOutputs[0].sourceFlags.idempotencyKey,
    request.idempotencyKey,
  );
  assert.equal((result.data as Obj).attack, null);
  assert.equal((result.data as Obj).damage, null);
  assert.equal((await gmActivitiesApply(request)).outcome, "confirmed");
  assert.equal(f.creationCount(), 1);
  assert.equal(f.counts().uses, 1);
});
void test("native template veto after cast is uncertain and never duplicates spends or templates", async () => {
  const f = placementFixture("template");
  (globalThis as unknown as Obj).dnd5e.canvas.AbilityTemplate.fromActivity = () => null;
  const request = f.apply();
  assert.equal((await gmActivitiesApply(request)).outcome, "uncertain");
  assert.equal((await gmActivitiesApply(request)).outcome, "uncertain");
  assert.equal(f.creationCount(), 0);
  assert.equal(f.counts().uses, 1);
});
void test("out of scene/modern region behavior templates refuse before spend", async () => {
  for (const behavior of [false, true]) {
    const f = placementFixture("template");
    if (behavior) f.activity.applicableBehaviors = [{ type: "damage" }];
    else f.input.action.template!.placements[0]!.x = 1001;
    assert.equal((await gmActivitiesApply(f.apply())).outcome, "failure");
    assert.equal(f.counts().uses, 0);
  }
});
void test("native summon modifiers/delta/count create exact unlinked tokens once without source security changes", async () => {
  const f = placementFixture("summon"),
    request = f.apply();
  const before = structuredClone(
    (f.game.collections.get("Actor") as Map<string, Doc>).get("wolf")!.toObject(),
  );
  const result = await gmActivitiesApply(request);
  assert.equal(result.outcome, "confirmed");
  const data = (result.data as Obj).placement;
  assert.equal(data.summons.length, 2);
  assert.equal(data.summonCount.total, 2);
  assert.deepEqual(data.summons[0].effectIds, ["native-summon-effect"]);
  assert.equal(data.summons[0].nativeData.delta["flags.dnd5e.summon"].profile, "wolves");
  assert.deepEqual(
    (f.game.collections.get("Actor") as Map<string, Doc>).get("wolf")!.toObject(),
    before,
  );
  assert.equal((await gmActivitiesApply(request)).outcome, "confirmed");
  assert.equal(f.creationCount(), 1);
  assert.equal(f.countRolls(), 1);
  assert.equal(f.counts().uses, 1);
});
void test("linked/non-owned summon source fails before cast; hook permission edits fail uncertain before token creation", async () => {
  for (const choice of ["linked", "ownership", "hook"]) {
    const f = placementFixture("summon"),
      actor = (f.game.collections.get("Actor") as Map<string, Obj>).get("wolf")!;
    if (choice === "linked") actor.prototypeToken.actorLink = true;
    if (choice === "ownership") actor.isOwner = false;
    if (choice === "hook")
      f.activity.getChanges = async () => ({
        actorUpdates: { ownership: { default: 3 } },
        tokenUpdates: {},
      });
    assert.equal(
      (await gmActivitiesApply(f.apply())).outcome,
      choice === "hook" ? "uncertain" : "failure",
    );
    assert.equal(f.creationCount(), 0);
    assert.equal(f.counts().uses, choice === "hook" ? 1 : 0);
  }
});
void test("explicit existing world CR summons use native deterministic query filters without UI/import", async () => {
  for (const cr of [1, 3]) {
    const f = placementFixture("summon"),
      actor = (f.game.collections.get("Actor") as Map<string, Obj>).get("wolf")!;
    actor.data.type = "npc";
    actor.system = { details: { cr, type: { value: "beast" } } };
    f.activity.summon.mode = "cr";
    f.activity.profiles[0].cr = "@item.level+1";
    f.activity.profiles[0].types = new Set(["beast"]);
    Object.assign(globalThis, { dnd5e: { utils: { simplifyBonus: () => 2 } } });
    const result = await gmActivitiesApply(f.apply());
    assert.equal(result.outcome, cr === 1 ? "confirmed" : "failure");
    assert.equal(f.counts().uses, cr === 1 ? 1 : 0);
  }
});
void test("partial native summon creation is uncertain and cannot repeat count/modifiers or resources", async () => {
  const f = placementFixture("summon");
  f.scene.createEmbeddedDocuments = async () => [];
  const request = f.apply();
  assert.equal((await gmActivitiesApply(request)).outcome, "uncertain");
  assert.equal((await gmActivitiesApply(request)).outcome, "uncertain");
  assert.equal(f.countRolls(), 1);
  assert.equal(f.counts().uses, 1);
});
function heldFixture(originalConcentration = false) {
  const f = fixture("save");
  f.activity.duration = { concentration: originalConcentration };
  f.activity.requiresConcentration = originalConcentration;
  f.activity.numberEffects = true;
  f.activity.uniqueMessages = true;
  const combatant = Object.assign(new Doc("c-source", { tokenId: "source" }), { actor: f.actor });
  f.combats.set(
    "combat",
    Object.assign(new Doc("combat", { scene: "scene", round: 1, turn: 0 }), {
      combatants: new Map([["c-source", combatant]]),
      turns: [combatant],
    }),
  );
  const journal = new Doc("combat-ledger", {
    ownership: { default: 0 },
    flags: {
      "foundry-local-api": {
        gmCombatLedger: {
          worldId: "world",
          combatId: "combat",
          ledger: {
            version: 1,
            revision: 0,
            cursor: "1:0:c-source",
            budgets: {
              "c-source": {
                action: 1,
                bonus: 1,
                reaction: 1,
                movement: 30,
                movementBase: 30,
                movementMode: "walk",
                turnKey: "1:0:c-source",
              },
            },
            ready: [],
            interrupts: [],
            decisions: [],
          },
        },
      },
    },
  });
  f.journals.set(journal.id, journal);
  Object.assign(f.item, {
    clone(_updates: Obj) {
      const clone = {
        ...f.item,
        system: {
          ...f.item.system,
          activities: new Map([["activity", { ...f.activity, duration: { concentration: true } }]]),
        },
      };
      return clone;
    },
  });
  Object.assign(f.actor, {
    async endConcentration(effectId: string) {
      f.actor.concentration.effects.delete(effectId);
    },
  });
  f.input.action.phase = "ready";
  f.input.action.ready = {
    choiceId: "held",
    trigger: "Enemy crosses doorway",
    ruling: "GM approved visible ready trigger",
  };
  f.input.action.targetTokenIds = [];
  f.input.action.rulesDecisions = [];
  f.input.action.concentration = { begin: true };
  const ledger = () => journal.data.flags["foundry-local-api"].gmCombatLedger.ledger;
  async function release() {
    const cast = await gmActivitiesApply({ ...f.apply(), idempotencyKey: "cast" });
    assert.equal(cast.outcome, "confirmed");
    ledger().interrupts.push({
      id: "trigger",
      kind: "ready",
      readyId: "held",
      combatantId: "c-source",
      activityUuid: f.activity.uuid,
      status: "pending",
      trigger: "Enemy crosses doorway",
    });
    ledger().revision++;
    delete f.input.action.ready;
    delete f.input.action.concentration;
    f.input.action.phase = "release";
    f.input.action.release = { readyId: "held", castReceipt: "cast" };
    f.input.action.targetTokenIds = ["target"];
    f.input.action.rulesDecisions = [
      {
        targetTokenId: "target",
        decisionId: "release-ruling",
        edition: "2024",
        range: "in-range",
        reach: "not-applicable",
        cover: "none",
        lineOfEffect: true,
        reason: "GM confirmed release targets",
      },
    ];
    return { ...f.apply(), idempotencyKey: "release" };
  }
  return { ...f, ledger, release };
}
void test("native held spell cast spends action/slot once; release spends only reaction and cleans temporary concentration", async () => {
  const f = heldFixture(),
    request = await f.release();
  await assertHeldSpellRelease(request);
  const result = await gmActivitiesApply(request);
  assert.equal(result.outcome, "confirmed");
  assert.equal(f.activity.lastUsage.consume, false);
  assert.equal(f.actor.system.spells.spell1.value, 1);
  assert.equal(f.item.system.uses.spent, 1);
  assert.equal(f.ledger().budgets["c-source"].action, 0);
  assert.equal(f.ledger().budgets["c-source"].reaction, 0);
  assert.equal(f.actor.concentration.effects.size, 0);
  assert.equal(f.activity.duration.concentration, false);
  assert.equal((await gmActivitiesApply(request)).outcome, "confirmed");
  assert.equal(f.counts().uses, 2);
});
void test("original concentration held release replaces exact temporary effect without re-spending slot", async () => {
  const f = heldFixture(true),
    request = await f.release();
  const result = await gmActivitiesApply(request);
  assert.equal(result.outcome, "confirmed");
  assert.equal(f.activity.lastUsage.consume, false);
  assert.equal(f.activity.lastUsage.concentration.begin, true);
  assert.equal(f.activity.lastUsage.concentration.end, "new-concentration-1");
  assert.equal(f.actor.concentration.effects.has("new-concentration-1"), false);
  assert.equal(f.actor.concentration.effects.has("new-concentration-2"), true);
  assert.equal(f.actor.system.spells.spell1.value, 1);
});
void test("held spell edited source rules or lost concentration refuses release without recasting", async () => {
  for (const changed of ["source", "concentration"]) {
    const f = heldFixture(),
      request = await f.release();
    if (changed === "source") f.item.data.system.level = 9;
    else f.actor.concentration.effects.clear();
    request.expectedState = gmActivitiesRead(f.input);
    assert.equal((await gmActivitiesApply(request)).outcome, "failure");
    assert.equal(f.counts().uses, 1);
    assert.equal(f.ledger().budgets["c-source"].reaction, 1);
  }
});
void test("native template length conversion uses ephemeral source clone and preserves original dimensions", async () => {
  const f = placementFixture("template");
  f.activity.target.template.units = "m";
  Object.assign(f.item, {
    clone(updates: Obj) {
      const scaled = {
        ...f.activity,
        target: {
          template: {
            ...f.activity.target.template,
            size: updates["system.activities.activity.target.template.size"],
            units: "ft",
          },
        },
      };
      return {
        ...f.item,
        system: { ...f.item.system, activities: new Map([["activity", scaled]]) },
      };
    },
  });
  const d = (globalThis as unknown as Obj).dnd5e;
  d.utils = {
    convertLength(value: number, from: string, to: string) {
      assert.equal(from, "m");
      assert.equal(to, "ft");
      return value * 3;
    },
  };
  const result = await gmActivitiesApply(f.apply());
  assert.equal(result.outcome, "confirmed");
  assert.equal((result.data as Obj).placement.templates[0].nativeData.shapes[0].radius, 1200);
  assert.equal(f.activity.target.template.size, 20);
  assert.equal(f.activity.target.template.units, "m");
});
void test("malformed held spell native clone refuses before action or slot spend", async () => {
  const f = heldFixture();
  Object.assign(f.item, {
    clone() {
      return {
        ...f.item,
        isEmbedded: false,
        system: {
          ...f.item.system,
          activities: new Map([["activity", { ...f.activity, duration: { concentration: true } }]]),
        },
      };
    },
  });
  assert.equal((await gmActivitiesApply(f.apply())).outcome, "failure");
  assert.equal(f.counts().uses, 0);
  assert.equal(f.ledger().budgets["c-source"].action, 1);
  assert.equal(f.actor.system.spells.spell1.value, 2);
});
void test("held spell cancelled release is uncertain and cannot re-spend reaction or slot", async () => {
  const f = heldFixture(),
    request = await f.release();
  f.activity.cancel = true;
  assert.equal((await gmActivitiesApply(request)).outcome, "uncertain");
  assert.equal((await gmActivitiesApply(request)).outcome, "uncertain");
  assert.equal(f.counts().uses, 2);
  assert.equal(f.ledger().budgets["c-source"].reaction, 0);
  assert.equal(f.actor.system.spells.spell1.value, 1);
  assert.equal(f.actor.concentration.effects.has("new-concentration-1"), true);
});
void test("unavailable native summon profiles refuse before casting; lost used eligibility remains uncertain without placement", async () => {
  for (const stage of ["before", "after"]) {
    const f = placementFixture("summon");
    if (stage === "before") f.activity.availableProfiles = [];
    else f.activity.loseProfile = true;
    const result = await gmActivitiesApply(f.apply());
    assert.equal(result.outcome, stage === "before" ? "failure" : "uncertain");
    assert.equal(f.counts().uses, stage === "before" ? 0 : 1);
    assert.equal(f.creationCount(), 0);
  }
});
void test("upcast summon profile eligibility uses native item scaling preparation and actual used activity", async () => {
  const f = placementFixture("summon");
  f.activity.availableProfiles = [];
  f.input.action.spellSlot = "spell3";
  f.input.action.scaling = 2;
  Object.assign(f.item, {
    clone(updates: Obj) {
      assert.equal(updates["flags.dnd5e.scaling"], 2);
      const scaled = { ...f.activity, availableProfiles: [f.activity.profiles[0]] };
      return {
        ...f.item,
        prepareFinalAttributes() {
          f.activity.usedScalingActivity = scaled;
        },
        system: { ...f.item.system, activities: new Map([["activity", scaled]]) },
      };
    },
  });
  const request = f.apply();
  assert.equal((request.expectedState.placement as Obj).summon.availableProfiles[0]._id, "wolves");
  const result = await gmActivitiesApply(request);
  assert.equal(result.outcome, "confirmed");
  assert.equal(f.actor.system.spells.spell3.value, 0);
  assert.equal(f.creationCount(), 1);
});

void test("native level switch during cast refuses attack/placement after consumption", async () => {
  const f = placementFixture("template");
  f.activity.switchLevel = true;
  const result = await gmActivitiesApply(f.apply());
  assert.equal(result.outcome, "uncertain");
  assert.equal(f.creationCount(), 0);
  assert.equal(f.counts().uses, 1);
});
void test("partial native summon creation retains exact recovery IDs and receipt key without another cast", async () => {
  const f = placementFixture("summon"),
    create = f.scene.createEmbeddedDocuments;
  f.scene.createEmbeddedDocuments = async (name: string, data: Obj[]) =>
    create.call(f.scene, name, data.slice(0, 1));
  const request = f.apply();
  assert.equal((await gmActivitiesApply(request)).outcome, "uncertain");
  const state = gmActivitiesRead(f.input),
    outputs = (state.placement as Obj).existingOutputs;
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].documentName, "Token");
  assert.equal(outputs[0].id, "created-0");
  assert.equal(outputs[0].sourceFlags.idempotencyKey, request.idempotencyKey);
  assert.deepEqual(outputs[0].effectIds, ["native-summon-effect"]);
  assert.equal((await gmActivitiesApply(request)).outcome, "uncertain");
  assert.equal(f.counts().uses, 1);
  assert.equal(f.creationCount(), 1);
});

void test("bounded current native output inventory explicitly declares truncation", () => {
  const f = placementFixture("template");
  for (let i = 0; i < 300; i++)
    f.templates.set(
      "older-" + i,
      new Doc("older-" + i, { flags: { dnd5e: { activity: f.activity.uuid } } }),
    );
  const p = gmActivitiesRead(f.input).placement as Obj;
  assert.equal(p.existingOutputs.length, 256);
  assert.equal(p.outputInventory.complete, false);
  assert.equal(p.outputInventory.matchedCounts.Region, 300);
  assert.equal(p.outputInventory.limitPerKind, 256);
});
