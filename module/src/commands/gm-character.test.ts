import assert from "node:assert/strict";
import test from "node:test";
import { gmCharacterRead, gmCharacterApply } from "./gm-character.js";
import type { NativeGmInput } from "@foundry-local-api/shared";

function fixture() {
  const g = globalThis as any;
  let serial = 0;
  const hooks = new Map<number, { event: string; callback: (...args: unknown[]) => void }>();
  g.Hooks = {
    on(event: string, callback: (...args: unknown[]) => void) {
      hooks.set(++serial, { event, callback });
      return serial;
    },
    off(_event: string, id: number) {
      hooks.delete(id);
    },
    callAll(event: string, ...args: unknown[]) {
      for (const h of hooks.values()) if (h.event === event) h.callback(...args);
    },
  };
  const assign = (data: any, patch: any) => {
    for (const [path, value] of Object.entries(patch)) {
      const keys = path.split(".");
      let parent = data;
      for (const key of keys.slice(0, -1)) parent = parent[key] ??= {};
      parent[keys.at(-1)!] = structuredClone(value);
    }
  };
  class Doc {
    system: any;
    effects = new Map<string, Doc>();
    items = new Map<string, Doc>();
    statuses = new Set<string>();
    concentration = { effects: new Set<Doc>() };
    actor?: Doc;
    calls: any[] = [];
    throwAfterDamage = false;
    vetoDamage = false;
    privateMismatch = false;
    vetoPostRoll = false;
    vetoRest = false;
    vetoStable = false;
    constructor(
      readonly id: string,
      public data: any,
    ) {
      this.system = data.system ?? {};
    }
    toObject() {
      return structuredClone(this.data);
    }
    async update(patch: any) {
      this.calls.push({ update: patch });
      assign(this.data, patch);
      this.system = this.data.system ?? {};
      return this;
    }
    getEmbeddedCollection() {
      return new Map([
        ["token", token],
        ["sourcetoken", sourceToken],
      ]);
    }
    testUserPermission(user: any) {
      return user.id === "player";
    }
    async applyDamage(components: any[], options: any) {
      this.calls.push({ components, options });
      if (this.vetoDamage) return this;
      // Native-shaped fixture: the wrapper must pass types, properties and save multiplier untouched.
      const hp = this.system.attributes.hp;
      if (components[0].type === "healing") hp.value = 10;
      else if (components[0].type === "temphp") hp.temp = Math.max(hp.temp, components[0].value);
      else {
        hp.temp = 0;
        hp.value = 6;
      }
      g.Hooks.callAll("dnd5e.applyDamage", this, 2, options);
      if (this.throwAfterDamage) throw Error("transport lost after native spend");
      return this;
    }
    async toggleStatusEffect(id: string, options: any) {
      this.calls.push({ status: id, options });
      if (id === "stable" && this.vetoStable) return;
      if (id === "exhaustion") this.system.conditions.exhaustion += options.levels;
      else if (options.active) {
        this.statuses.add(id);
        if (!this.effects.has(`status-${id}`))
          this.effects.set(
            `status-${id}`,
            new Doc(`status-${id}`, { statuses: [id], disabled: false }),
          );
      } else {
        this.statuses.delete(id);
        this.effects.delete(`status-${id}`);
      }
    }
    async deleteEmbeddedDocuments(_type: string, ids: string[]) {
      this.calls.push({ deleteItems: ids });
      for (const id of ids) this.items.delete(id);
    }
    async endConcentration(id: string) {
      const effect = this.effects.get(id)!;
      this.effects.delete(id);
      this.concentration.effects.delete(effect);
      return [effect];
    }
    async createEmbeddedDocuments(_kind: string, docs: any[]) {
      return docs.map((d) => {
        const doc = new Doc(d._id, d);
        this.items.set(doc.id, doc);
        return doc;
      });
    }
    async shortRest(options: any) {
      this.calls.push({ rest: options });
      if (!this.vetoRest) {
        this.system.spells.spell1.value = 2;
        this.items.get("item")!.system.uses.spent = 0;
        g.Hooks.callAll("dnd5e.restCompleted", this);
      }
      return {
        type: "short",
        updateData: { "system.spells.spell1.value": 2 },
        updateItems: [{ _id: "item", "system.uses.spent": 0 }],
        deleteItems: [],
        deltas: { hitPoints: 0, hitDice: 0 },
      };
    }
    async longRest(options: any) {
      const result = await this.shortRest(options);
      this.system.attributes.hp.value = 10;
      return { ...result, type: "long" };
    }
    async rollSkill(config: any, dialog: any, message: any) {
      return this.roll(config, dialog, message);
    }
    async rollToolCheck(config: any, dialog: any, message: any) {
      return this.roll(config, dialog, message);
    }
    async rollAbilityCheck(config: any, dialog: any, message: any) {
      return this.roll(config, dialog, message);
    }
    async rollSavingThrow(config: any, dialog: any, message: any) {
      return this.roll(config, dialog, message);
    }
    async rollConcentration(config: any, dialog: any, message: any) {
      return this.roll(config, dialog, message);
    }
    async rollDeathSave(config: any, dialog: any, message: any) {
      const rolls = this.roll(config, dialog, message);
      if (!this.vetoPostRoll) {
        if (this.system.attributes.death.success === 2) {
          this.system.attributes.death.success = 0;
          this.system.attributes.death.failure = 0;
          rolls[0]!.parent.system.outcome = "stable";
        } else this.system.attributes.death.success++;
        g.Hooks.callAll("dnd5e.postRollDeathSave", rolls, { subject: this });
      }
      return rolls;
    }
    async rollHitDie(config: any, dialog: any, message: any) {
      const rolls = this.roll(config, dialog, message);
      if (!this.vetoPostRoll) {
        this.system.attributes.hp.value = 10;
        this.system.attributes.hd.spent++;
        g.Hooks.callAll("dnd5e.postRollHitDie", rolls, { subject: this });
      }
      return rolls;
    }
    roll(config: any, dialog: any, message: any) {
      this.calls.push({ config, dialog, message });
      const mode = message.rollMode;
      const doc = new Doc(`message${++serial}`, {
        system: { outcome: null },
        flags: message.data.flags,
        speaker: { scene: "scene", actor: this.id },
        whisper: this.privateMismatch
          ? []
          : mode === "publicroll"
            ? []
            : mode === "selfroll"
              ? ["gm"]
              : ["gm"],
        blind: mode === "blindroll",
      });
      chats.set(doc.id, doc);
      return [
        {
          total: 17,
          formula: "1d20 + 4",
          options: { target: config.target },
          isCritical: false,
          isFumble: false,
          parent: doc,
        },
      ];
    }
  }
  const actor = new Doc("actor", {
    system: {
      attributes: {
        hp: { value: 8, max: 10, temp: 3, tempmax: 0 },
        death: { success: 0, failure: 0 },
        hd: { spent: 0 },
        attunement: { value: 0, max: 3 },
      },
      conditions: { exhaustion: 0 },
      skills: { prc: { passive: 14 } },
      tools: { thief: {} },
      currency: { gp: 3 },
      spells: { spell1: { value: 0, max: 2 } },
      isCharacter: true,
      details: { xp: { value: 100 } },
    },
  });
  const item = new Doc("item", {
    type: "equipment",
    name: "Shield",
    system: {
      quantity: 1,
      equipped: false,
      attunement: "required",
      attuned: false,
      uses: { spent: 1, max: 1 },
    },
  });
  actor.items.set(item.id, item);
  const effect = new Doc("effect", {
    duration: { seconds: 60 },
    flags: { dnd5e: { isConcentration: true } },
  });
  actor.effects.set(effect.id, effect);
  actor.concentration.effects.add(effect);
  const token = new Doc("token", {});
  token.actor = actor;
  const sourceActor = new Doc("sourceActor", { system: structuredClone(actor.system) });
  sourceActor.items.set(
    "sourceitem",
    new Doc("sourceitem", {
      type: "consumable",
      name: "Potion",
      system: { quantity: 3, uses: { spent: 0, max: 1 } },
    }),
  );
  const sourceToken = new Doc("sourcetoken", {});
  sourceToken.actor = sourceActor;
  const scene = new Doc("scene", { active: true });
  const chats = new Map<string, Doc>();
  const journals = new Map<string, Doc>();
  const worldItems = new Map([
    [
      "source",
      new Doc("source", {
        type: "consumable",
        name: "Potion",
        system: { quantity: 1, uses: { spent: 0, max: 1 } },
      }),
    ],
  ]);
  const users = new Map<string, any>([
    ["gm", { id: "gm", active: true, isGM: true }],
    ["player", { id: "player", active: true, isGM: false, character: actor }],
    ["tv", { id: "tv", active: true, isGM: false }],
  ]);
  g.game = {
    version: "14.368",
    release: { version: "14.368" },
    world: { id: "world" },
    system: { id: "dnd5e", version: "6.0.3" },
    user: users.get("gm"),
    users,
    settings: {
      get(_namespace: string, key: string) {
        return key === "restVariant" ? "normal" : false;
      },
    },
    time: { worldTime: 120 },
    collections: new Map([
      ["Scene", new Map([[scene.id, scene]])],
      ["Actor", new Map([[actor.id, actor]])],
      ["ChatMessage", chats],
      ["JournalEntry", journals],
      ["Item", worldItems],
      ["Combat", new Map()],
    ]),
  };
  g.canvas = { scene: { id: "scene" } };
  g.dnd5e = {
    settings: { rulesVersion: "modern" },
    applications: {
      CurrencyManager: {
        async convertCurrency(doc: Doc) {
          doc.calls.push({ nativeCurrencyConversion: true });
          return doc.update({ "system.currency.gp": 4 });
        },
      },
    },
  };
  g.CONFIG = {
    statusEffects: {
      prone: { id: "prone" },
      unconscious: { id: "unconscious" },
      stable: { id: "stable" },
      dead: { id: "dead" },
      exhaustion: { id: "exhaustion", levels: 6 },
    },
    DND5E: {
      damageTypes: { fire: {}, cold: {}, thunder: {} },
      healingTypes: { healing: {}, temphp: {} },
      itemProperties: { mgc: {} },
      skills: { prc: {} },
      tools: { thief: {} },
      abilities: { dex: {}, con: {} },
      conditionTypes: { prone: {}, exhaustion: { levels: 6 } },
      attunementTypes: { required: "Required", optional: "Optional" },
      currencies: { gp: {} },
    },
    JournalEntry: {
      documentClass: {
        async create(data: any) {
          const doc = new Doc("ledger", data);
          journals.set(doc.id, doc);
          return doc;
        },
      },
    },
  };
  function input(action: Record<string, unknown>): NativeGmInput {
    return {
      schemaVersion: "gm-actions-v1",
      worldId: "world",
      userId: "gm",
      sceneId: "scene",
      action: { tokenId: "token", ...action },
    };
  }
  async function invoke(action: Record<string, unknown>, key = "operation") {
    const base = input(action);
    return gmCharacterApply({
      ...base,
      expectedState: gmCharacterRead(base),
      idempotencyKey: key,
      correlationId: key,
    });
  }
  const replacePlacedActor = () => {
    const replacement = new Doc(actor.id, actor.toObject());
    token.actor = replacement;
    return replacement;
  };
  return {
    actor,
    item,
    effect,
    invoke,
    input,
    journals,
    chats,
    hooks,
    users,
    g,
    replacePlacedActor,
    sourceActor,
  };
}
void test("native typed damage passes source types/properties/save half once, replays durable receipt", async () => {
  const f = fixture();
  const base = f.input({
    kind: "actor.damage",
    components: [
      { type: "fire", value: 9, properties: ["mgc"] },
      { type: "cold", value: 20 },
    ],
    multiplier: 0.5,
  });
  const request = {
    ...base,
    expectedState: gmCharacterRead(base),
    idempotencyKey: "damage",
    correlationId: "damage",
  };
  const result = await gmCharacterApply(request);
  assert.equal(result.outcome, "confirmed");
  assert.equal((result.after!.hp as any).value, 6);
  assert.equal(f.actor.calls.length, 1);
  assert.ok(f.actor.calls[0].components[0].properties instanceof Set);
  assert.equal(f.actor.calls[0].options.multiplier, 0.5);
  assert.equal(f.actor.calls[0].options.ignore, undefined);
  assert.deepEqual(await gmCharacterApply(request), result);
  assert.equal(f.actor.calls.length, 1);
  assert.equal(f.hooks.size, 0);
});
void test("native healing and tempHP go through applyDamage without absolute HP setter", async () => {
  const f = fixture();
  await f.invoke(
    { kind: "actor.damage", components: [{ type: "healing", value: 3 }], multiplier: 1 },
    "heal",
  );
  await f.invoke(
    { kind: "actor.damage", components: [{ type: "temphp", value: 7 }], multiplier: 1 },
    "temp",
  );
  assert.equal(f.actor.system.attributes.hp.value, 10);
  assert.equal(f.actor.system.attributes.hp.temp, 7);
  assert.equal(f.actor.calls.filter((c) => c.update).length, 0);
});
void test("damage post hook veto and post-spend exception are uncertain and never replay", async () => {
  for (const mode of ["vetoDamage", "throwAfterDamage"] as const) {
    const f = fixture();
    f.actor[mode] = true;
    const base = f.input({
      kind: "actor.damage",
      components: [{ type: "fire", value: 9 }],
      multiplier: 1,
    });
    const request = {
      ...base,
      expectedState: gmCharacterRead(base),
      idempotencyKey: "damage",
      correlationId: "damage",
    };
    assert.equal((await gmCharacterApply(request)).outcome, "uncertain");
    assert.equal((await gmCharacterApply(request)).outcome, "uncertain");
    assert.equal(f.actor.calls.length, 1);
    assert.equal(f.hooks.size, 0);
  }
});
void test("invalid scope, stale expected state and unknown type never dispatch a native mutation", async () => {
  const f = fixture();
  const base = f.input({
    kind: "actor.damage",
    components: [{ type: "fire", value: 9 }],
    multiplier: 1,
  });
  const expected = gmCharacterRead(base);
  await assert.rejects(
    gmCharacterApply({
      ...base,
      expectedState: { ...expected, hp: {} },
      idempotencyKey: "stale",
      correlationId: "stale",
    }),
    (error: any) => {
      assert.match(error.message, /expected state/);
      assert.equal(error.code, "STALE_REVISION");
      assert.equal(error.details.nativeGmPreflight, "before-reservation-v1");
      assert.equal(error.details.gameplayDispatched, false);
      assert.equal(error.details.idempotencyKey, "stale");
      assert.equal(error.details.correlationId, "stale");
      return true;
    },
  );
  assert.throws(() => gmCharacterRead({ ...base, sceneId: "other" }), /scene/);
  assert.equal(
    (
      await f.invoke({
        kind: "actor.damage",
        components: [{ type: "invented", value: 4 }],
        multiplier: 1,
      })
    ).outcome,
    "failure",
  );
  assert.equal(f.actor.calls.length, 0);
  assert.equal(
    Object.keys(f.journals.get("ledger")!.data.flags["foundry-local-api"].nativeGmReceipts).length,
    0,
  );
});
void test("native checks preserve deliberate privacy, explicit DC and native advantage config", async () => {
  for (const check of ["skill", "tool", "ability", "save"]) {
    const f = fixture();
    const key = check === "skill" ? "prc" : check === "tool" ? "thief" : "dex";
    const result = await f.invoke({
      kind: "actor.check",
      check,
      key,
      dc: 15,
      advantageMode: "advantage",
      rollMode: "blindroll",
    });
    assert.equal(result.outcome, "confirmed");
    assert.equal((result.data as any).total, 17);
    assert.equal(f.actor.calls[0].config.target, 15);
    assert.equal(f.actor.calls[0].config.advantage, true);
    assert.equal(f.actor.calls[0].dialog.configure, false);
  }
});
void test("privacy mismatch after roll is uncertain and cannot duplicate the rolled result", async () => {
  const f = fixture();
  f.actor.privateMismatch = true;
  const base = f.input({
    kind: "actor.check",
    check: "skill",
    key: "prc",
    advantageMode: "normal",
    rollMode: "blindroll",
  });
  const request = {
    ...base,
    expectedState: gmCharacterRead(base),
    idempotencyKey: "roll",
    correlationId: "roll",
  };
  assert.equal((await gmCharacterApply(request)).outcome, "uncertain");
  assert.equal((await gmCharacterApply(request)).outcome, "uncertain");
  assert.equal(f.chats.size, 1);
});
void test("native death/stabilization eligibility rejects healthy actors and terminal native death tracks", async () => {
  const f = fixture();
  assert.equal(
    (
      await f.invoke({
        kind: "actor.check",
        check: "death",
        advantageMode: "normal",
        rollMode: "gmroll",
      })
    ).outcome,
    "failure",
  );
  assert.equal(
    (await f.invoke({ kind: "actor.stabilize", rulingConfirmed: true })).outcome,
    "failure",
  );
  assert.equal(f.actor.calls.length, 0);
  f.actor.system.attributes.hp.value = 0;
  f.actor.system.attributes.death.success = 3;
  assert.equal(
    (
      await f.invoke(
        { kind: "actor.check", check: "death", advantageMode: "normal", rollMode: "gmroll" },
        "already-stable",
      )
    ).outcome,
    "failure",
  );
  assert.equal(f.actor.calls.length, 0);
  f.actor.system.attributes.death.success = 0;
  const result = await f.invoke({
    kind: "actor.check",
    check: "death",
    advantageMode: "normal",
    rollMode: "gmroll",
  });
  assert.equal(result.outcome, "confirmed");
  assert.equal(f.actor.system.attributes.death.success, 1);
});
void test("explicit stabilization persists genuine stable/unconscious effects, native reset counters and no duplicate mutation", async () => {
  const f = fixture();
  f.actor.system.attributes.hp.value = 0;
  f.actor.system.attributes.death = { success: 1, failure: 2 };
  const base = f.input({ kind: "actor.stabilize", rulingConfirmed: true });
  const request = {
    ...base,
    expectedState: gmCharacterRead(base),
    idempotencyKey: "stabilize",
    correlationId: "stabilize",
  };
  const result = await gmCharacterApply(request);
  assert.equal(result.outcome, "confirmed");
  assert.equal((result.data as any).nativeStableStatusVerified, true);
  assert.equal(f.actor.system.attributes.hp.value, 0);
  assert.deepEqual(f.actor.system.attributes.death, { success: 0, failure: 0 });
  assert.ok(f.actor.statuses.has("stable"));
  assert.ok(f.actor.statuses.has("unconscious"));
  assert.deepEqual(f.actor.effects.get("status-stable")!.toObject().statuses, ["stable"]);
  assert.deepEqual(await gmCharacterApply(request), result);
  assert.equal(f.actor.calls.length, 3);
  assert.equal(
    (
      await f.invoke(
        { kind: "actor.check", check: "death", advantageMode: "normal", rollMode: "gmroll" },
        "blocked-save",
      )
    ).outcome,
    "failure",
  );
  assert.equal(f.actor.calls.length, 3);
  await f.invoke({ kind: "actor.condition", conditionId: "stable", active: false }, "destabilize");
  assert.equal(f.actor.statuses.has("stable"), false);
  assert.ok(f.actor.statuses.has("unconscious"));
});
void test("native stable outcome after third death-save success persists the actual stable effect", async () => {
  const f = fixture();
  f.actor.system.attributes.hp.value = 0;
  f.actor.system.attributes.death.success = 2;
  const result = await f.invoke(
    { kind: "actor.check", check: "death", advantageMode: "normal", rollMode: "gmroll" },
    "third-success",
  );
  assert.equal(result.outcome, "confirmed");
  assert.equal((result.data as any).outcome, "stable");
  assert.equal(f.actor.system.attributes.death.success, 0);
  assert.ok(f.actor.statuses.has("stable"));
  assert.ok(f.actor.statuses.has("unconscious"));
});
void test("stabilization partial effect veto is uncertain and never duplicates counter reset or native effects", async () => {
  const f = fixture();
  f.actor.system.attributes.hp.value = 0;
  f.actor.vetoStable = true;
  const base = f.input({ kind: "actor.stabilize", rulingConfirmed: true });
  const request = {
    ...base,
    expectedState: gmCharacterRead(base),
    idempotencyKey: "veto-stable",
    correlationId: "veto-stable",
  };
  const result = await gmCharacterApply(request);
  assert.equal(result.outcome, "uncertain");
  assert.ok(f.actor.statuses.has("unconscious"));
  assert.equal(f.actor.statuses.has("stable"), false);
  assert.deepEqual(await gmCharacterApply(request), result);
  assert.equal(f.actor.calls.length, 3);
});
void test("bounded native attunement XP and temporary maximum HP corrections verify real fields", async () => {
  const f = fixture();
  await f.invoke(
    { kind: "actor.item.attune", itemId: "item", attuned: true, eligibilityConfirmed: true },
    "attune",
  );
  assert.equal(f.item.system.attuned, true);
  await f.invoke({ kind: "actor.xp", value: 250 }, "xp");
  assert.equal(f.actor.system.details.xp.value, 250);
  await f.invoke({ kind: "actor.hp.tempmax", value: -2 }, "maximum");
  assert.equal(f.actor.system.attributes.hp.tempmax, -2);
  assert.equal(f.actor.system.attributes.hp.max, 10);
  assert.equal(f.actor.calls.filter((c) => c.update).length, 2);
});
void test("native actor-item copy and source deletion are separate receipted steps with source expected state", async () => {
  const f = fixture();
  const base = f.input({
    kind: "actor.item.copy",
    sourceTokenId: "sourcetoken",
    sourceItemId: "sourceitem",
    grantItemId: "CopiedPotion0001",
    quantity: 3,
  });
  const request = {
    ...base,
    expectedState: gmCharacterRead(base),
    idempotencyKey: "copy-loot",
    correlationId: "copy-loot",
  };
  assert.ok(request.expectedState.sourceActor);
  const result = await gmCharacterApply(request);
  assert.equal(result.outcome, "confirmed");
  assert.equal((result.data as any).transferPerformed, false);
  assert.equal(f.actor.items.get("CopiedPotion0001")!.system.quantity, 3);
  assert.equal(f.sourceActor.items.get("sourceitem")!.system.quantity, 3);
  assert.deepEqual(await gmCharacterApply(request), result);
  assert.equal(f.actor.items.size, 2);
  const removeBase = {
    ...f.input({ kind: "actor.item.remove", itemId: "sourceitem" }),
    action: { kind: "actor.item.remove", tokenId: "sourcetoken", itemId: "sourceitem" },
  };
  const removed = await gmCharacterApply({
    ...removeBase,
    expectedState: gmCharacterRead(removeBase),
    idempotencyKey: "remove-source",
    correlationId: "remove-source",
  });
  assert.equal(removed.outcome, "confirmed");
  assert.equal(f.sourceActor.items.has("sourceitem"), false);
  assert.equal(f.actor.items.size, 2);
});
void test("concentration remains an explicit decision until exact native effect termination", async () => {
  const f = fixture();
  const result = await f.invoke(
    {
      kind: "actor.check",
      check: "concentration",
      dc: 12,
      advantageMode: "normal",
      rollMode: "gmroll",
    },
    "concentration",
  );
  assert.equal((result.data as any).concentrationDecisionPending, true);
  assert.equal(f.actor.concentration.effects.size, 1);
  await f.invoke({ kind: "actor.concentration.end", effectId: "effect" }, "end");
  assert.equal(f.actor.concentration.effects.size, 0);
});
void test("conditions, native exhaustion levels and duration read back actual embedded effects", async () => {
  const f = fixture();
  await f.invoke({ kind: "actor.condition", conditionId: "prone", active: true }, "condition");
  assert.ok(f.actor.statuses.has("prone"));
  await f.invoke({ kind: "actor.exhaustion", level: 3 }, "exhaustion");
  assert.equal(f.actor.system.conditions.exhaustion, 3);
  assert.equal(
    (await f.invoke({ kind: "actor.exhaustion", level: 7 }, "invalid")).outcome,
    "failure",
  );
  await f.invoke(
    { kind: "actor.effect.duration", effectId: "effect", duration: { seconds: 90 } },
    "duration",
  );
  assert.equal(f.effect.data.duration.startTime, 120);
  assert.equal(
    (
      await f.invoke(
        { kind: "actor.effect.duration", effectId: "effect", duration: { rounds: 1 } },
        "rounds",
      )
    ).outcome,
    "failure",
  );
});
void test("native rests recover item uses/slots and hit dice remain a separate explicit choice", async () => {
  const f = fixture();
  const result = await f.invoke(
    { kind: "actor.rest", restType: "short", eligibilityConfirmed: true },
    "rest",
  );
  assert.equal(result.outcome, "confirmed");
  assert.equal(f.actor.system.spells.spell1.value, 2);
  assert.equal(f.item.system.uses.spent, 0);
  assert.deepEqual(f.actor.calls[0].rest, {
    dialog: false,
    chat: false,
    autoHD: false,
    advanceTime: false,
    advanceBastionTurn: false,
  });
  await f.invoke({ kind: "actor.hitDie", denomination: "d8", rollMode: "gmroll" }, "hitdie");
  assert.equal(f.actor.system.attributes.hd.spent, 1);
  const long = fixture();
  assert.equal(
    (
      await long.invoke(
        { kind: "actor.rest", restType: "long", eligibilityConfirmed: true },
        "long-rest",
      )
    ).outcome,
    "confirmed",
  );
  assert.equal(long.actor.system.attributes.hp.value, 10);
  assert.equal(long.actor.system.spells.spell1.value, 2);
  assert.equal(long.item.system.uses.spent, 0);
});
void test("inventory grants use existing native world items and retain deterministic grant identity", async () => {
  const f = fixture();
  await f.invoke({ kind: "actor.item.equip", itemId: "item", equipped: true }, "equip");
  assert.equal(f.item.system.equipped, true);
  await f.invoke({ kind: "actor.item.quantity", itemId: "item", quantity: 2 }, "quantity");
  assert.equal(f.item.system.quantity, 2);
  const base = f.input({
    kind: "actor.item.grant",
    sourceItemId: "source",
    grantItemId: "NewPotionGrant01",
    quantity: 3,
  });
  const request = {
    ...base,
    expectedState: gmCharacterRead(base),
    idempotencyKey: "grant",
    correlationId: "grant",
  };
  assert.equal((await gmCharacterApply(request)).outcome, "confirmed");
  assert.equal((await gmCharacterApply(request)).outcome, "confirmed");
  assert.equal(f.actor.items.size, 2);
  assert.equal(f.actor.items.get("NewPotionGrant01")!.system.quantity, 3);
  await f.invoke({ kind: "actor.currency", denomination: "gp", value: 8 }, "currency");
  assert.equal(f.actor.system.currency.gp, 8);
});
void test("party uses native assigned characters and ownership, never manufactures a TV or player grant", () => {
  const f = fixture();
  const input = f.input({ kind: "party.roster" });
  delete input.action["tokenId"];
  const result = gmCharacterRead(input);
  assert.deepEqual(
    (result.members as any[]).find((m) => m.userId === "player"),
    { userId: "player", active: true, characterId: "actor", ownedActorIds: ["actor"] },
  );
  assert.deepEqual((result.members as any[]).find((m) => m.userId === "tv").ownedActorIds, []);
  assert.equal(f.actor.calls.length, 0);
  assert.equal((gmCharacterRead(f.input({ kind: "actor.state" })).skills as any).prc.passive, 14);
});
void test("native death/hit-die/rest veto cannot be confirmed from a returned roll or result alone", async () => {
  for (const kind of ["death", "hitDie", "rest"]) {
    const f = fixture();
    f.actor.vetoPostRoll = true;
    f.actor.vetoRest = true;
    if (kind === "death") f.actor.system.attributes.hp.value = 0;
    const action =
      kind === "death"
        ? { kind: "actor.check", check: "death", advantageMode: "normal", rollMode: "gmroll" }
        : kind === "hitDie"
          ? { kind: "actor.hitDie", denomination: "d8", rollMode: "gmroll" }
          : { kind: "actor.rest", restType: "short", eligibilityConfirmed: true };
    const base = f.input(action);
    const request = {
      ...base,
      expectedState: gmCharacterRead(base),
      idempotencyKey: kind,
      correlationId: kind,
    };
    assert.equal((await gmCharacterApply(request)).outcome, "uncertain");
    assert.equal((await gmCharacterApply(request)).outcome, "uncertain");
    assert.equal(f.actor.system.attributes.hd.spent, 0);
    assert.equal(f.actor.system.attributes.death.success, 0);
    assert.equal(f.actor.system.spells.spell1.value, 0);
    assert.equal(f.actor.calls.length, 1);
    assert.equal(f.hooks.size, 0);
  }
});
void test("actor replacement after native completion is uncertain even when the replacement retains the same actor ID", async () => {
  const f = fixture();
  const originalDamage = f.actor.applyDamage.bind(f.actor);
  let replacement: ReturnType<typeof f.replacePlacedActor> | undefined;
  f.actor.applyDamage = async (components, options) => {
    const result = await originalDamage(components, options);
    replacement = f.replacePlacedActor();
    return result;
  };
  const base = f.input({
    kind: "actor.damage",
    components: [{ type: "fire", value: 9 }],
    multiplier: 1,
  });
  const request = {
    ...base,
    expectedState: gmCharacterRead(base),
    idempotencyKey: "reassigned",
    correlationId: "reassigned",
  };
  const result = await gmCharacterApply(request);
  assert.equal(result.outcome, "uncertain");
  assert.equal(result.after, null);
  assert.equal(f.actor.system.attributes.hp.value, 6);
  assert.ok(replacement);
  assert.equal(replacement.id, f.actor.id);
  assert.notEqual(replacement, f.actor);
  assert.equal(replacement.calls.length, 0);
  assert.deepEqual(await gmCharacterApply(request), result);
  assert.equal(f.actor.calls.length, 1);
  assert.equal(f.hooks.size, 0);
});
void test("source item changes during native copy leave an uncertain partial transfer without duplicate target creation", async () => {
  const f = fixture();
  const create = f.actor.createEmbeddedDocuments.bind(f.actor);
  f.actor.createEmbeddedDocuments = async (kind, docs) => {
    const result = await create(kind, docs);
    f.sourceActor.items.get("sourceitem")!.system.quantity = 2;
    return result;
  };
  const base = f.input({
    kind: "actor.item.copy",
    sourceTokenId: "sourcetoken",
    sourceItemId: "sourceitem",
    grantItemId: "CopiedPotion0001",
    quantity: 3,
  });
  const request = {
    ...base,
    expectedState: gmCharacterRead(base),
    idempotencyKey: "copy-changed",
    correlationId: "copy-changed",
  };
  const result = await gmCharacterApply(request);
  assert.equal(result.outcome, "uncertain");
  assert.equal(f.actor.items.size, 2);
  assert.deepEqual(await gmCharacterApply(request), result);
  assert.equal(f.actor.items.size, 2);
  assert.equal(f.sourceActor.items.get("sourceitem")!.system.quantity, 2);
});
void test("native currency conversion delegates configured conversion and replays a receipt without reconverting", async () => {
  const f = fixture();
  const base = f.input({ kind: "actor.currency.convert" });
  const request = {
    ...base,
    expectedState: gmCharacterRead(base),
    idempotencyKey: "native-convert",
    correlationId: "native-convert",
  };
  const result = await gmCharacterApply(request);
  assert.equal(result.outcome, "confirmed");
  assert.equal((result.data as any).nativeCurrencyConversion, true);
  assert.equal(f.actor.system.currency.gp, 4);
  assert.deepEqual(await gmCharacterApply(request), result);
  assert.equal(f.actor.calls.filter((c) => c.nativeCurrencyConversion).length, 1);
});
