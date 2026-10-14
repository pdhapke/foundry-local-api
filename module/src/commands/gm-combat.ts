import {
  GM_COMBAT_COMMANDS,
  validateGmCombatAction,
  type CombatLedger,
  type CombatBudget,
  type CombatBudgetResource,
  type CombatInterrupt,
  type CombatReady,
  type NativeGmInput,
  type NativeGmApplyInput,
} from "@foundry-local-api/shared";
import { registerCommand } from "../command-registry.js";
import {
  authorizeNative,
  nativeScene,
  nativeToken,
  runNativeMutation,
  readNativeReceipt,
} from "./native-gm-runtime.js";

// Foundry has no supported document typings for system extensions.
type NativeDoc = FoundryDocument & Record<string, any>;
const scope = "foundry-local-api";
const flag = "gmCombatLedger";
function record(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function collection(name: string): Map<string, NativeDoc> {
  return (game.collections.get(name) as Map<string, NativeDoc>) ?? new Map();
}
function combatFor(input: NativeGmInput): NativeDoc {
  const combat = collection("Combat").get(String(input.action["combatId"]));
  if (!combat || combat.toObject()["scene"] !== input.sceneId)
    throw new Error("Combat missing or outside authenticated scene");
  return combat;
}
function cursor(combat: NativeDoc): string {
  const data = combat.toObject();
  const turns = (combat["turns"] as NativeDoc[]) ?? [];
  return `${data["round"]}:${data["turn"]}:${turns[Number(data["turn"])]?.id ?? "none"}`;
}
function emptyLedger(combat: NativeDoc): CombatLedger {
  return {
    version: 1,
    revision: 0,
    cursor: cursor(combat),
    budgets: {},
    ready: [],
    interrupts: [],
    decisions: [],
  };
}
function assertPrivate(doc: NativeDoc): void {
  const ownership = record(doc.toObject()["ownership"]);
  if (ownership["default"] !== 0)
    throw new Error("Combat ledger must be GM-private (default NONE)");
  for (const [id, level] of Object.entries(ownership))
    if (
      id !== "default" &&
      level !== 0 &&
      !(game.users?.get(id) as unknown as { isGM?: boolean })?.isGM
    )
      throw new Error("Combat ledger has non-GM ownership; repair requires human review");
}
function ledgerDoc(input: NativeGmInput, combatId: string): NativeDoc | undefined {
  const matches = [...collection("JournalEntry").values()].filter((doc) => {
    const marker = record(record(record(doc.toObject()["flags"])[scope])[flag]);
    return marker["worldId"] === input.worldId && marker["combatId"] === combatId;
  });
  if (matches.length > 1) throw new Error("Ambiguous combat ledger journals");
  const doc = matches[0];
  if (doc) assertPrivate(doc);
  return doc;
}
function ledgerFor(input: NativeGmInput, combat: NativeDoc): CombatLedger {
  const doc = ledgerDoc(input, combat.id);
  if (!doc) return emptyLedger(combat);
  const marker = record(record(record(doc.toObject()["flags"])[scope])[flag]);
  const ledger = marker["ledger"] as CombatLedger;
  if (
    !ledger ||
    ledger.version !== 1 ||
    !Number.isSafeInteger(ledger.revision) ||
    !ledger.budgets ||
    !Array.isArray(ledger.ready) ||
    !Array.isArray(ledger.interrupts) ||
    !Array.isArray(ledger.decisions)
  )
    throw new Error("Invalid combat ledger; reconcile with human review");
  if (
    ledger.revision < 0 ||
    typeof ledger.cursor !== "string" ||
    Object.values(ledger.budgets).some(
      (b) =>
        !b ||
        [b.action, b.bonus, b.reaction, b.movement, b.movementBase].some(
          (v) => typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 10000,
        ) ||
        [b.action, b.bonus, b.reaction].some((v) => !Number.isInteger(v)) ||
        typeof b.movementMode !== "string" ||
        typeof b.turnKey !== "string",
    ) ||
    ledger.ready.some(
      (r) =>
        !r ||
        typeof r.id !== "string" ||
        typeof r.combatantId !== "string" ||
        !["held", "spent", "expired"].includes(r.status),
    ) ||
    ledger.interrupts.some(
      (i) =>
        !i ||
        typeof i.id !== "string" ||
        typeof i.combatantId !== "string" ||
        !["pending", "accepted", "declined"].includes(i.status),
    )
  )
    throw new Error("Corrupt combat budget or choice ledger");
  if (
    ledger.ready.some(
      (ready) =>
        ready.heldSpell &&
        (typeof ready.heldSpell.castReceiptKey !== "string" ||
          typeof ready.heldSpell.tokenId !== "string" ||
          typeof ready.heldSpell.actorUuid !== "string" ||
          typeof ready.heldSpell.itemId !== "string" ||
          typeof ready.heldSpell.activityId !== "string" ||
          typeof ready.heldSpell.originalConcentration !== "boolean" ||
          !Number.isInteger(ready.heldSpell.scaling) ||
          ready.heldSpell.scaling < 0 ||
          ready.heldSpell.scaling > 9 ||
          !ready.concentrationEffectId ||
          !ready.activityUuid),
    )
  )
    throw new Error("Corrupt held spell casting provenance");
  if (JSON.stringify(ledger).length > 100000)
    throw new Error("Combat ledger capacity exceeded; archive with human review");
  return structuredClone(ledger);
}
async function saveLedger(
  input: NativeGmInput,
  combat: NativeDoc,
  ledger: CombatLedger,
): Promise<void> {
  if (
    ledger.ready.length > 200 ||
    ledger.interrupts.length > 200 ||
    ledger.decisions.length > 200 ||
    Object.keys(ledger.budgets).length > 100 ||
    JSON.stringify(ledger).length > 100000
  )
    throw new Error("Combat ledger capacity reached; archive resolved decisions before continuing");
  ledger.revision += 1;
  const existing = ledgerDoc(input, combat.id);
  const marker = { worldId: input.worldId, combatId: combat.id, ledger };
  if (existing) {
    await existing.update({ [`flags.${scope}.${flag}`]: marker });
    assertPrivate(existing);
  } else {
    const cls = CONFIG["JournalEntry"]?.documentClass as unknown as {
      create(data: Record<string, unknown>): Promise<NativeDoc>;
    };
    if (!cls?.create) throw new Error("Native private journal creation unavailable");
    const created = await cls.create({
      name: `GM combat state ${combat.id}`,
      ownership: { default: 0 },
      flags: { [scope]: { [flag]: marker } },
    });
    assertPrivate(created);
  }
  const persisted = ledgerDoc(input, combat.id);
  const actual = record(record(record(persisted?.toObject()["flags"])[scope])[flag])["ledger"];
  if (JSON.stringify(actual) !== JSON.stringify(ledger))
    throw new Error("Combat ledger persistence acknowledgement unavailable");
}
function combatant(combat: NativeDoc, id: unknown): NativeDoc {
  const c = (combat["combatants"] as Map<string, NativeDoc>).get(String(id));
  if (!c) throw new Error("Combatant not in scoped combat");
  return c;
}
function movementFor(c: NativeDoc, mode: string): number {
  const actor = c["actor"] as NativeDoc | undefined;
  if (!actor) throw new Error("Combatant native actor unavailable");
  const movement = record(record(record(actor.toObject()["system"])["attributes"])["movement"]);
  const value = movement[mode];
  if (
    !Object.hasOwn(movement, mode) ||
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 10000
  )
    throw new Error("Explicit movement mode has no finite native speed");
  return value;
}
function requireSynced(ledger: CombatLedger, combat: NativeDoc): void {
  if (ledger.cursor !== cursor(combat))
    throw new Error(
      "Combat changed outside this workflow; explicit budget-initialize reconciliation required",
    );
}
function noPending(ledger: CombatLedger): void {
  if (ledger.interrupts.some((c) => c.status === "pending"))
    throw new Error("Resolve pending interruption before progressing");
}
function activeId(combat: NativeDoc): string | undefined {
  return ((combat["turns"] as NativeDoc[]) ?? [])[Number(combat.toObject()["turn"])]?.id;
}
function budgetFor(ledger: CombatLedger, c: NativeDoc): CombatBudget {
  const budget = ledger.budgets[c.id];
  if (!budget) throw new Error("Combatant budget requires explicit initialization");
  return budget;
}
function hasConcentration(c: NativeDoc, effectId: string): boolean {
  const effects = (c["actor"] as NativeDoc)?.["concentration"]?.effects as
    { values(): IterableIterator<NativeDoc> } | undefined;
  return Boolean(effects?.values && [...effects.values()].some((effect) => effect.id === effectId));
}
function spend(budget: CombatBudget, resource: CombatBudgetResource, amount: number): void {
  if (budget[resource] < amount) throw new Error(`Insufficient ${resource} budget`);
  budget[resource] -= amount;
}
function ensureActive(combat: NativeDoc, c: NativeDoc, resource: string): void {
  if (resource !== "reaction" && activeId(combat) !== c.id)
    throw new Error("Action/bonus/movement spend requires this combatant's native turn");
}
function activityReference(c: NativeDoc, uuid: unknown): string | null {
  if (uuid === undefined) return null;
  const actor = c["actor"] as NativeDoc;
  const items = actor?.["items"] as Map<string, NativeDoc> | undefined;
  const matches = [...(items?.values() ?? [])].some((item) => {
    const activities = record(item.toObject()["system"])["activities"];
    return Object.keys(record(activities)).some((id) => `${item["uuid"]}.Activity.${id}` === uuid);
  });
  if (!matches) throw new Error("activityUuid must reference an actual combatant activity");
  return String(uuid);
}
function spellActivity(c: NativeDoc, uuid: unknown): boolean {
  return [
    ...(((c["actor"] as NativeDoc)?.["items"] as Map<string, NativeDoc> | undefined)?.values() ??
      []),
  ].some(
    (item) =>
      item.toObject()["type"] === "spell" &&
      typeof uuid === "string" &&
      uuid.startsWith(`${item["uuid"]}.Activity.`),
  );
}
function scopedTokenIds(input: NativeGmInput): string[] {
  const ids = input.action["tokenIds"] as string[];
  for (const id of ids) {
    const token = nativeToken(input, id) as unknown as NativeDoc;
    if (!token["actor"]) throw new Error("Encounter token has no native actor");
  }
  return ids;
}
function heldSpellSource(input: NativeGmInput) {
  authorizeNative(input);
  const a = input.action;
  const token = nativeToken(input, String(a["tokenId"])) as unknown as NativeDoc;
  const actor = token["actor"] as NativeDoc;
  const item = (actor?.["items"] as Map<string, NativeDoc>)?.get(String(a["itemId"]));
  const activity = item?.["system"]?.activities?.get(String(a["activityId"])) as
    NativeDoc | undefined;
  if (
    !actor ||
    actor.id !== a["actorId"] ||
    !item ||
    item.toObject()["type"] !== "spell" ||
    !activity ||
    activity["activation"]?.type !== "action"
  )
    throw new Error(
      "Held spell requires the exact real placed actor spell and one-action native activity",
    );
  const activityUuid = String(activity["uuid"] ?? `${item["uuid"]}.Activity.${a["activityId"]}`);
  const matches = [...collection("Combat").values()].filter(
    (combat) =>
      combat.toObject()["scene"] === input.sceneId &&
      Number(combat.toObject()["round"]) > 0 &&
      [...(combat["combatants"] as Map<string, NativeDoc>).values()].some(
        (c) => c.toObject()["tokenId"] === token.id,
      ),
  );
  if (matches.length !== 1) throw new Error("Held spell requires one exact started combat");
  const combat = matches[0]!;
  const c = [...(combat["combatants"] as Map<string, NativeDoc>).values()].find(
    (c) => c.toObject()["tokenId"] === token.id,
  )!;
  if (c["actor"] !== actor) throw new Error("Held spell combat actor binding changed");
  if (activityReference(c, activityUuid) !== activityUuid)
    throw new Error("Held spell native source provenance unavailable");
  const ledger = ledgerFor(input, combat);
  requireSynced(ledger, combat);
  return { a, token, actor, item, activity, activityUuid, combat, c, ledger };
}
function heldSpellEffect(c: NativeDoc, effectId: string, activityUuid: string): NativeDoc {
  const effects = (c["actor"] as NativeDoc)?.["concentration"]?.effects as
    { values(): IterableIterator<NativeDoc> } | undefined;
  const effect = effects?.values && [...effects.values()].find((e) => e.id === effectId);
  const data = effect?.toObject();
  const dnd = record(record(data?.["flags"])["dnd5e"]);
  const activityData = record(dnd["activity"]);
  const itemData = record(dnd["item"]);
  const itemUuid = activityUuid.split(".Activity.")[0];
  if (
    !effect ||
    activityData["uuid"] !== activityUuid ||
    activityData["id"] !== activityUuid.split(".Activity.")[1] ||
    itemData["uuid"] !== itemUuid ||
    itemData["type"] !== "spell" ||
    data?.["origin"] !== itemUuid ||
    data?.["disabled"] === true
  )
    throw new Error("Exact held native concentration effect missing, disrupted or source mismatch");
  return effect;
}
export function readHeldSpellState(input: NativeGmInput): Record<string, unknown> | null {
  if (!["ready", "release"].includes(String(input.action["phase"]))) return null;
  const src = heldSpellSource(input);
  const release = record(src.a["release"]);
  const choice = record(src.a["ready"]);
  const ready = src.ledger.ready.find(
    (r) =>
      r.combatantId === src.c.id &&
      (release["readyId"] ? r.id === release["readyId"] : r.id === choice["choiceId"]),
  );
  const interruptions = src.ledger.interrupts.filter((i) => i.readyId === ready?.id);
  return {
    combatId: src.combat.id,
    combatantId: src.c.id,
    ledgerRevision: src.ledger.revision,
    cursor: src.ledger.cursor,
    ready: ready ?? null,
    interruptions,
    maintainedConcentration: ready?.concentrationEffectId
      ? hasConcentration(src.c, ready.concentrationEffectId)
      : false,
  };
}
export function assertHeldSpellReady(input: NativeGmInput): void {
  const src = heldSpellSource(input);
  const choice = record(src.a["ready"]);
  if (
    src.a["phase"] !== "ready" ||
    typeof choice["choiceId"] !== "string" ||
    !choice["choiceId"] ||
    typeof choice["trigger"] !== "string" ||
    !choice["trigger"] ||
    typeof choice["ruling"] !== "string" ||
    !choice["ruling"] ||
    [choice["choiceId"], choice["trigger"], choice["ruling"]].some(
      (value) => String(value).length > 2000,
    )
  )
    throw new Error("Explicit bounded held-spell choice, trigger and rules ruling required");
  ensureActive(src.combat, src.c, "action");
  noPending(src.ledger);
  if (
    src.ledger.ready.some(
      (r) => r.id === choice["choiceId"] || (r.combatantId === src.c.id && r.status === "held"),
    )
  )
    throw new Error("Held ready choice already exists");
  if (src.ledger.ready.length >= 200) throw new Error("Held-spell ledger capacity reached");
  assertCombatActivityBudget(input, src.token.id, "action");
}
export async function completeHeldSpellReady(
  input: NativeGmApplyInput,
  effectId: string,
): Promise<void> {
  const src = heldSpellSource(input);
  const choice = record(src.a["ready"]);
  if (
    src.a["phase"] !== "ready" ||
    src.ledger.ready.some(
      (r) => r.id === choice["choiceId"] || (r.combatantId === src.c.id && r.status === "held"),
    )
  )
    throw new Error("Held spell registration ambiguity");
  heldSpellEffect(src.c, effectId, src.activityUuid);
  if (
    !src.ledger.decisions.some(
      (d) =>
        d.kind === "native-activity-budget" &&
        d.ruling === input.idempotencyKey &&
        d.activityUuid === src.activityUuid &&
        d.combatantId === src.c.id,
    )
  )
    throw new Error("Held spell requires action spend in same native cast reservation");
  src.ledger.ready.push({
    id: String(choice["choiceId"]),
    combatantId: src.c.id,
    trigger: String(choice["trigger"]),
    activityUuid: src.activityUuid,
    concentrationEffectId: effectId,
    expiresBeforeTurn: cursor(src.combat),
    status: "held",
    heldSpell: {
      castReceiptKey: input.idempotencyKey,
      tokenId: src.token.id,
      actorUuid: String(src.actor["uuid"]),
      itemId: src.item.id,
      activityId: String(src.a["activityId"]),
      spellSlot: typeof src.a["spellSlot"] === "string" ? src.a["spellSlot"] : null,
      scaling: Number(src.a["scaling"] ?? 0),
      originalConcentration: src.activity["duration"]?.concentration === true,
    },
  });
  await saveLedger(input, src.combat, src.ledger);
}
export async function assertHeldSpellRelease(
  input: NativeGmInput,
): Promise<Record<string, unknown>> {
  const src = heldSpellSource(input);
  const release = record(src.a["release"]);
  const ready = src.ledger.ready.find(
    (r) => r.id === release["readyId"] && r.combatantId === src.c.id && r.status === "held",
  );
  const held = ready?.heldSpell;
  if (
    src.a["phase"] !== "release" ||
    !ready ||
    !held ||
    !ready.concentrationEffectId ||
    ready.activityUuid !== src.activityUuid ||
    release["castReceipt"] !== held.castReceiptKey ||
    held.actorUuid !== src.actor["uuid"] ||
    held.tokenId !== src.token.id ||
    held.itemId !== src.item.id ||
    held.activityId !== src.a["activityId"] ||
    (src.a["spellSlot"] ?? null) !== held.spellSlot ||
    Number(src.a["scaling"] ?? 0) !== held.scaling
  )
    throw new Error("Held spell release source, cast receipt or retained slot/scaling mismatch");
  heldSpellEffect(src.c, ready.concentrationEffectId, src.activityUuid);
  const pending = src.ledger.interrupts.filter(
    (i) =>
      i.kind === "ready" &&
      i.readyId === ready.id &&
      i.combatantId === src.c.id &&
      i.activityUuid === src.activityUuid &&
      i.status === "pending",
  );
  if (pending.length !== 1 || pending[0]!.reservedActivityKey)
    throw new Error("One unreserved explicit pending held-spell trigger required");
  const cast = await readNativeReceipt(input, held.castReceiptKey);
  const castAction = record(cast?.action);
  const castData = record(cast?.data);
  if (
    !cast ||
    cast.outcome !== "confirmed" ||
    castAction["mode"] !== "use" ||
    castAction["phase"] !== "ready" ||
    castAction["tokenId"] !== src.token.id ||
    castAction["actorId"] !== src.actor.id ||
    castAction["itemId"] !== held.itemId ||
    castAction["activityId"] !== held.activityId ||
    record(castAction["ready"])["choiceId"] !== ready.id ||
    castData["activityUuid"] !== src.activityUuid ||
    !Array.isArray(castData["effects"]) ||
    !(castData["effects"] as unknown[]).includes(ready.concentrationEffectId)
  )
    throw new Error("Confirmed native held-spell casting provenance unavailable");
  return {
    ...held,
    readyId: ready.id,
    concentrationEffectId: ready.concentrationEffectId,
    interruptionId: pending[0]!.id,
  };
}
async function endHeldConcentration(c: NativeDoc, ready: CombatReady): Promise<void> {
  if (
    !ready.heldSpell ||
    !ready.concentrationEffectId ||
    !hasConcentration(c, ready.concentrationEffectId)
  )
    return;
  heldSpellEffect(c, ready.concentrationEffectId, String(ready.activityUuid));
  const actor = c["actor"] as NativeDoc;
  if (typeof actor["endConcentration"] !== "function")
    throw new Error("Native held concentration cleanup unavailable");
  await actor["endConcentration"](ready.concentrationEffectId);
  if (hasConcentration(c, ready.concentrationEffectId))
    throw new Error("Native held concentration cleanup not acknowledged");
}
export async function completeHeldSpellRelease(input: NativeGmApplyInput): Promise<void> {
  const src = heldSpellSource(input);
  const release = record(src.a["release"]);
  const ready = src.ledger.ready.find(
    (r) => r.id === release["readyId"] && r.combatantId === src.c.id && r.status === "held",
  );
  const pending = src.ledger.interrupts.find(
    (i) =>
      i.readyId === ready?.id &&
      i.status === "pending" &&
      i.reservedActivityKey === input.idempotencyKey,
  );
  if (
    !ready?.heldSpell ||
    !ready.concentrationEffectId ||
    !pending ||
    ready.heldSpell.castReceiptKey !== release["castReceipt"]
  )
    throw new Error("Held release reservation completion mismatch");
  if (ready.heldSpell.originalConcentration) {
    if (hasConcentration(src.c, ready.concentrationEffectId))
      throw new Error(
        "Original concentration spell must replace exact temporary held effect on release",
      );
    const effects = [...(src.actor["concentration"]?.effects?.values() ?? [])] as NativeDoc[];
    const matching = effects.filter(
      (effect) =>
        record(record(record(effect.toObject()["flags"])["dnd5e"])["activity"])["uuid"] ===
        src.activityUuid,
    );
    if (matching.length !== 1)
      throw new Error("Original native spell concentration not uniquely maintained after release");
    heldSpellEffect(src.c, matching[0]!.id, src.activityUuid);
  } else await endHeldConcentration(src.c, ready);
  ready.status = "spent";
  await saveLedger(input, src.combat, src.ledger);
}
function activityCombat(
  input: NativeGmInput,
  tokenId: string,
  activationType: string,
): {
  combat: NativeDoc;
  ledger: CombatLedger;
  c: NativeDoc;
  resource: CombatBudgetResource | null;
  interruptionId: string | null;
  activityUuid: string;
} | null {
  authorizeNative(input);
  const token = nativeToken(input, tokenId) as unknown as NativeDoc;
  const matches = [...collection("Combat").values()].filter(
    (combat) =>
      combat.toObject()["scene"] === input.sceneId &&
      Number(combat.toObject()["round"]) > 0 &&
      [...(combat["combatants"] as Map<string, NativeDoc>).values()].some(
        (c) => c.toObject()["tokenId"] === tokenId,
      ),
  );
  if (matches.length > 1) throw new Error("Ambiguous started combat for native activity");
  const combat = matches[0];
  if (!combat) return null;
  const c = [...(combat["combatants"] as Map<string, NativeDoc>).values()].find(
    (c) => c.toObject()["tokenId"] === tokenId,
  )!;
  if (c["actor"] !== token["actor"])
    throw new Error("Combatant native token actor binding changed");
  const ledger = ledgerFor(input, combat);
  requireSynced(ledger, combat);
  const activityUuid = activityReference(
    c,
    `${(token["actor"] as NativeDoc)["uuid"]}.Item.${input.action["itemId"]}.Activity.${input.action["activityId"]}`,
  )!;
  const pending = ledger.interrupts.filter((i) => i.status === "pending");
  const relevant = pending.filter((i) => i.combatantId === c.id && i.activityUuid === activityUuid);
  if (relevant.length > 1) throw new Error("Ambiguous pending native activity interruption");
  const interruption = relevant[0];
  if (pending.length && !interruption)
    throw new Error("Resolve pending interruption before another native activity");
  let resource: CombatBudgetResource | null = ["action", "bonus", "reaction"].includes(
    activationType,
  )
    ? (activationType as CombatBudgetResource)
    : null;
  if (interruption && ["ready", "reaction", "opportunity"].includes(interruption.kind))
    resource = "reaction";
  if (
    interruption?.kind === "ready" &&
    spellActivity(c, activityUuid) &&
    input.action["phase"] !== "release"
  )
    throw new Error(
      "Held spell cast-now/release-later resource semantics require human native workflow",
    );
  if (resource === "reaction" && !interruption)
    throw new Error("Reaction native activity requires an explicit linked pending interruption");
  if (interruption?.reservedActivityKey)
    throw new Error(
      "Pending interruption activity already reserved; reconcile existing receipt before retrying",
    );
  if (resource) {
    ensureActive(combat, c, resource);
    spend(budgetFor(ledger, c), resource, 1);
  }
  return { combat, ledger, c, resource, interruptionId: interruption?.id ?? null, activityUuid };
}
/** Native activities include this state in expectedState; no separately rolled rules engine. */
export function assertCombatActivityBudget(
  input: NativeGmInput,
  tokenId: string,
  activationType: string,
): Record<string, unknown> | null {
  const binding = activityCombat(input, tokenId, activationType);
  if (!binding) return null;
  // activityCombat validates against a clone; return the actual current persistent ledger.
  return {
    combatId: binding.combat.id,
    combatantId: binding.c.id,
    cursor: cursor(binding.combat),
    resource: binding.resource,
    interruptionId: binding.interruptionId,
    ledger: ledgerFor(input, binding.combat),
  };
}
/** Called inside native activity's outer reservation BEFORE activity.use, once. */
export async function spendCombatActivityBudget(
  input: NativeGmApplyInput,
  tokenId: string,
  activationType: string,
): Promise<void> {
  const binding = activityCombat(input, tokenId, activationType);
  if (!binding || (!binding.resource && !binding.interruptionId)) return;
  const { ledger, combat, c } = binding;
  if (ledger.decisions.length >= 200) throw new Error("Combat decision capacity reached");
  if (binding.interruptionId)
    ledger.interrupts.find((i) => i.id === binding.interruptionId)!.reservedActivityKey =
      input.idempotencyKey;
  ledger.decisions.push({
    kind: "native-activity-budget",
    combatantId: c.id,
    ruling: input.idempotencyKey,
    activityUuid: binding.activityUuid,
    round: Number(combat.toObject()["round"]),
    turn: combat.toObject()["turn"] as number | null,
  });
  await saveLedger(input, combat, ledger);
}
function movementCombat(
  input: NativeGmInput,
  tokenId: string,
  amount: number,
): { combat: NativeDoc; ledger: CombatLedger; c: NativeDoc } | null {
  authorizeNative(input);
  if (
    !Number.isFinite(amount) ||
    amount < 0 ||
    amount > 10000 ||
    typeof input.action["ruling"] !== "string" ||
    !String(input.action["ruling"]).trim()
  )
    throw new Error("Explicit finite native movement cost and terrain ruling required");
  const token = nativeToken(input, tokenId) as unknown as NativeDoc;
  const matches = [...collection("Combat").values()].filter(
    (combat) =>
      combat.toObject()["scene"] === input.sceneId &&
      Number(combat.toObject()["round"]) > 0 &&
      [...(combat["combatants"] as Map<string, NativeDoc>).values()].some(
        (c) => c.toObject()["tokenId"] === tokenId,
      ),
  );
  if (matches.length > 1) throw new Error("Ambiguous started combat for native movement");
  const combat = matches[0];
  if (!combat) return null;
  const c = [...(combat["combatants"] as Map<string, NativeDoc>).values()].find(
    (c) => c.toObject()["tokenId"] === tokenId,
  )!;
  if (c["actor"] !== token["actor"]) throw new Error("Movement combatant actor binding changed");
  const ledger = ledgerFor(input, combat);
  requireSynced(ledger, combat);
  noPending(ledger);
  ensureActive(combat, c, "movement");
  const actorMovement = record(
    record(record((token["actor"] as NativeDoc).toObject()["system"])["attributes"])["movement"],
  );
  const sceneUnits = record((nativeScene(input) as unknown as NativeDoc).toObject()["grid"])[
    "units"
  ];
  if (typeof actorMovement["units"] !== "string" || actorMovement["units"] !== sceneUnits)
    throw new Error(
      "Native actor/scene movement units mismatch or unknown; human conversion required",
    );
  spend(budgetFor(ledger, c), "movement", amount);
  return { combat, ledger, c };
}
/** Explicit measured/adjudicated scene-unit cost; never recomputes terrain rules. */
export function assertCombatMovementBudget(
  input: NativeGmInput,
  tokenId: string,
  amount: number,
): Record<string, unknown> | null {
  const binding = movementCombat(input, tokenId, amount);
  return binding
    ? {
        combatId: binding.combat.id,
        combatantId: binding.c.id,
        cursor: cursor(binding.combat),
        movementCost: amount,
        ledger: ledgerFor(input, binding.combat),
      }
    : null;
}
export async function spendCombatMovementBudget(
  input: NativeGmApplyInput,
  tokenId: string,
  amount: number,
): Promise<void> {
  const binding = movementCombat(input, tokenId, amount);
  if (!binding) return;
  const { combat, ledger, c } = binding;
  if (ledger.decisions.length >= 200) throw new Error("Combat decision capacity reached");
  ledger.decisions.push({
    kind: "native-movement-budget",
    combatantId: c.id,
    ruling: `${input.idempotencyKey}: ${String(input.action["ruling"])}`,
    activityUuid: null,
    round: Number(combat.toObject()["round"]),
    turn: combat.toObject()["turn"] as number | null,
  });
  await saveLedger(input, combat, ledger);
}
async function preflight(input: NativeGmApplyInput): Promise<void> {
  const a = input.action;
  const kind = String(a["kind"]);
  if (kind === "create") {
    scopedTokenIds(input);
    return;
  }
  const combat = combatFor(input);
  const ledger = ledgerFor(input, combat);
  if (kind !== "budget-initialize" && kind !== "ready-expire") requireSynced(ledger, combat);
  if (
    [
      "start",
      "next",
      "end",
      "add-combatants",
      "remove-combatants",
      "initiative",
      "budget-spend",
      "ready",
      "budget-initialize",
      "budget-adjust",
    ].includes(kind)
  )
    noPending(ledger);
  if (
    ledger.ready.length >= 200 ||
    ledger.interrupts.length >= 200 ||
    ledger.decisions.length >= 200 ||
    JSON.stringify(ledger).length > 95000
  )
    throw new Error("Combat ledger capacity reached; archive resolved choices with human review");
  if (kind === "add-combatants") {
    const ids = scopedTokenIds(input);
    const existing = [...(combat["combatants"] as Map<string, NativeDoc>).values()].map(
      (c) => c.toObject()["tokenId"],
    );
    if (ids.some((id) => existing.includes(id)) || ids.length + existing.length > 100)
      throw new Error("Duplicate or over-capacity encounter participant");
  }
  if (kind === "initiative" || kind === "remove-combatants") {
    for (const id of a["combatantIds"] as string[]) {
      combatant(combat, id);
      if (
        kind === "remove-combatants" &&
        ledger.ready.some((r) => r.combatantId === id && r.status === "held")
      )
        throw new Error("Expire held ready before removing participant");
      if (
        kind === "initiative" &&
        a["rollMode"] === "publicroll" &&
        combatant(combat, id).toObject()["hidden"] === true
      )
        throw new Error("Hidden combatant initiative requires private native message mode");
    }
  }
  if (
    kind === "start" &&
    (Number(combat.toObject()["round"]) > 0 ||
      !(combat["turns"] as NativeDoc[]).length ||
      [...(combat["combatants"] as Map<string, NativeDoc>).values()].some(
        (c) => !Number.isFinite(c.toObject()["initiative"]),
      ))
  )
    throw new Error("Start requires unstarted encounter with finite initiative");
  if (kind === "next" && Number(combat.toObject()["round"]) < 1)
    throw new Error("Start combat explicitly before next");
  if (a["combatantId"]) {
    const c = combatant(combat, a["combatantId"]);
    if (kind === "budget-initialize") {
      if (ledger.cursor !== cursor(combat) && ledger.ready.some((r) => r.status === "held"))
        throw new Error("Expire held choices before reconciling an unobserved combat transition");
      movementFor(c, String(a["movementMode"]));
      if (ledger.cursor !== cursor(combat) && Object.keys(ledger.budgets).some((id) => id !== c.id))
        throw new Error(
          "External transition affects multiple budgets; human reconciliation required",
        );
    }
    if (kind === "budget-spend" || kind === "ready") {
      const resource = kind === "ready" ? "action" : (a["resource"] as CombatBudgetResource);
      ensureActive(combat, c, resource);
      spend(budgetFor(ledger, c), resource, kind === "ready" ? 1 : Number(a["amount"]));
    }
    if (kind === "budget-adjust") budgetFor(ledger, c);
    if (kind === "ready") {
      if (spellActivity(c, a["activityUuid"]) || a["concentrationEffectId"])
        throw new Error(
          "Held spell concentration/resource/release semantics require human native workflow",
        );
      if (
        ledger.ready.some(
          (r) => r.id === a["choiceId"] || (r.combatantId === c.id && r.status === "held"),
        )
      )
        throw new Error("Ready choice already exists");
      if (a["concentrationEffectId"] && !hasConcentration(c, String(a["concentrationEffectId"])))
        throw new Error("Held concentration effect must be native concentration on actor");
    }
    if (kind === "interrupt-open") {
      if (ledger.interrupts.some((i) => i.id === a["choiceId"]))
        throw new Error("Interruption ID already exists");
      if (
        ["reaction", "ready", "opportunity"].includes(String(a["interruptKind"])) &&
        budgetFor(ledger, c).reaction < 1
      )
        throw new Error("Reaction unavailable");
      if (a["interruptKind"] === "ready") {
        const r = ledger.ready.find(
          (r) => r.id === a["readyId"] && r.combatantId === c.id && r.status === "held",
        );
        if (!r || (r.concentrationEffectId && !hasConcentration(c, r.concentrationEffectId)))
          throw new Error("Held ready/concentration required");
        if (a["activityUuid"] !== undefined && a["activityUuid"] !== r.activityUuid)
          throw new Error("Ready activity binding mismatch");
      }
    }
    if (a["activityUuid"] !== undefined) activityReference(c, a["activityUuid"]);
  }
  if (
    kind === "ready-expire" &&
    !ledger.ready.some((r) => r.id === a["choiceId"] && r.status === "held")
  )
    throw new Error("Held ready choice not found");
  if (kind === "interrupt-resolve") {
    const i = ledger.interrupts.find((i) => i.id === a["choiceId"] && i.status === "pending");
    if (!i) throw new Error("Pending interruption not found");
    if (a["decision"] === "decline" && i.reservedActivityKey)
      throw new Error(
        "Native activity already reserved; verify its receipt and resolve committed execution",
      );
    if (a["decision"] === "accept") {
      if (["ready", "reaction", "opportunity"].includes(i.kind) && !i.reservedActivityKey)
        spend(budgetFor(ledger, combatant(combat, i.combatantId)), "reaction", 1);
      if (i.activityUuid) {
        if (!a["resolutionReceipt"]) throw new Error("Confirmed native activity receipt required");
        const receipt = await readNativeReceipt(input, String(a["resolutionReceipt"]));
        const c = combatant(combat, i.combatantId);
        const data = c.toObject();
        const source = record(receipt?.action);
        const activityUuid = `${(c["actor"] as NativeDoc)["uuid"]}.Item.${source["itemId"]}.Activity.${source["activityId"]}`;
        if (
          !receipt ||
          receipt.outcome !== "confirmed" ||
          receipt.worldId !== input.worldId ||
          receipt.sceneId !== input.sceneId ||
          receipt.userId !== input.userId ||
          source["mode"] !== "use" ||
          source["tokenId"] !== data["tokenId"] ||
          activityUuid !== i.activityUuid ||
          record(receipt.data)["activityUuid"] !== i.activityUuid
        )
          throw new Error("Receipt must confirm this combatant's exact native activity");
        if (i.reservedActivityKey !== a["resolutionReceipt"])
          throw new Error(
            "Activity receipt must match this interruption's already-spent reservation",
          );
        if (
          ledger.interrupts.some(
            (other) => other.id !== i.id && other.resolutionReceipt === a["resolutionReceipt"],
          )
        )
          throw new Error("Activity receipt already resolved another interruption");
      }
    }
  }
}
/** Exact snapshot is the expectedState for apply. It is GM-only, including pending choices. */
export function readGmCombat(input: NativeGmInput): Record<string, unknown> {
  authorizeNative(input);
  validateGmCombatAction(input.action);
  nativeScene(input);
  if (input.action["kind"] === "create") {
    const ids = scopedTokenIds(input);
    return {
      sceneId: input.sceneId,
      tokenIds: ids,
      tokens: ids.map((id) => {
        const token = nativeToken(input, id) as unknown as NativeDoc;
        const data = token.toObject();
        return { id, actorId: data["actorId"], x: data["x"], y: data["y"], hidden: data["hidden"] };
      }),
      combatIds: [...collection("Combat").values()]
        .filter((c) => c.toObject()["scene"] === input.sceneId)
        .map((c) => c.id)
        .sort(),
    };
  }
  const id = String(input.action["combatId"]);
  const combat = collection("Combat").get(id);
  if (!combat) return { combatId: id, exists: false };
  if (combat.toObject()["scene"] !== input.sceneId)
    throw new Error("Combat outside authenticated scene");
  const data = combat.toObject();
  const roster = [...(combat["combatants"] as Map<string, NativeDoc>).values()].map((c) => {
    const d = c.toObject();
    const actor = c["actor"] as NativeDoc | undefined;
    return {
      id: c.id,
      tokenId: d["tokenId"] ?? null,
      actorId: d["actorId"] ?? null,
      initiative: d["initiative"] ?? null,
      defeated: d["defeated"] ?? false,
      hidden: d["hidden"] ?? false,
      resources: actor ? (record(actor.toObject()["system"])["resources"] ?? {}) : {},
      movement: actor
        ? (record(record(actor.toObject()["system"])["attributes"])["movement"] ?? {})
        : {},
    };
  });
  if (roster.length > 100) throw new Error("Combat roster exceeds bounded workflow");
  return {
    combatId: id,
    exists: true,
    sceneId: input.sceneId,
    round: data["round"],
    turn: data["turn"],
    activeCombatantId: activeId(combat) ?? null,
    combatants: roster,
    ledger: ledgerFor(input, combat),
    capabilities: {
      historyCapture: false,
      opportunityTrigger: "explicit-GM-decision",
      ordinaryBudget: "explicit-durable-ledger",
      legendaryResource: "native-activity-activation",
      rulesAdjudication: "human-required",
    },
  };
}
export async function applyGmCombat(input: NativeGmApplyInput): Promise<unknown> {
  authorizeNative(input);
  validateGmCombatAction(input.action);
  nativeScene(input);
  if (input.action["kind"] === "read") throw new Error("read action cannot mutate");
  let createdId: string | undefined;
  const read = () =>
    readGmCombat(createdId ? { ...input, action: { kind: "read", combatId: createdId } } : input);
  return runNativeMutation(
    input,
    read,
    async () => {
      const action = input.action;
      const kind = String(action["kind"]);
      if (kind === "create") {
        const ids = scopedTokenIds(input);
        const cls = CONFIG["Combat"]?.documentClass as unknown as {
          create(data: Record<string, unknown>): Promise<NativeDoc>;
        };
        if (!cls?.create) throw new Error("Native Combat creation unavailable");
        const combat = await cls.create({
          scene: input.sceneId,
          active: false,
          combatants: ids.map((tokenId) => {
            const token = nativeToken(input, tokenId) as unknown as NativeDoc;
            return {
              tokenId,
              actorId: token.toObject()["actorId"],
              hidden: token.toObject()["hidden"] ?? false,
            };
          }),
        });
        createdId = combat.id;
        await saveLedger(input, combat, emptyLedger(combat));
        return { createdCombatId: createdId };
      }
      const combat = combatFor(input);
      const ledger = ledgerFor(input, combat);
      if (kind !== "budget-initialize" && kind !== "ready-expire") requireSynced(ledger, combat);
      if (
        [
          "start",
          "next",
          "end",
          "add-combatants",
          "remove-combatants",
          "initiative",
          "budget-spend",
          "ready",
        ].includes(kind)
      )
        noPending(ledger);
      if (kind === "end") {
        for (const ready of ledger.ready)
          if (ready.status === "held" && ready.heldSpell) {
            await endHeldConcentration(combatant(combat, ready.combatantId), ready);
            ready.status = "expired";
          }
        if (ledger.ready.some((ready) => ready.heldSpell)) await saveLedger(input, combat, ledger);
        await combat.delete();
        if (collection("Combat").has(combat.id))
          throw new Error("Native combat delete did not persist");
        return { endedCombatId: combat.id };
      }
      if (kind === "add-combatants") {
        const ids = scopedTokenIds(input);
        const existing = [...(combat["combatants"] as Map<string, NativeDoc>).values()].map(
          (c) => c.toObject()["tokenId"],
        );
        if (ids.some((id) => existing.includes(id))) throw new Error("Token already in encounter");
        await combat.createEmbeddedDocuments(
          "Combatant",
          ids.map((tokenId) => {
            const d = (nativeToken(input, tokenId) as unknown as NativeDoc).toObject();
            return { tokenId, actorId: d["actorId"], hidden: d["hidden"] ?? false };
          }),
        );
        if (
          ids.some(
            (id) =>
              ![...(combat["combatants"] as Map<string, NativeDoc>).values()].some(
                (c) => c.toObject()["tokenId"] === id,
              ),
          )
        )
          throw new Error("Native combat participant create did not persist");
      } else if (kind === "remove-combatants") {
        const ids = action["combatantIds"] as string[];
        for (const id of ids) combatant(combat, id);
        if (ids.some((id) => ledger.ready.some((r) => r.combatantId === id && r.status === "held")))
          throw new Error("Expire held ready choices before removing participant");
        await combat["deleteEmbeddedDocuments"]("Combatant", ids);
        if (ids.some((id) => (combat["combatants"] as Map<string, NativeDoc>).has(id)))
          throw new Error("Native combat participant removal did not persist");
        for (const id of ids) delete ledger.budgets[id];
      } else if (kind === "initiative") {
        const ids = action["combatantIds"] as string[];
        for (const id of ids) combatant(combat, id);
        const messageMode = {
          publicroll: "public",
          gmroll: "gm",
          blindroll: "blind",
          selfroll: "self",
        }[String(action["rollMode"])];
        const beforeMessages = new Set(collection("ChatMessage").keys());
        await combat["rollInitiative"](ids, { messageMode });
        const actors = ids.map((id) => combatant(combat, id).toObject()["actorId"]);
        const tokens = ids.map((id) => combatant(combat, id).toObject()["tokenId"]);
        for (const message of [...collection("ChatMessage").values()].filter(
          (m) => !beforeMessages.has(m.id),
        )) {
          const d = message.toObject();
          const speaker = record(d["speaker"]);
          if (!actors.includes(speaker["actor"]) && !tokens.includes(speaker["token"])) continue;
          const whisper = d["whisper"];
          if (
            messageMode !== "public" &&
            (!Array.isArray(whisper) ||
              !whisper.length ||
              whisper.some(
                (id) =>
                  typeof id !== "string" ||
                  (messageMode === "self" ? id !== input.userId : !game.users.get(id)?.isGM),
              ))
          )
            throw new Error("Native initiative private recipient verification failed");
          if (messageMode === "blind" && d["blind"] !== true)
            throw new Error("Native initiative blind mode verification failed");
        }
        // dnd5e grouped initiative can derive several participants from one roll.
        if (ids.some((id) => !Number.isFinite(combatant(combat, id).toObject()["initiative"])))
          throw new Error(
            "Native initiative did not produce finite participant values; do not reroll uncertain receipt",
          );
      } else if (kind === "start" || kind === "next") {
        if (kind === "start") {
          if (Number(combat.toObject()["round"]) > 0) throw new Error("Combat already started");
          if (!(combat["turns"] as NativeDoc[]).length)
            throw new Error("Encounter has no native turn order");
          if (
            [...(combat["combatants"] as Map<string, NativeDoc>).values()].some(
              (c) => !Number.isFinite(c.toObject()["initiative"]),
            )
          )
            throw new Error("Explicit initiative required before start");
          await combat["startCombat"]();
          if (combat.toObject()["round"] !== 1 || combat.toObject()["turn"] !== 0)
            throw new Error("Native start combat did not reach first turn");
        } else {
          if (Number(combat.toObject()["round"]) < 1)
            throw new Error("Start combat explicitly before next");
          const before = cursor(combat);
          await combat["nextTurn"]();
          if (cursor(combat) === before) throw new Error("Native nextTurn did not progress");
        }
        const id = activeId(combat);
        if (id && ledger.budgets[id]) {
          const b = ledger.budgets[id]!;
          b.action = 1;
          b.bonus = 1;
          b.reaction = 1;
          b.movementBase = movementFor(combatant(combat, id), b.movementMode);
          b.movement = b.movementBase;
          b.turnKey = cursor(combat);
        }
        for (const ready of ledger.ready)
          if (ready.status === "held" && ready.combatantId === id) {
            await endHeldConcentration(combatant(combat, ready.combatantId), ready);
            ready.status = "expired";
          }
      } else if (kind === "budget-initialize") {
        noPending(ledger);
        if (ledger.cursor !== cursor(combat) && ledger.ready.some((r) => r.status === "held"))
          throw new Error("Expire held choices before reconciling an unobserved combat transition");
        const c = combatant(combat, action["combatantId"]);
        const mode = String(action["movementMode"]);
        const speed = movementFor(c, mode);
        if (
          ledger.cursor !== cursor(combat) &&
          Object.keys(ledger.budgets).some((id) => id !== c.id)
        )
          throw new Error(
            "External transition affects multiple budgets; human reconciliation required rather than resetting unrelated participants",
          );
        ledger.budgets[c.id] = {
          action: Number(action["actionCount"] ?? 1),
          bonus: Number(action["bonusCount"] ?? 1),
          reaction: Number(action["reactionCount"] ?? 1),
          movement: speed,
          movementMode: mode,
          movementBase: speed,
          turnKey: cursor(combat),
        };
        ledger.decisions.push({
          kind,
          combatantId: c.id,
          ruling: String(action["ruling"]),
          activityUuid: null,
          round: Number(combat.toObject()["round"]),
          turn: combat.toObject()["turn"] as number | null,
        });
      } else if (kind === "budget-spend" || kind === "budget-adjust") {
        const c = combatant(combat, action["combatantId"]);
        const b = budgetFor(ledger, c);
        const resource = action["resource"] as CombatBudgetResource;
        if (kind === "budget-spend") {
          ensureActive(combat, c, resource);
          spend(b, resource, Number(action["amount"]));
        } else {
          noPending(ledger);
          b[resource] = Number(action["amount"]);
        }
        ledger.decisions.push({
          kind,
          combatantId: c.id,
          ruling: String(action["ruling"]),
          activityUuid: null,
          round: Number(combat.toObject()["round"]),
          turn: combat.toObject()["turn"] as number | null,
        });
      } else if (kind === "ready") {
        const c = combatant(combat, action["combatantId"]);
        if (spellActivity(c, action["activityUuid"]) || action["concentrationEffectId"])
          throw new Error(
            "Held spell concentration/resource/release semantics require human native workflow",
          );
        ensureActive(combat, c, "action");
        if (
          ledger.ready.some(
            (r) => r.id === action["choiceId"] || (r.combatantId === c.id && r.status === "held"),
          )
        )
          throw new Error("Ready choice already exists");
        const activityUuid = activityReference(c, action["activityUuid"]);
        const effectId = action["concentrationEffectId"];
        if (effectId && !hasConcentration(c, String(effectId)))
          throw new Error("Held concentration effect must already exist on native actor");
        spend(budgetFor(ledger, c), "action", 1);
        ledger.ready.push({
          id: String(action["choiceId"]),
          combatantId: c.id,
          trigger: String(action["trigger"]),
          activityUuid,
          concentrationEffectId: effectId ? String(effectId) : null,
          expiresBeforeTurn: cursor(combat),
          status: "held",
        });
      } else if (kind === "ready-expire") {
        const r = ledger.ready.find((r) => r.id === action["choiceId"] && r.status === "held");
        if (!r) throw new Error("Held ready choice not found");
        if (ledger.interrupts.some((i) => i.readyId === r.id && i.status === "pending"))
          throw new Error("Resolve ready interruption before expiry");
        await endHeldConcentration(combatant(combat, r.combatantId), r);
        r.status = "expired";
      } else if (kind === "interrupt-open") {
        const c = combatant(combat, action["combatantId"]);
        if (ledger.interrupts.some((i) => i.id === action["choiceId"]))
          throw new Error("Interruption ID already exists");
        const interruptionKind = action["interruptKind"] as CombatInterrupt["kind"];
        const held = ledger.ready.find((r) => r.id === action["readyId"] && r.status === "held");
        const activityUuid = activityReference(
          c,
          action["activityUuid"] ?? (held?.activityUuid || undefined),
        );
        if (
          ["reaction", "ready", "opportunity"].includes(interruptionKind) &&
          budgetFor(ledger, c).reaction < 1
        )
          throw new Error("Reaction unavailable");
        if (
          interruptionKind === "ready" &&
          !ledger.ready.some(
            (r) => r.id === action["readyId"] && r.combatantId === c.id && r.status === "held",
          )
        )
          throw new Error("Held ready choice required");
        ledger.interrupts.push({
          id: String(action["choiceId"]),
          kind: interruptionKind,
          combatantId: c.id,
          trigger: String(action["trigger"]),
          readyId: action["readyId"] ? String(action["readyId"]) : null,
          status: "pending",
          activityUuid,
          resolutionReceipt: null,
        });
      } else if (kind === "interrupt-resolve") {
        const i = ledger.interrupts.find(
          (i) => i.id === action["choiceId"] && i.status === "pending",
        );
        if (!i) throw new Error("Pending interruption not found");
        if (action["decision"] === "accept") {
          if (i.activityUuid && !action["resolutionReceipt"])
            throw new Error(
              "Native activity execution receipt required before accepting interruption",
            );
          if (["ready", "reaction", "opportunity"].includes(i.kind) && !i.reservedActivityKey)
            spend(budgetFor(ledger, combatant(combat, i.combatantId)), "reaction", 1);
          if (i.readyId) {
            const r = ledger.ready.find((r) => r.id === i.readyId);
            if (r) r.status = "spent";
          }
          i.status = "accepted";
          i.resolutionReceipt = action["resolutionReceipt"]
            ? String(action["resolutionReceipt"])
            : null;
        } else i.status = "declined";
      } else if (kind === "special-decision") {
        const c = combatant(combat, action["combatantId"]);
        ledger.decisions.push({
          kind: String(action["decisionKind"]),
          combatantId: c.id,
          ruling: String(action["ruling"]),
          activityUuid: activityReference(c, action["activityUuid"]),
          round: Number(combat.toObject()["round"]),
          turn: combat.toObject()["turn"] as number | null,
        });
      }
      if (kind !== "ready-expire" || ledger.cursor === cursor(combat))
        ledger.cursor = cursor(combat);
      await saveLedger(input, combat, ledger);
      return {
        kind,
        combatId: combat.id,
        humanRequired: kind === "special-decision",
        nativeResourcesConsumedBy: "native activity activation only",
      };
    },
    () => preflight(input),
  );
}
registerCommand(GM_COMBAT_COMMANDS.READ, readGmCombat);
registerCommand(GM_COMBAT_COMMANDS.APPLY, applyGmCombat);
