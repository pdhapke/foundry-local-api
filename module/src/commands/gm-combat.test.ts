import assert from "node:assert/strict";
import test from "node:test";
import {
  applyGmCombat,
  readGmCombat,
  assertCombatActivityBudget,
  spendCombatActivityBudget,
  assertCombatMovementBudget,
  spendCombatMovementBudget,
  readHeldSpellState,
  assertHeldSpellReady,
  assertHeldSpellRelease,
  completeHeldSpellReady,
  completeHeldSpellRelease,
} from "./gm-combat.js";
import { runNativeMutation } from "./native-gm-runtime.js";
import type { NativeGmInput, NativeGmReceipt } from "@foundry-local-api/shared";
class Doc {
  actor?: Doc | undefined;
  items = new Map<string, Doc>();
  effects = new Map<string, Doc>();
  combatants = new Map<string, Doc>();
  turns: Doc[] = [];
  uuid: string;
  calls = 0;
  veto = false;
  children = new Map<string, Map<string, Doc>>();
  system?: Record<string, any>;
  concentration?: { effects: Map<string, Doc> };
  constructor(
    readonly id: string,
    public data: Record<string, any>,
  ) {
    this.uuid = `Actor.${id}`;
  }
  toObject() {
    return structuredClone(this.data);
  }
  getEmbeddedCollection(name: string) {
    return this.children.get(name) ?? new Map();
  }
  async update(changes: Record<string, unknown>) {
    this.calls++;
    if (this.veto) return this;
    for (const [key, value] of Object.entries(changes)) {
      const keys = key.split(".");
      let target = this.data;
      for (const part of keys.slice(0, -1)) target = target[part] ??= {};
      target[keys.at(-1)!] = structuredClone(value);
    }
    return this;
  }
  async startCombat() {
    await this.update({ round: 1, turn: 0 });
  }
  async nextTurn() {
    const next = Number(this.data["turn"]) + 1;
    await this.update({
      turn: next >= this.turns.length ? 0 : next,
      round: Number(this.data["round"]) + (next >= this.turns.length ? 1 : 0),
    });
  }
  async rollInitiative(ids: string[], options: { messageMode: string }) {
    this.calls++;
    for (const id of ids) this.combatants.get(id)!.data["initiative"] = 13;
    const c = this.combatants.get(ids[0]!)!;
    const mode = options.messageMode;
    messages.set(
      `message-${messages.size}`,
      new Doc(`message-${messages.size}`, {
        speaker: { actor: c.data["actorId"], token: c.data["tokenId"] },
        whisper: mode === "public" ? [] : ["gm"],
        blind: mode === "blind",
        messageMode: mode,
      }),
    );
  }
  async createEmbeddedDocuments(_type: string, data: Record<string, unknown>[]) {
    const docs = data.map((d) => new Doc(`c-${d["tokenId"]}`, { ...d, initiative: null }));
    for (const d of docs) {
      d.actor = tokens.get(String(d.data["tokenId"]))!.actor;
      this.combatants.set(d.id, d);
    }
    this.turns = [...this.combatants.values()];
    return docs;
  }
  async deleteEmbeddedDocuments(_type: string, ids: string[]) {
    for (const id of ids) this.combatants.delete(id);
    this.turns = [...this.combatants.values()];
  }
  async delete() {
    combats.delete(this.id);
  }
  async endConcentration(effectId: string) {
    this.concentration?.effects.delete(effectId);
    this.effects.delete(effectId);
  }
}
let tokens: Map<string, Doc>;
let combats: Map<string, Doc>;
let journals: Map<string, Doc>;
let messages: Map<string, Doc>;
let sequence = 0;
function fixture() {
  tokens = new Map();
  combats = new Map();
  journals = new Map();
  messages = new Map();
  sequence = 0;
  const gm = { id: "gm", isGM: true, active: true };
  const player = { id: "pc", isGM: false, active: true };
  const scene = new Doc("scene", { active: true, grid: { units: "ft" } });
  scene.children.set("Token", tokens);
  for (const id of ["one", "two"]) {
    const actor = new Doc(id, {
      system: {
        attributes: { movement: { walk: 30, fly: 60, units: "ft" } },
        resources: { legact: { value: 3, max: 3 } },
      },
    });
    const item = new Doc("sword", {
      system: { activities: { swing: { activation: { type: "reaction" } } } },
    });
    item.uuid = `${actor.uuid}.Item.sword`;
    actor.items.set(item.id, item);
    const token = new Doc(id, { actorId: id, x: 0, y: 0, hidden: id === "two" });
    token.actor = actor;
    tokens.set(id, token);
  }
  const combat = new Doc("combat", { scene: "scene", round: 1, turn: 0 });
  for (const token of tokens.values()) {
    const c = new Doc(`c-${token.id}`, {
      tokenId: token.id,
      actorId: token.id,
      initiative: 10,
      hidden: token.data["hidden"],
    });
    c.actor = token.actor;
    combat.combatants.set(c.id, c);
  }
  combat.turns = [...combat.combatants.values()];
  combats.set(combat.id, combat);
  (globalThis as any).game = {
    world: { id: "world" },
    user: gm,
    users: new Map([
      ["gm", gm],
      ["pc", player],
    ]),
    release: { version: "14.368" },
    system: { id: "dnd5e", version: "6.0.3" },
    collections: new Map([
      ["Scene", new Map([[scene.id, scene]])],
      ["Combat", combats],
      ["JournalEntry", journals],
      ["ChatMessage", messages],
    ]),
  };
  (globalThis as any).canvas = { scene };
  (globalThis as any).CONFIG = {
    JournalEntry: {
      documentClass: {
        create: async (data: Record<string, unknown>) => {
          const d = new Doc(`journal-${journals.size}`, data);
          journals.set(d.id, d);
          return d;
        },
      },
    },
    Combat: {
      documentClass: {
        create: async (data: Record<string, any>) => {
          const d = new Doc("created", { ...data, round: 0, turn: null });
          combats.set(d.id, d);
          await d.createEmbeddedDocuments("Combatant", data["combatants"]);
          return d;
        },
      },
    },
  };
  return combat;
}
function input(action: Record<string, unknown>): NativeGmInput {
  return {
    schemaVersion: "gm-actions-v1",
    worldId: "world",
    userId: "gm",
    sceneId: "scene",
    action: { combatId: "combat", ...action },
  };
}
async function apply(
  action: Record<string, unknown>,
  key = `step-${++sequence}`,
): Promise<NativeGmReceipt> {
  const base = input(action);
  return (await applyGmCombat({
    ...base,
    expectedState: readGmCombat(base),
    idempotencyKey: key,
    correlationId: key,
  })) as NativeGmReceipt;
}
async function initialize(id = "c-one") {
  const r = await apply({
    kind: "budget-initialize",
    combatantId: id,
    movementMode: "walk",
    ruling: "Current turn explicitly initialized",
  });
  assert.equal(r.outcome, "confirmed");
}
async function refused(action: Record<string, unknown>): Promise<void> {
  const before = state();
  const receipt = await apply(action);
  assert.equal(receipt.outcome, "failure");
  assert.deepEqual(state(), before);
}
function state(): any {
  return readGmCombat(input({ kind: "read" }));
}
void test("durable budgets survive reread; movement spends once and retries do not duplicate", async () => {
  fixture();
  await initialize();
  const action = input({
    kind: "budget-spend",
    combatantId: "c-one",
    resource: "movement",
    amount: 10,
    ruling: "Native measured ten feet",
  });
  const request = {
    ...action,
    expectedState: readGmCombat(action),
    idempotencyKey: "move",
    correlationId: "move",
  };
  const first = await applyGmCombat(request);
  const repeated = await applyGmCombat(request);
  assert.deepEqual(first, repeated);
  assert.equal(state().ledger.budgets["c-one"].movement, 20);
  assert.equal(
    [...journals.values()].filter((j) => j.data["flags"]?.["foundry-local-api"]?.gmCombatLedger)
      .length,
    1,
  );
});
void test("action budgets cannot overspend; off-turn movement and absent native speed fail before reservation", async () => {
  fixture();
  await initialize();
  await initialize("c-two");
  await refused({
    kind: "budget-spend",
    combatantId: "c-one",
    resource: "action",
    amount: 2,
    ruling: "No resource",
  });
  await refused({
    kind: "budget-spend",
    combatantId: "c-two",
    resource: "movement",
    amount: 1,
    ruling: "Off turn",
  });
  await refused({
    kind: "budget-initialize",
    combatantId: "c-one",
    movementMode: "swim",
    ruling: "Absent speed",
  });
  assert.equal(
    (
      await apply({
        kind: "budget-spend",
        combatantId: "c-one",
        resource: "bonus",
        amount: 1,
        ruling: "Native activity approved",
      })
    ).outcome,
    "confirmed",
  );
});
void test("pending opportunities stop turn progression; accepted reaction spends once, next own turn restores", async () => {
  fixture();
  await initialize();
  await initialize("c-two");
  await apply({
    kind: "interrupt-open",
    combatantId: "c-two",
    choiceId: "op",
    interruptKind: "opportunity",
    trigger: "GM confirmed native reach crossing before movement commit",
  });
  await refused({ kind: "next" });
  await apply({ kind: "interrupt-resolve", choiceId: "op", decision: "accept" });
  assert.equal(state().ledger.budgets["c-two"].reaction, 0);
  await apply({ kind: "next" });
  assert.equal(state().activeCombatantId, "c-two");
  assert.equal(state().ledger.budgets["c-two"].reaction, 1);
});
void test("ready spends action, binds held activity, declines preserve reaction; ready expires before next own turn", async () => {
  fixture();
  await initialize();
  await initialize("c-two");
  await apply({
    kind: "ready",
    combatantId: "c-one",
    choiceId: "hold",
    trigger: "Door opens",
    activityUuid: "Actor.one.Item.sword.Activity.swing",
  });
  assert.equal(state().ledger.budgets["c-one"].action, 0);
  await apply({
    kind: "interrupt-open",
    combatantId: "c-one",
    choiceId: "trigger",
    interruptKind: "ready",
    readyId: "hold",
    trigger: "Door opened",
  });
  assert.equal(state().ledger.interrupts[0].activityUuid, "Actor.one.Item.sword.Activity.swing");
  await refused({
    kind: "interrupt-resolve",
    choiceId: "trigger",
    decision: "accept",
    resolutionReceipt: "fabricated",
  });
  await apply({ kind: "interrupt-resolve", choiceId: "trigger", decision: "decline" });
  assert.equal(state().ledger.budgets["c-one"].reaction, 1);
  await apply({ kind: "next" });
  await apply({ kind: "next" });
  assert.equal(state().ledger.ready[0].status, "expired");
});
void test("unsafe private ownership and stale external turn fail closed; no-op ledger persistence becomes uncertain", async () => {
  const combat = fixture();
  await initialize();
  const ledger = [...journals.values()].find(
    (j) => j.data["flags"]?.["foundry-local-api"]?.gmCombatLedger,
  )!;
  ledger.data["ownership"]["pc"] = 1;
  assert.throws(state, /non-GM ownership/);
  delete ledger.data["ownership"]["pc"];
  await combat.nextTurn();
  await refused({
    kind: "budget-spend",
    combatantId: "c-two",
    resource: "movement",
    amount: 5,
    ruling: "Current",
  });
  await combat.nextTurn();
  await initialize();
  ledger.veto = true;
  const result = await apply({
    kind: "budget-spend",
    combatantId: "c-one",
    resource: "bonus",
    amount: 1,
    ruling: "Approved",
  });
  assert.equal(result.outcome, "uncertain");
  assert.equal(state().ledger.budgets["c-one"].bonus, 1);
});
void test("grouped initiative verifies native participant values rather than requiring chat per combatant", async () => {
  const combat = fixture();
  combat.data["round"] = 0;
  combat.data["turn"] = null;
  const r = await apply({
    kind: "initiative",
    combatantIds: ["c-one", "c-two"],
    rollMode: "gmroll",
  });
  assert.equal(r.outcome, "confirmed");
  assert.equal(messages.size, 1);
  assert.equal([...messages.values()][0]!.data["messageMode"], "gm");
  assert.equal(combat.combatants.get("c-one")!.data["initiative"], 13);
  assert.equal(combat.combatants.get("c-two")!.data["initiative"], 13);
  assert.equal((await apply({ kind: "start" })).outcome, "confirmed");
  assert.equal(state().round, 1);
});
void test("hidden initiative refuses public mode; blind initiative verifies native GM recipients", async () => {
  fixture();
  await refused({ kind: "initiative", combatantIds: ["c-two"], rollMode: "publicroll" });
  assert.equal(messages.size, 0);
  const result = await apply({
    kind: "initiative",
    combatantIds: ["c-one", "c-two"],
    rollMode: "blindroll",
  });
  assert.equal(result.outcome, "confirmed");
  const message = [...messages.values()][0]!;
  assert.deepEqual(message.data["whisper"], ["gm"]);
  assert.equal(message.data["blind"], true);
});
void test("held spell ready refuses unverified cast/release resource semantics before action spend", async () => {
  fixture();
  await initialize();
  tokens.get("one")!.actor!.items.get("sword")!.data["type"] = "spell";
  await refused({
    kind: "ready",
    combatantId: "c-one",
    choiceId: "spell",
    trigger: "Enemy arrives",
    activityUuid: "Actor.one.Item.sword.Activity.swing",
  });
  assert.equal(state().ledger.budgets["c-one"].action, 1);
  assert.equal(state().ledger.ready.length, 0);
});
void test("create from real tokens preserves hidden combatant; scoped roster removes; end verifies deletion", async () => {
  fixture();
  const base: NativeGmInput = {
    ...input({ kind: "read" }),
    action: { kind: "create", tokenIds: ["one", "two"] },
  };
  const receipt = (await applyGmCombat({
    ...base,
    expectedState: readGmCombat(base),
    idempotencyKey: "create",
    correlationId: "create",
  })) as NativeGmReceipt;
  assert.equal(receipt.outcome, "confirmed");
  assert.equal((receipt.after!["combatants"] as any[])[1].hidden, true);
  const remove = input({ kind: "remove-combatants", combatId: "created", combatantIds: ["c-two"] });
  const removed = (await applyGmCombat({
    ...remove,
    expectedState: readGmCombat(remove),
    idempotencyKey: "remove",
    correlationId: "remove",
  })) as NativeGmReceipt;
  assert.equal(removed.outcome, "confirmed");
  assert.equal(combats.get("created")!.combatants.size, 1);
  const ended = await apply({ kind: "end" });
  assert.equal(ended.outcome, "confirmed");
  assert.deepEqual(ended.after, { combatId: "combat", exists: false });
});
void test("invalid scope, forged extra fields, corrupt budgets never mutate", async () => {
  fixture();
  await initialize();
  assert.throws(
    () => readGmCombat({ ...input({ kind: "read" }), userId: "pc" }),
    /active native GM/,
  );
  assert.throws(() => readGmCombat(input({ kind: "read", arbitraryUpdate: {} })), /Unexpected/);
  const doc = [...journals.values()].find(
    (j) => j.data["flags"]?.["foundry-local-api"]?.gmCombatLedger,
  )!;
  doc.data["flags"]["foundry-local-api"].gmCombatLedger.ledger.budgets["c-one"].reaction = -1;
  assert.throws(state, /Corrupt/);
});
void test("native activity spends budget inside same receipt reservation; linked reaction resolution never double-spends", async () => {
  fixture();
  tokens.get("two")!.actor!.items.get("sword")!.data["system"].activities.swing.activation.type =
    "action";
  await initialize();
  await initialize("c-two");
  await apply({
    kind: "interrupt-open",
    combatantId: "c-two",
    choiceId: "reaction",
    interruptKind: "opportunity",
    trigger: "Explicit native reach ruling",
    activityUuid: "Actor.two.Item.sword.Activity.swing",
  });
  const nativeInput = {
    ...input({ kind: "read" }),
    action: { mode: "use", tokenId: "two", actorId: "two", itemId: "sword", activityId: "swing" },
  };
  const read = () => ({ budget: assertCombatActivityBudget(nativeInput, "two", "action") });
  const before = read();
  const request = {
    ...nativeInput,
    expectedState: before,
    idempotencyKey: "react-use",
    correlationId: "react-use",
  };
  let dispatches = 0;
  const readAfter = () => {
    try {
      return read();
    } catch {
      return { budget: null };
    }
  };
  const activate = async () => {
    await spendCombatActivityBudget(request, "two", "action");
    dispatches++;
    return { activityUuid: "Actor.two.Item.sword.Activity.swing" };
  };
  const receipt = await runNativeMutation(request, readAfter, activate, () => {
    assertCombatActivityBudget(nativeInput, "two", "action");
  });
  assert.equal(receipt.outcome, "confirmed");
  assert.equal(dispatches, 1);
  assert.equal(state().ledger.budgets["c-two"].reaction, 0);
  assert.deepEqual(await runNativeMutation(request, readAfter, activate), receipt);
  assert.equal(dispatches, 1);
  await refused({ kind: "interrupt-resolve", choiceId: "reaction", decision: "decline" });
  const resolved = await apply({
    kind: "interrupt-resolve",
    choiceId: "reaction",
    decision: "accept",
    resolutionReceipt: "react-use",
  });
  assert.equal(resolved.outcome, "confirmed");
  assert.equal(state().ledger.budgets["c-two"].reaction, 0);
  assert.equal(state().ledger.interrupts[0].status, "accepted");
});
void test("movement uses explicit terrain cost, rejects unknown/overbudget/stale costs, and persists one spend before move", async () => {
  const combat = fixture();
  await initialize();
  const base = {
    ...input({ kind: "read" }),
    action: {
      kind: "token.move",
      tokenId: "one",
      ruling: "GM verified native terrain measurement in feet",
    },
  };
  assert.throws(() => assertCombatMovementBudget(base, "one", 31), /Insufficient movement/);
  assert.throws(() => assertCombatMovementBudget(base, "one", NaN), /finite native movement cost/);
  assert.throws(
    () =>
      assertCombatMovementBudget(
        { ...base, action: { ...base.action, ruling: undefined } },
        "one",
        5,
      ),
    /terrain ruling/,
  );
  assert.throws(() => assertCombatMovementBudget(base, "two", 5), /native turn/);
  const actor = tokens.get("one")!.actor!;
  actor.data["system"].attributes.movement.units = "m";
  assert.throws(() => assertCombatMovementBudget(base, "one", 5), /units mismatch/);
  actor.data["system"].attributes.movement.units = "ft";
  const read = () => {
    let budget;
    try {
      budget = assertCombatMovementBudget(base, "one", 30);
    } catch {
      budget = null;
    }
    return { x: tokens.get("one")!.data["x"], budget };
  };
  const request = {
    ...base,
    expectedState: read(),
    idempotencyKey: "native-move",
    correlationId: "native-move",
  };
  let moves = 0;
  const move = async () => {
    await spendCombatMovementBudget(request, "one", 30);
    await tokens.get("one")!.update({ x: 100 });
    moves++;
    return { moved: true };
  };
  const result = await runNativeMutation(request, read, move, () => {
    assertCombatMovementBudget(base, "one", 30);
  });
  assert.equal(result.outcome, "confirmed");
  assert.equal(state().ledger.budgets["c-one"].movement, 0);
  assert.equal(moves, 1);
  assert.deepEqual(await runNativeMutation(request, read, move), result);
  assert.equal(moves, 1);
  await combat.nextTurn();
  assert.throws(() => assertCombatMovementBudget(base, "one", 0), /outside this workflow/);
});
async function castHeldSpell(originalConcentration = false) {
  const actor = tokens.get("one")!.actor!;
  const item = actor.items.get("sword")!;
  item.data["type"] = "spell";
  const activity = {
    id: "swing",
    uuid: "Actor.one.Item.sword.Activity.swing",
    activation: { type: "action" },
    duration: { concentration: originalConcentration },
  };
  item.system = { activities: new Map([["swing", activity]]) };
  actor.concentration = { effects: new Map() };
  const base = {
    ...input({ kind: "read" }),
    action: {
      mode: "use",
      phase: "ready",
      tokenId: "one",
      actorId: "one",
      itemId: "sword",
      activityId: "swing",
      spellSlot: "spell1",
      scaling: 0,
      ready: {
        choiceId: "held-spell",
        trigger: "Enemy moves",
        ruling: "One-action ready casting verified",
      },
    },
  };
  const read = () => ({ held: readHeldSpellState(base) });
  const request = {
    ...base,
    expectedState: read(),
    idempotencyKey: "held-cast",
    correlationId: "held-cast",
  };
  const effect = new Doc("held-effect", {
    flags: {
      dnd5e: {
        activity: { uuid: activity.uuid, id: "swing" },
        item: { uuid: item.uuid, type: "spell" },
      },
    },
    origin: item.uuid,
    disabled: false,
  });
  const cast = await runNativeMutation(
    request,
    read,
    async () => {
      await spendCombatActivityBudget(request, "one", "action");
      actor.concentration!.effects.set(effect.id, effect);
      actor.effects.set(effect.id, effect);
      await completeHeldSpellReady(request, effect.id);
      return { activityUuid: activity.uuid, effects: [effect.id] };
    },
    () => assertHeldSpellReady(base),
  );
  assert.equal(cast.outcome, "confirmed");
  return { base, actor, effect, item };
}
void test("held spell binds casting provenance, retained slot/scaling and exact temporary concentration; lost concentration prevents release", async () => {
  fixture();
  await initialize();
  const { actor, effect } = await castHeldSpell();
  assert.equal(state().ledger.budgets["c-one"].action, 0);
  await apply({ kind: "next" });
  await apply({
    kind: "interrupt-open",
    combatantId: "c-one",
    choiceId: "held-trigger",
    interruptKind: "ready",
    readyId: "held-spell",
    trigger: "Verified enemy movement",
  });
  const release = {
    ...input({ kind: "read" }),
    action: {
      mode: "use",
      phase: "release",
      tokenId: "one",
      actorId: "one",
      itemId: "sword",
      activityId: "swing",
      spellSlot: "spell1",
      scaling: 0,
      release: { readyId: "held-spell", castReceipt: "held-cast" },
    },
  };
  const held = await assertHeldSpellRelease(release);
  assert.equal(held["originalConcentration"], false);
  await assert.rejects(
    assertHeldSpellRelease({ ...release, action: { ...release.action, spellSlot: "spell2" } }),
    /slot\/scaling mismatch/,
  );
  await assert.rejects(
    assertHeldSpellRelease({
      ...release,
      action: { ...release.action, release: { readyId: "held-spell", castReceipt: "forged" } },
    }),
    /cast receipt/,
  );
  effect.data["origin"] = "Actor.one.Item.unrelated";
  await assert.rejects(assertHeldSpellRelease(release), /source mismatch/);
  effect.data["origin"] = "Actor.one.Item.sword";
  actor.concentration!.effects.delete(effect.id);
  await assert.rejects(assertHeldSpellRelease(release), /missing, disrupted/);
  actor.concentration!.effects.set(effect.id, effect);
  const read = () => ({ held: readHeldSpellState(release) });
  const request = {
    ...release,
    expectedState: read(),
    idempotencyKey: "held-release",
    correlationId: "held-release",
  };
  const receipt = await runNativeMutation(
    request,
    read,
    async () => {
      await spendCombatActivityBudget(request, "one", "action");
      await completeHeldSpellRelease(request);
      return { activityUuid: "Actor.one.Item.sword.Activity.swing", effects: [] };
    },
    () => assertHeldSpellRelease(release).then(() => undefined),
  );
  assert.equal(receipt.outcome, "confirmed");
  assert.equal(actor.concentration!.effects.has(effect.id), false);
  assert.equal(state().ledger.budgets["c-one"].reaction, 0);
  const resolved = await apply({
    kind: "interrupt-resolve",
    choiceId: "held-trigger",
    decision: "accept",
    resolutionReceipt: "held-release",
  });
  assert.equal(resolved.outcome, "confirmed");
  assert.equal(state().ledger.budgets["c-one"].reaction, 0);
});
void test("held spell expiry clears exact temporary concentration only and never refunds casting", async () => {
  fixture();
  await initialize();
  const { actor, effect } = await castHeldSpell();
  const unrelated = new Doc("other", {
    flags: { dnd5e: { activity: { uuid: "Actor.one.Item.other.Activity.other" } } },
  });
  actor.concentration!.effects.set(unrelated.id, unrelated);
  await apply({ kind: "next" });
  await apply({ kind: "next" });
  assert.equal(actor.concentration!.effects.has(effect.id), false);
  assert.equal(actor.concentration!.effects.has(unrelated.id), true);
  assert.equal(state().ledger.ready[0].status, "expired");
});
void test("held original concentration release requires exact replacement and preserves new native effect", async () => {
  fixture();
  await initialize();
  const { actor, effect } = await castHeldSpell(true);
  await apply({ kind: "next" });
  await apply({
    kind: "interrupt-open",
    combatantId: "c-one",
    choiceId: "held-trigger",
    interruptKind: "ready",
    readyId: "held-spell",
    trigger: "Enemy moved",
  });
  const base = {
    ...input({ kind: "read" }),
    action: {
      mode: "use",
      phase: "release",
      tokenId: "one",
      actorId: "one",
      itemId: "sword",
      activityId: "swing",
      spellSlot: "spell1",
      scaling: 0,
      release: { readyId: "held-spell", castReceipt: "held-cast" },
    },
  };
  const read = () => ({ held: readHeldSpellState(base) });
  const request = {
    ...base,
    expectedState: read(),
    idempotencyKey: "held-conc-release",
    correlationId: "held-conc-release",
  };
  const next = new Doc("released-effect", {
    flags: {
      dnd5e: {
        activity: { uuid: "Actor.one.Item.sword.Activity.swing", id: "swing" },
        item: { uuid: "Actor.one.Item.sword", type: "spell" },
      },
    },
    origin: "Actor.one.Item.sword",
    disabled: false,
  });
  const receipt = await runNativeMutation(
    request,
    read,
    async () => {
      await spendCombatActivityBudget(request, "one", "action");
      await actor.endConcentration(effect.id);
      actor.concentration!.effects.set(next.id, next);
      await completeHeldSpellRelease(request);
      return { activityUuid: "Actor.one.Item.sword.Activity.swing", effects: [next.id] };
    },
    () => assertHeldSpellRelease(base).then(() => undefined),
  );
  assert.equal(receipt.outcome, "confirmed");
  assert.equal(actor.concentration!.effects.has(effect.id), false);
  assert.equal(actor.concentration!.effects.has(next.id), true);
  await apply({
    kind: "interrupt-resolve",
    choiceId: "held-trigger",
    decision: "accept",
    resolutionReceipt: "held-conc-release",
  });
  await apply({ kind: "next" });
  assert.equal(actor.concentration!.effects.has(next.id), true);
});
void test("unobserved native transition cannot reconcile a held spell; explicit expiry cleans it without activating stale budgets", async () => {
  const combat = fixture();
  await initialize();
  const { actor, effect } = await castHeldSpell();
  await combat.nextTurn();
  await combat.nextTurn();
  const staleCursor = state().ledger.cursor;
  const init = {
    kind: "budget-initialize",
    combatantId: "c-one",
    movementMode: "walk",
    ruling: "Explicit reconciliation",
  };
  const refused = await apply(init);
  assert.equal(refused.outcome, "failure");
  assert.equal(actor.concentration!.effects.has(effect.id), true);
  const expired = await apply({ kind: "ready-expire", choiceId: "held-spell" });
  assert.equal(expired.outcome, "confirmed");
  assert.equal(actor.concentration!.effects.has(effect.id), false);
  assert.equal(state().ledger.cursor, staleCursor);
  const reconciled = await apply(init);
  assert.equal(reconciled.outcome, "confirmed");
  assert.notEqual(state().ledger.cursor, staleCursor);
});
void test("native activity binding refuses missing budgets, off-turn action and unrelated pending interruption", async () => {
  fixture();
  const nativeInput = {
    ...input({ kind: "read" }),
    action: { mode: "use", tokenId: "one", actorId: "one", itemId: "sword", activityId: "swing" },
  };
  assert.throws(() => assertCombatActivityBudget(nativeInput, "one", "action"), /initialization/);
  await initialize();
  await initialize("c-two");
  assert.throws(
    () =>
      assertCombatActivityBudget(
        { ...nativeInput, action: { ...nativeInput.action, tokenId: "two" } },
        "two",
        "action",
      ),
    /native turn/,
  );
  await apply({
    kind: "interrupt-open",
    combatantId: "c-two",
    choiceId: "hold",
    interruptKind: "reaction",
    trigger: "Human pending response",
  });
  assert.throws(
    () => assertCombatActivityBudget(nativeInput, "one", "action"),
    /pending interruption/,
  );
});
