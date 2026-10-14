import { ATTACK_COMMAND, ATTACK_PROTOCOL, ATTACK_STATE_COMMAND, type AttackInput, type AttackResult,
  type AttackRollAction, type AttackStateInput } from "@foundry-local-api/shared";
import { registerCommand } from "../command-registry.js";
import { inWorldMutationLane } from "../world-mutation-lane.js";

type Obj = Record<string, any>;
type Actor = FoundryDocument & { system: Obj; items: Map<string, Item>; applyDamage(damage: Obj[], options: Obj): Promise<unknown> };
type Item = FoundryDocument & { system: Obj };
type Token = FoundryDocument & { actor?: Actor; uuid?: string };
type Scene = FoundryDocument & { getEmbeddedCollection(type: string): Map<string, Token> };
type Entry = { fingerprint: string; input: AttackInput; pending: boolean; result?: AttackResult; state?: Obj; appliedBy?: string; rollData?: string };
type Ledger = Record<string, Entry>;
const MODULE = "foundry-local-api";
let tail: Promise<unknown> = Promise.resolve();
const obj = (v: unknown): Obj => v && typeof v === "object" ? v as Obj : {};
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function authority(input: AttackStateInput): void {
  if (input.schemaVersion !== ATTACK_PROTOCOL || input.worldId !== game.world.id || input.userId !== game.user.id
    || !game.user.isGM || !game.user.active || !game.users.get(input.userId)?.isGM || !game.users.get(input.userId)?.active)
    throw Error("Exact live GM/world required");
  if (game.system.id !== "dnd5e" || game.system.version !== "6.0.3") throw Error("Reviewed attack API requires dnd5e 6.0.3");
}
function source(input: AttackStateInput, action: AttackRollAction) {
  authority(input);
  const scene = game.collections.get("Scene")?.get(action.sceneId) as Scene | undefined;
  if (!scene || scene.toObject()["active"] !== true) throw Error("Attack requires current active scene");
  const tokens = scene.getEmbeddedCollection("Token");
  const attacker = tokens.get(action.attackerTokenId), target = tokens.get(action.targetTokenId);
  if (!attacker?.actor || attacker.actor.id !== action.actorId || !target?.actor || target === attacker) throw Error("Exact distinct attacker and target tokens required");
  const actor = attacker.actor, item = actor.items?.get(action.itemId);
  const activity = item?.system.activities?.get(action.activityId);
  if (!item || !activity || activity.type !== "attack" || typeof activity.rollAttack !== "function"
    || typeof activity.rollDamage !== "function" || typeof target.actor.applyDamage !== "function") throw Error("Native attack APIs unavailable");
  return { scene, attacker, target, actor, item, activity, victim: target.actor };
}
function hp(actor: Actor) {
  const data = actor.system.attributes?.hp;
  if (!data || ![data.value, data.temp, data.max].every(Number.isFinite)) throw Error("HP unavailable");
  return { value: data.value as number, temp: data.temp as number, max: data.max as number };
}
function position(token: Token): Obj {
  const data = token.toObject();
  return { x: data["x"] ?? null, y: data["y"] ?? null, elevation: data["elevation"] ?? null };
}
function assertBoundTarget(state: Obj, src: ReturnType<typeof source>): void {
  if (state.targetActorId !== src.victim.id || (state.targetActorUuid && state.targetActorUuid !== (src.victim as unknown as Obj).uuid)) throw Error("Target actor changed since attack; reconcile");
  if (!same(state.attackerPosition, position(src.attacker)) || !same(state.targetPosition, position(src.target))) throw Error("Attack positions changed; GM must reconcile target legality");
  const revision = obj(src.item.toObject()["_stats"])["modifiedTime"] ?? null;
  if (state.sourceItemRevision !== revision) throw Error("Attack item changed; reconcile before continuing");
}
function resources(actor: Actor): Obj[] {
  if (actor.items.size > 128) throw Error("Actor resource snapshot exceeds bounded inventory");
  return [...actor.items.values()].map(item => ({ itemId: item.id,
    quantity: item.system.quantity ?? null, uses: { max: item.system.uses?.max ?? null, spent: item.system.uses?.spent ?? null } }));
}
function reactions(actor: Actor): string[] {
  return [...actor.items.values()].flatMap(item => [...(item.system.activities?.values() ?? [])]
    .filter((activity: Obj) => String(activity.activation?.type ?? "").startsWith("reaction"))
    .map((activity: Obj) => `${item.id}:${activity.id}`)).slice(0, 32);
}
function unsupported(activity: Obj, item: Item, resourceWorkflow = false): string[] {
  const issues: string[] = [];
  const hasUses = (value: unknown) => value !== undefined && value !== null && String(value).trim() !== "" && !/^0(?:\.0+)?$/.test(String(value).trim());
  const targets = activity.consumption?.targets ?? [];
  if (!resourceWorkflow && (targets.length || hasUses(activity.uses?.max) || hasUses(item.system.uses?.max))) issues.push("Activity usage/resource consumption requires system use workflow");
  if (item.toObject()["type"] === "spell" || activity.consumption?.spellSlot) issues.push("Spell resource consumption unsupported");
  if (targets.some((t: Obj) => !["itemUses", "activityUses"].includes(t.type) || t.target || !/^\d+$/.test(String(t.value)) || t.scaling?.mode || t.combatOnly)) issues.push("Complex resource consumption unsupported");
  if (targets.length && typeof activity.use !== "function") issues.push("Native resource usage unavailable");
  if (targets.length && ((CONFIG as Obj).DND5E?.activityActivationTypes?.[activity.activation?.type]?.consume
    || (typeof activity.getLinkedActivity === "function" && activity.getLinkedActivity()))) issues.push("Activation or linked resource consumption unsupported");
  if (new Set(targets.map((t: Obj) => t.type)).size !== targets.length) issues.push("Duplicate resource targets unsupported");
  if (!targets.length && (hasUses(activity.uses?.max) || hasUses(activity._source?.uses?.max) || hasUses(item.system.uses?.max)
    || hasUses(obj(item.toObject()["system"])["uses"]?.max))) issues.push("Limited uses without explicit consumption targets unsupported");
  if (activity.canScale || activity.requiresConcentration || activity.target?.template?.type || String(activity.activation?.type ?? "").startsWith("reaction")) issues.push("Scaling, concentration, templates or reaction usage unsupported");
  if (activity.effects?.length || activity.behaviors?.length) issues.push("Activity effects/behaviors require explicit system workflow");
  if ([...(activity.damage?.parts ?? []), item.system.damage?.base, item.system.damage?.versatile].filter(Boolean)
    .some((part: Obj) => (part.types?.size ?? part.types?.length ?? 0) > 1)) issues.push("Damage type choice unresolved");
  if (activity.attack?.type?.value === "ranged" && item.system.range?.long) issues.push("Range/cover adjudication requires explicit supported workflow");
  return issues;
}
async function ledger(): Promise<{ doc: FoundryDocument; entries: Ledger }> {
  const collection = game.collections.get("JournalEntry");
  const docs = collection ? [...collection.values()].filter(doc => obj(obj(doc.toObject()["flags"])[MODULE])["attackLedgerVersion"] === ATTACK_PROTOCOL) : [];
  if (docs.length > 1) throw Error("Ambiguous attack receipt journal");
  let doc = docs[0];
  if (!doc) doc = await CONFIG["JournalEntry"]?.documentClass.create({ name: "Foundry Local API Attack Receipts",
    ownership: { default: 0 }, flags: { [MODULE]: { attackLedgerVersion: ATTACK_PROTOCOL, attackLedger: {} } } });
  if (!doc || obj(doc.toObject()["ownership"])["default"] !== 0) throw Error("Private durable attack ledger unavailable");
  const ownership = obj(doc.toObject()["ownership"]);
  if (Object.entries(ownership).some(([key, value]) => key !== "default" && value !== 0 && !game.users.get(key)?.isGM)) throw Error("Attack ledger permissions unsafe");
  return { doc, entries: structuredClone(obj(obj(doc.toObject()["flags"])[MODULE])["attackLedger"] ?? {}) };
}
async function persist(doc: FoundryDocument, entries: Ledger, input: AttackInput): Promise<void> {
  authority(input);
  const value = JSON.parse(JSON.stringify(entries));
  if (JSON.stringify(value).length > 1_000_000) throw Error("Attack ledger capacity reached");
  await doc.update({ [`flags.${MODULE}.attackLedger`]: value }, { foundryLocalApiOrigin: {
    source: "foundry-local-api.session-action", phase: "apply", correlationId: input.correlationId } });
  if (!same(obj(obj(doc.toObject()["flags"])[MODULE])["attackLedger"], value)) throw Error("Attack ledger acknowledgement unavailable");
}
function rollEvidence(roll: Obj, rollId: string): Obj {
  if (!Number.isFinite(roll.total) || typeof roll.formula !== "string") throw Error("Roll evidence unavailable");
  return { rollId, formula: roll.formula.slice(0, 1000), total: roll.total, result: String(roll.result ?? "").slice(0, 2000),
    isCritical: roll.isCritical === true, isFumble: roll.isFumble === true };
}
function nativeHit(roll: Obj, ac: number): boolean {
  const config = CONFIG as unknown as { ChatMessage?: { dataModels?: { attack?: { prototype: object } } } };
  const getter = config.ChatMessage?.dataModels?.attack && Object.getOwnPropertyDescriptor(config.ChatMessage.dataModels.attack.prototype, "evaluatedTargets")?.get;
  if (!getter) throw Error("Native target hit evaluator unavailable");
  const targets = getter.call({ parent: { rolls: [roll] }, targets: [{ ac }] });
  if (targets?.length !== 1 || typeof targets[0].isMiss !== "boolean") throw Error("Native target outcome unavailable");
  return !targets[0].isMiss;
}
function choices(action: AttackRollAction, activity: Obj, item: Item): void {
  const abilities = activity._getAbilityOptions?.() ?? [];
  if (abilities.length > 1 && !action.abilityId) throw Error("Ability choice required");
  if (action.abilityId && abilities.length && !abilities.some((ability: Obj) => ability.value === action.abilityId)) throw Error("Invalid activity ability choice");
  if ((item.system.masteryOptions?.length ?? 0) > 0) throw Error("Weapon mastery choice/effect requires native interactive workflow");
  const modes = item.system.attackModes ?? [];
  if (modes.length > 1 && !action.attackMode) throw Error("Attack mode choice required");
  if (action.attackMode && !modes.some((mode: Obj) => mode.value === action.attackMode)) throw Error("Invalid attack mode");
  const ammunition = item.system.ammunitionOptions ?? [];
  if (ammunition.length && !action.ammunitionId) throw Error("Ammunition choice required");
  if (action.ammunitionId && !ammunition.some((ammo: Obj) => ammo.value === action.ammunitionId && !ammo.disabled)) throw Error("Invalid or depleted ammunition");
  if (Number(item.system.quantity) <= 0) throw Error("Item quantity unavailable");
  if (action.abilityId && !Object.hasOwn(obj((CONFIG as Obj).DND5E?.abilities), action.abilityId)) throw Error("Invalid ability");
  const configured = activity.getAttackData?.({ ability: action.abilityId, ammunition: action.ammunitionId, attackMode: action.attackMode });
  if (!configured) throw Error("Native attack data unavailable");
  const damageConfiguration = activity.getDamageConfig?.({ ability: action.abilityId, ammunition: action.ammunitionId, attackMode: action.attackMode });
  if (damageConfiguration?.rolls?.some((roll: Obj) => (roll.options?.types?.length ?? roll.options?.types?.size ?? 0) > 1)) throw Error("Native damage type choice unresolved");
}
async function withOrigins<T>(src: ReturnType<typeof source>, input: AttackInput, work: () => Promise<T>): Promise<T> {
  const api = Hooks as unknown as { on(name: string, fn: (...args: any[]) => void): number; off(name: string, id: number): void };
  const annotate = (doc: unknown, _changes: unknown, options: Obj) => {
    if (doc !== src.actor && doc !== src.victim && ![...src.actor.items.values()].includes(doc as Item)) return;
    options.correlationId = input.correlationId;
    options.foundryLocalApiOrigin = { source: "foundry-local-api.session-action", phase: "apply", correlationId: input.correlationId };
  };
  const actorHook = api.on("preUpdateActor", annotate), itemHook = api.on("preUpdateItem", annotate);
  try { return await work(); } finally { api.off("preUpdateActor", actorHook); api.off("preUpdateItem", itemHook); }
}
async function damage(state: Obj, src: ReturnType<typeof source>, input: AttackInput, save: () => Promise<void>): Promise<void> {
  if (state.damageRolls?.length) return;
  authority(input);
  const raw = await withOrigins(src, input, () => src.activity.rollDamage({ isCritical: state.critical, attackMode: state.attackMode, ability: state.abilityId,
    ammunition: state.ammunitionId }, { configure: false }, { create: false }));
  if (!Array.isArray(raw) || !raw.length || raw.length > 16) throw Error("Damage roll cancelled or unavailable; do not reroll");
  const types = obj((CONFIG as Obj).DND5E?.damageTypes);
  state.damageRolls = raw.map((roll: Obj, index: number) => {
    const evidence = rollEvidence(roll, `${state.attackRequestId}:damage:${index}`);
    if (typeof roll.options?.type !== "string" || !Object.hasOwn(types, roll.options.type)) throw Error("Damage type unavailable");
    return { ...evidence, type: roll.options.type, properties: [...(roll.options.properties ?? [])], total: Math.max(0, roll.total) };
  });
  state.damageRolled = state.damageRolls.reduce((total: number, roll: Obj) => total + roll.total, 0);
  state.stage = "damage-rolled"; state.resourcesAfter = resources(src.actor);
  state.sourceItemRevision = obj(src.item.toObject()["_stats"])["modifiedTime"] ?? null;
  await save();
}
export function executeAttack(input: AttackInput, deadline = Infinity, resourceWorkflow = false): Promise<AttackResult> {
  const run = () => perform(input, deadline, resourceWorkflow);
  const result = tail.then(run); tail = result.catch(() => undefined); return result;
}
async function perform(input: AttackInput, deadline: number, resourceWorkflow: boolean): Promise<AttackResult> {
  const base = { schemaVersion: ATTACK_PROTOCOL, worldId: input.worldId, userId: input.userId,
    requestId: input.requestId, correlationId: input.correlationId, action: input.action, mutated: false, state: null };
  const failure = (message: string): AttackResult => ({ ...base, outcome: "failure", message });
  let data: Awaited<ReturnType<typeof ledger>> | undefined, entry: Entry | undefined, dispatched = false;
  try {
    authority(input);
    if (input.origin !== "ai-dm" || !id(input.requestId) || !id(input.correlationId)) return failure("Invalid attack protocol");
    data = await ledger();
    const key = `${input.userId}:${input.requestId}`;
    const prior = data.entries[key];
    if (prior) {
      if (!same(prior.input, input)) return failure("Attack request ID arguments changed");
      return prior.result ?? { ...base, outcome: "uncertain", mutated: true, state: prior.state ?? null, message: "Pending attack may have executed; reconcile without retry" };
    }
    if (Object.values(data.entries).some(value => value.pending)) return failure("Prior attack is pending; reconcile before further attacks");
    if (Object.keys(data.entries).length >= 256) return failure("Attack receipt capacity reached; archive after reconciliation");
    const rollAction = input.action.mode === "roll" ? input.action : data.entries[`${input.userId}:${input.action.priorAttackRequestId}`]?.input.action;
    if (!rollAction || rollAction.mode !== "roll") return failure("Prior scoped attack missing");
    const src = source(input, rollAction);
    const priorEntry = input.action.mode === "apply" ? data.entries[`${input.userId}:${input.action.priorAttackRequestId}`] : undefined;
    if (priorEntry?.appliedBy) return failure("Damage already claimed; do not apply again");
    let state: Obj;
    if (input.action.mode === "roll") {
      const unsupportedReasons = unsupported(src.activity, src.item, resourceWorkflow);
      if (unsupportedReasons.length) return failure(unsupportedReasons.join("; "));
      choices(rollAction, src.activity, src.item);
      const ac = src.victim.system.attributes?.ac?.value;
      if (!Number.isFinite(ac)) return failure("Target AC unavailable; adjudicate target");
      state = { systemId: "dnd5e", systemVersion: game.system.version, attackRequestId: input.requestId,
        source: { sceneId: rollAction.sceneId, attackerTokenId: rollAction.attackerTokenId, actorId: rollAction.actorId, itemId: rollAction.itemId,
          activityId: rollAction.activityId, targetTokenId: rollAction.targetTokenId }, hpBefore: hp(src.victim), hpAfter: null, damageApplied: null, targetAC: ac,
        targetActorId: src.victim.id, targetActorUuid: (src.victim as unknown as Obj).uuid ?? null,
        attackerPosition: position(src.attacker), targetPosition: position(src.target),
        sourceItemRevision: obj(src.item.toObject()["_stats"])["modifiedTime"] ?? null,
        rulesLimitations: ["Target legality, reach/range, cover and attack paths require GM adjudication; native rollAttack does not enforce them."],
        resourcesBefore: resources(src.actor), attackRoll: null, hit: null, critical: false, damageRolls: [], damageRolled: 0, attackMode: rollAction.attackMode,
        ammunitionId: rollAction.ammunitionId, abilityId: rollAction.abilityId, decisions: [] };
    } else {
      if (!priorEntry?.result || !["confirmed", "decision-required"].includes(priorEntry.result.outcome)) return failure("Prior attack not usable");
      const priorState = priorEntry.state ?? priorEntry.result.state;
      if (!priorState) return failure("Prior attack evidence unavailable");
      state = structuredClone(priorState);
      assertBoundTarget(state, src);
      if (!state?.hit) return failure("Prior attack did not hit");
      if (!same(hp(src.victim), state.hpBefore)) return failure("Target HP changed since attack; reconcile before application");
      if (state.decisions?.length && input.action.decisionId !== state.decisions[0].id) return { ...base, outcome: "decision-required", state, message: "Explicit authenticated GM decision ticket required" };
      const ac = src.victim.system.attributes?.ac?.value;
      if (!Number.isFinite(ac)) return failure("Target AC unavailable");
      if (ac !== state.targetAC) {
        const rollClass = (CONFIG as Obj).Dice?.D20Roll;
        if (!priorEntry.rollData || typeof rollClass?.fromJSON !== "function") return failure("Target AC changed; native persisted roll reconstruction unavailable");
        state.hit = nativeHit(rollClass.fromJSON(priorEntry.rollData), ac);
        state.targetAC = ac;
      }
      state.decisions = [];
    }
    entry = { fingerprint: JSON.stringify(input), input, pending: true, state };
    data.entries[key] = entry;
    const save = () => persist(data!.doc, data!.entries, input);
    if (priorEntry) priorEntry.appliedBy = input.requestId;
    await save(); // Durable claim precedes rolls, ammunition consumption and damage application.
    authority(input);
    const afterClaim = source(input, rollAction);
    if (afterClaim.victim !== src.victim || afterClaim.actor !== src.actor || afterClaim.item !== src.item) throw Error("Attack documents changed during durable claim");
    assertBoundTarget(state, afterClaim);
    if (!same(hp(src.victim), state.hpBefore)) throw Error("Target HP changed during durable claim");
    dispatched = true;
    if (input.action.mode === "roll") {
      if (performance.now() >= deadline) throw Error("Admission budget exhausted before usage");
      const targets = src.activity.consumption?.targets ?? [];
      if (targets.length) {
        const before = targets.map((t: Obj) => ({ type: t.type, spent: Number(t.type === "activityUses" ? src.activity.uses?.spent : src.item.system.uses?.spent), cost: Number(t.value) }));
        if (before.some((v: Obj) => !Number.isFinite(v.spent) || !Number.isSafeInteger(v.cost))) throw Error("Resource snapshot unavailable");
        state.resourceConsumption = { before, after: null, verified: false };
        state.stage = "resource-consumption-pending"; await save(); authority(input);
        const used = await withOrigins(src, input, () => src.activity.use({ subsequentActions: false, create: false }, { configure: false }, { create: false }));
        const after = targets.map((t: Obj) => Number(t.type === "activityUses" ? src.activity.uses?.spent : src.item.system.uses?.spent));
        state.resourceConsumption.after = after;
        if (!used || after.some((value: number, index: number) => value !== before[index].spent + before[index].cost)) throw Error("Native usage consumption unconfirmed; reconcile without retry");
        const updates = (used as Obj).updates;
        if (!updates || updates.create?.length || updates.delete?.length) throw Error("Unsupported native usage document effects; reconcile without retry");
        const readPath = (value: Obj, path: string) => path.split(".").reduce((current: any, key: string) => current instanceof Map ? current.get(key) : current?.[key], value);
        for (const [path, value] of Object.entries(updates.actor ?? {})) if (!same(readPath(src.actor as unknown as Obj, path), value)) throw Error("Native activation resource readback mismatch");
        for (const update of updates.item ?? []) {
          const item = src.actor.items.get(update._id);
          if (!item) throw Error("Native resource item removed");
          for (const [path, value] of Object.entries(update)) if (path !== "_id" && !same(readPath(item as unknown as Obj, path), value)) throw Error("Native item resource readback mismatch");
        }
        // Foundry expands dotted object keys recursively during document updates.
        // Keep update paths as string values so durable evidence survives that normalization.
        const evidenceChanges = (changes: Obj) => Object.entries(changes).map(([path, value]) => ({ path, value: structuredClone(value) }));
        state.resourceConsumption.nativeUpdates = {
          actor: evidenceChanges(updates.actor ?? {}), activity: evidenceChanges(updates.activity ?? {}),
          items: (updates.item ?? []).map((update: Obj) => ({ itemId: update._id,
            changes: evidenceChanges(Object.fromEntries(Object.entries(update).filter(([path]) => path !== "_id"))) })),
          createdCount: 0, deletedCount: 0,
        };
        state.resourceConsumption.verified = true;
        state.sourceItemRevision = obj(src.item.toObject()["_stats"])["modifiedTime"] ?? null;
        state.stage = "resources-consumed"; await save();
      }
      if (performance.now() >= deadline) throw Error("Admission budget exhausted before attack roll");
      const ammunition = rollAction.ammunitionId ? src.actor.items.get(rollAction.ammunitionId) : rollAction.attackMode?.startsWith("thrown") ? src.item : undefined;
      const ammunitionBefore = ammunition ? Number(ammunition.system.quantity) : null;
      const rolls = await withOrigins(src, input, () => src.activity.rollAttack({ target: src.victim.system.attributes.ac.value,
        ability: rollAction.abilityId, ammunition: rollAction.ammunitionId, attackMode: rollAction.attackMode,
        rolls: [{ options: rollAction.advantage === "advantage" ? { advantage: true } : rollAction.advantage === "disadvantage" ? { disadvantage: true } : {} }] },
        { configure: false }, { create: false }));
      if (!Array.isArray(rolls) || rolls.length !== 1) throw Error("Attack cancelled or multiple rolls; reconcile native resources");
      if (ammunition) {
        const retained = ammunition.system.properties?.has("ret") === true;
        const after = src.actor.items.get(ammunition.id);
        const quantity = after ? Number(after.system.quantity) : 0;
        const expected = retained ? ammunitionBefore : Math.max(0, Number(ammunitionBefore) - 1);
        state.ammunitionConsumption = { itemId: ammunition.id, before: ammunitionBefore, after: quantity, retained, verified: quantity === expected };
        if (!Number.isFinite(ammunitionBefore) || quantity !== expected) throw Error("Native ammunition readback mismatch");
      }
      state.attackRoll = rollEvidence(rolls[0], `${input.requestId}:attack`);
      if (typeof rolls[0].toJSON === "function") entry.rollData = JSON.stringify(rolls[0].toJSON());
      state.hit = nativeHit(rolls[0], src.victim.system.attributes.ac.value);
      state.critical = state.attackRoll.isCritical;
      state.resourcesAfter = resources(src.actor); state.stage = state.hit ? "attack-rolled" : "miss";
      state.sourceItemRevision = obj(src.item.toObject()["_stats"])["modifiedTime"] ?? null;
      await save(); // Persist the roll before any subsequent roll/effect.
      if (state.hit && (reactions(src.actor).length || reactions(src.victim).length)) {
        state.decisions = [{ id: `${input.requestId}-reaction`, kind: "reaction", message: "Reaction activity exists; GM must adjudicate trigger and player choice before continuing" }];
      }
    }
    if (state.hit && !state.decisions.length) {
      if (performance.now() >= deadline) throw Error("Admission budget exhausted before damage roll");
      await damage(state, src, input, save);
    }
    if (input.action.mode === "apply" && state.hit) {
      if (performance.now() >= deadline) throw Error("Admission budget exhausted before damage application");
      authority(input); const currentSource = source(input, rollAction); assertBoundTarget(state, currentSource);
      if (currentSource.victim !== src.victim || currentSource.actor !== src.actor || currentSource.item !== src.item) throw Error("Attack documents replaced before application");
      if (!same(hp(src.victim), state.hpBefore)) throw Error("Target changed before application");
      const hookApi = Hooks as unknown as { on(name: string, fn: (...args: any[]) => void): number; off(name: string, id: number): void };
      let appliedHook = false;
      const calculation = hookApi.on("dnd5e.calculateDamage", (actor, damages) => { if (actor === src.victim) state.adjustedDamage = damages.map((part: Obj) => ({ type: part.type, value: part.value, active: part.active })); });
      const applied = hookApi.on("dnd5e.applyDamage", (actor) => { if (actor === src.victim) appliedHook = true; });
      const origin = { getFlag: (scope: string, name: string) => scope === "dnd5e" && name === "context" ? { foundryLocalApiOrigin: {
        source: "foundry-local-api.session-action", phase: "apply", correlationId: input.correlationId } } : undefined };
      try {
        await withOrigins(src, input, () => src.victim.applyDamage(state.damageRolls.map((roll: Obj) => ({ value: roll.total, type: roll.type, properties: new Set(roll.properties) })), { origin }));
      } finally { hookApi.off("dnd5e.calculateDamage", calculation); hookApi.off("dnd5e.applyDamage", applied); }
      authority(input); const confirmedSource = source(input, rollAction);
      if (confirmedSource.victim !== src.victim || confirmedSource.actor !== src.actor || confirmedSource.item !== src.item) throw Error("Attack documents replaced during application");
      state.hpAfter = hp(src.victim);
      state.damageApplied = (state.hpBefore.value - state.hpAfter.value) + (state.hpBefore.temp - state.hpAfter.temp);
      if (state.damageApplied < 0) throw Error("Unexpected healing during attack; reconcile native hooks");
      if (!appliedHook) { state.stage = "cancelled"; state.decisions = [{ id: `${input.requestId}-cancelled`, kind: "cancelled", message: "Native damage hook cancelled application; no automatic retry" }]; }
      else state.stage = "damage-applied";
    }
    if (!state.hit) state.stage = "miss";
    const result: AttackResult = { ...base, outcome: state.decisions.length ? "decision-required" : "confirmed", mutated: true, state };
    entry.pending = false; entry.result = result;
    await save();
    return result;
  } catch (error) {
    const result: AttackResult = { ...base, outcome: dispatched ? "uncertain" : "failure", mutated: dispatched,
      state: entry?.state ?? null, message: error instanceof Error ? error.message : "Attack unavailable" };
    if (entry && data && dispatched) { entry.result = result; entry.pending = true; await persist(data.doc, data.entries, input).catch(() => {}); }
    return result;
  }
}
export function readAttackState(input: AttackStateInput): Obj {
  authority(input);
  const scenes = game.collections.get("Scene");
  const scene = (input.sceneId ? scenes?.get(input.sceneId) : [...(scenes?.values() ?? [])].find(value => value.toObject()["active"] === true)) as Scene | undefined;
  if (!scene || scene.toObject()["active"] !== true) throw Error("Current scene required");
  const tokens = [...scene.getEmbeddedCollection("Token").values()].slice(0, 40);
  const entries = [...(game.collections.get("JournalEntry")?.values() ?? [])].flatMap(doc => Object.values(obj(obj(doc.toObject()["flags"])[MODULE])["attackLedger"] ?? {}) as Entry[])
    .filter(entry => entry.input?.userId === input.userId).slice(-12).map(entry => ({ requestId: entry.input.requestId, pending: entry.pending,
      outcome: entry.result?.outcome ?? "uncertain", stage: entry.state?.stage ?? null,
      damageRolled: entry.state?.damageRolled ?? null, damageApplied: entry.state?.damageApplied ?? null }));
  return { schemaVersion: ATTACK_PROTOCOL, worldId: game.world.id, userId: input.userId, sceneId: scene.id, systemId: game.system.id, systemVersion: game.system.version,
    recentAttackReceipts: entries,
    knowledgeScope: "GM-only mechanics; not player-visible knowledge",
    tokens: tokens.filter(token => token.actor && (!input.actorId || token.actor.id === input.actorId)).map(token => ({ tokenId: token.id, actorId: token.actor!.id,
      name: token.toObject()["name"], hp: token.actor!.system.attributes?.hp ? hp(token.actor!) : null, reactions: reactions(token.actor!),
      attacks: [...token.actor!.items.values()].slice(0, 64).flatMap(item => [...(item.system.activities?.values() ?? [])].slice(0, 8).filter((activity: Obj) => activity.type === "attack")
        .map((activity: Obj) => ({ itemId: item.id, activityId: activity.id, name: activity.name, unsupported: unsupported(activity, item),
          attackModes: item.system.attackModes ?? [], ammunitionOptions: item.system.ammunitionOptions ?? [] }))) })) };
}
registerCommand(ATTACK_COMMAND, (input: AttackInput) => inWorldMutationLane(game, () => executeAttack(input)));
registerCommand(ATTACK_STATE_COMMAND, readAttackState);
export async function attackSequenceLedgerDocument(input: AttackStateInput): Promise<FoundryDocument> { authority(input); return (await ledger()).doc; }
export function attackSequenceObservation(input: AttackStateInput, actions: AttackRollAction[]): unknown {
  const modules = (game as unknown as Obj).modules;
  for (const name of ["midi-qol", "dae", "automated-animations", "chris-premades", "dnd5e-helpers"]) if (modules?.get(name)?.active) throw Error(`Unsupported attack automation combination: ${name}`);
  return actions.map(action => { const src = source(input, action);
    const issues = unsupported(src.activity, src.item, true); if (issues.length) throw Error(issues.join("; "));
    choices(action, src.activity, src.item);
    return { action, hp: hp(src.victim), attacker: position(src.attacker), target: position(src.target), resources: resources(src.actor), item: src.item.toObject() }; });
}
