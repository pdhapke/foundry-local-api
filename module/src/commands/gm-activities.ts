import {
  GM_ACTIVITIES_COMMANDS,
  type GmActivityAction,
  type GmActivityInput,
  type GmActivityApplyInput,
} from "@foundry-local-api/shared";
import { registerCommand } from "../command-registry.js";
import {
  authorizeNative,
  nativeActor,
  nativeToken,
  runNativeMutation,
  readNativeReceipt,
} from "./native-gm-runtime.js";
import {
  assertCombatActivityBudget,
  spendCombatActivityBudget,
  readHeldSpellState,
  assertHeldSpellReady,
  assertHeldSpellRelease,
  completeHeldSpellReady,
  completeHeldSpellRelease,
} from "./gm-combat.js";
import { placementState, placementLimitations, placeActivity } from "./gm-activity-placement.js";

type Obj = Record<string, any>;
const obj = (value: unknown): Obj => (value && typeof value === "object" ? (value as Obj) : {});
const json = (value: unknown): any =>
  JSON.parse(JSON.stringify(value ?? null, (_key, v: unknown) => (v instanceof Set ? [...v] : v)));
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const member = (value: unknown, values: string[]) =>
  typeof value === "string" && values.includes(value);
function keys(value: Obj, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw Error("Unknown activity parameter");
}
function action(input: GmActivityInput): GmActivityAction {
  const a = obj(input.action);
  keys(a, [
    "mode",
    "tokenId",
    "actorId",
    "itemId",
    "activityId",
    "targetTokenIds",
    "rulesDecisions",
    "advantage",
    "rollMode",
    "damage",
    "phase",
    "ready",
    "release",
    "template",
    "summon",
    "spellSlot",
    "scaling",
    "concentration",
    "attack",
  ]);
  if (
    a.mode !== "use" ||
    ![a.tokenId, a.actorId, a.itemId, a.activityId].every(id) ||
    !Array.isArray(a.targetTokenIds) ||
    a.targetTokenIds.length > 16 ||
    !a.targetTokenIds.every(id) ||
    new Set(a.targetTokenIds).size !== a.targetTokenIds.length ||
    !Array.isArray(a.rulesDecisions) ||
    a.rulesDecisions.length !== a.targetTokenIds.length ||
    !member(a.advantage, ["normal", "advantage", "disadvantage"]) ||
    !member(a.rollMode, ["publicroll", "gmroll", "blindroll", "selfroll"])
  )
    throw Error("Invalid native activity action");
  const seen = new Set();
  for (const d of a.rulesDecisions) {
    keys(obj(d), [
      "targetTokenId",
      "decisionId",
      "edition",
      "range",
      "reach",
      "lineOfEffect",
      "cover",
      "reason",
    ]);
    if (
      !id(d.targetTokenId) ||
      !a.targetTokenIds.includes(d.targetTokenId) ||
      seen.has(d.targetTokenId) ||
      !id(d.decisionId) ||
      !member(d.edition, ["2014", "2024"]) ||
      !member(d.range, ["in-range", "long-range", "out-of-range"]) ||
      !member(d.reach, ["in-reach", "not-applicable", "out-of-reach"]) ||
      typeof d.lineOfEffect !== "boolean" ||
      !member(d.cover, ["none", "half", "three-quarters", "total"]) ||
      typeof d.reason !== "string" ||
      !d.reason.trim() ||
      d.reason.length > 1000
    )
      throw Error("Exact per-target rules decisions required");
    seen.add(d.targetTokenId);
  }
  if (
    a.spellSlot !== undefined &&
    (typeof a.spellSlot !== "string" || !/^(spell[1-9]|pact)$/.test(a.spellSlot))
  )
    throw Error("Invalid spell slot");
  if (a.scaling !== undefined && (!Number.isInteger(a.scaling) || a.scaling < 0 || a.scaling > 9))
    throw Error("Invalid scaling");
  if (a.damage !== undefined && typeof a.damage !== "boolean")
    throw Error("Invalid damage selection");
  if (a.phase !== undefined && !member(a.phase, ["ready", "release"]))
    throw Error("Invalid held spell phase");
  if (
    (a.phase === "ready") !== (a.ready !== undefined) ||
    (a.phase === "release") !== (a.release !== undefined)
  )
    throw Error("Exact phase and held spell choice required");
  if (a.ready !== undefined) {
    keys(obj(a.ready), ["choiceId", "trigger", "ruling"]);
    if (
      !id(a.ready.choiceId) ||
      ![a.ready.trigger, a.ready.ruling].every(
        (v) => typeof v === "string" && v.trim() && v.length <= 2000,
      )
    )
      throw Error("Invalid ready choice");
  }
  if (a.release !== undefined) {
    keys(obj(a.release), ["readyId", "castReceipt"]);
    if (![a.release.readyId, a.release.castReceipt].every(id))
      throw Error("Invalid release binding");
  }
  for (const kind of ["template", "summon"]) {
    const p = a[kind];
    if (p === undefined) continue;
    keys(
      obj(p),
      kind === "template"
        ? ["placements", "ruling"]
        : ["profileId", "actorId", "creatureSize", "creatureType", "placements", "ruling"],
    );
    if (
      typeof p.ruling !== "string" ||
      !p.ruling.trim() ||
      p.ruling.length > 2000 ||
      !Array.isArray(p.placements) ||
      !p.placements.length ||
      p.placements.length > 16
    )
      throw Error("Invalid placement choice");
    if (
      kind === "summon" &&
      (![p.profileId, p.actorId].every(id) ||
        (p.creatureSize !== undefined && !id(p.creatureSize)) ||
        (p.creatureType !== undefined && !id(p.creatureType)))
    )
      throw Error("Invalid summon choice");
    for (const at of p.placements) {
      keys(
        obj(at),
        kind === "template" ? ["x", "y", "direction"] : ["x", "y", "elevation", "rotation"],
      );
      if (
        ![at.x, at.y, kind === "template" ? at.direction : at.rotation].every(Number.isFinite) ||
        (kind === "template" ? at.direction : at.rotation) < 0 ||
        (kind === "template" ? at.direction : at.rotation) > 360 ||
        (kind === "summon" && (!Number.isFinite(at.elevation) || Math.abs(at.elevation) > 10000))
      )
        throw Error("Invalid explicit placement");
    }
  }
  if (a.concentration !== undefined) {
    keys(obj(a.concentration), ["begin", "endEffectId"]);
    if (
      a.concentration.begin !== true ||
      (a.concentration.endEffectId !== undefined && !id(a.concentration.endEffectId))
    )
      throw Error("Explicit concentration choice required");
  }
  if (a.attack !== undefined) {
    keys(obj(a.attack), ["abilityId", "ammunitionId", "attackMode", "mastery"]);
    if (!id(a.attack.abilityId) || Object.values(a.attack).some((v) => !id(v)))
      throw Error("Invalid attack choice");
  }
  return a as GmActivityAction;
}
function source(input: GmActivityInput) {
  authorizeNative(input);
  const a = action(input),
    actor = nativeActor(input, a.tokenId, a.actorId) as unknown as Obj;
  const token = nativeToken(input, a.tokenId) as unknown as Obj;
  const item = actor.items?.get(a.itemId),
    activity = item?.system.activities?.get(a.activityId);
  if (!item || !activity || typeof activity.use !== "function")
    throw Error("Native activity unavailable");
  const targets = a.targetTokenIds.map((tokenId) => {
    const target = nativeToken(input, tokenId) as unknown as Obj;
    if (!target.actor) throw Error("Target actor unavailable");
    return target;
  });
  return { a, actor, token, item, activity, targets };
}
function revision(doc: Obj) {
  return obj(doc.toObject())._stats?.modifiedTime ?? null;
}
function tokenState(token: Obj) {
  const d = obj(token.toObject());
  return {
    tokenId: token.id,
    actorId: token.actor?.id ?? null,
    actorUuid: token.actor?.uuid ?? null,
    revision: revision(token),
    actorRevision: token.actor ? revision(token.actor) : null,
    x: d.x ?? null,
    y: d.y ?? null,
    elevation: d.elevation ?? null,
    ac: json(token.actor?.system.attributes?.ac),
    statuses: [...(token.actor?.statuses ?? [])],
  };
}
function targetingBinding(src: ReturnType<typeof source>) {
  const {
    actorRevision: _actorRevision,
    ac: _ac,
    statuses: _statuses,
    ...sourceToken
  } = tokenState(src.token);
  const targets = src.targets.map((token) => {
    const state = tokenState(token);
    if (token.actor !== src.actor) return state;
    // Native use updates the source actor's own revision/resources/concentration.
    const { actorRevision: _revision, ...ownTarget } = state;
    if (src.activity.type === "attack") return ownTarget;
    const { ac: _ownAC, statuses: _ownStatuses, ...ownNonAttackTarget } = ownTarget;
    return ownNonAttackTarget;
  });
  return JSON.stringify({ sourceToken, targets });
}
function resources(actor: Obj) {
  if (actor.items.size > 256) throw Error("Actor inventory exceeds activity snapshot bound");
  return {
    spells: json(actor.system.spells),
    resources: json(actor.system.resources),
    items: [...actor.items.values()].map((item: Obj) => ({
      itemId: item.id,
      revision: revision(item),
      quantity: item.system.quantity ?? null,
      uses: json(item.system.uses),
      activities: [...(item.system.activities?.values() ?? [])].map((a: Obj) => ({
        activityId: a.id,
        uses: json(a.uses),
      })),
    })),
  };
}
function stable(v: unknown): string {
  return JSON.stringify(v, (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );
}
function activityConfiguration(src: ReturnType<typeof source>) {
  const data = json(src.item.toObject());
  delete data._stats;
  if (data.system) {
    delete data.system.quantity;
    if (data.system.uses) delete data.system.uses.spent;
    for (const activity of Object.values(data.system.activities ?? {}) as Obj[])
      if (activity.uses) delete activity.uses.spent;
  }
  return data;
}
async function validateRelease(input: GmActivityInput, src: ReturnType<typeof source>) {
  const held = await assertHeldSpellRelease(input);
  const cast = await readNativeReceipt(input, String(held.castReceiptKey));
  if (stable(obj(cast?.data)["heldConfiguration"]) !== stable(activityConfiguration(src)))
    throw Error("Held spell source configuration changed since original cast");
  return held;
}
function heldState(input: GmActivityInput): Record<string, unknown> | null {
  try {
    return readHeldSpellState(input);
  } catch {
    return {
      decisionRequired: true,
      reason: "Exact started combat, initialized budget and real held spell source required",
    };
  }
}
function readyActivity(src: ReturnType<typeof source>): Obj {
  const before = stable(src.item.toObject());
  const clone = src.item.clone(
    { [`system.activities.${src.activity.id}.duration.concentration`]: true },
    { keepId: true },
  );
  const activating = clone?.system.activities.get(src.activity.id);
  if (
    !activating ||
    activating.duration?.concentration !== true ||
    activating.uuid !== src.activity.uuid ||
    activating.actor !== src.actor ||
    clone.actor !== src.actor ||
    clone.id !== src.item.id ||
    clone.uuid !== src.item.uuid ||
    clone.isEmbedded !== true ||
    clone === src.item ||
    stable(src.item.toObject()) !== before
  )
    throw Error("Native ephemeral held concentration clone/source provenance unavailable");
  return activating;
}
function limitations(src: ReturnType<typeof source>, input: GmActivityInput): string[] {
  const { a, activity, item, actor } = src,
    reasons: string[] = [];
  if (
    a.phase === "ready" &&
    (a.targetTokenIds.length ||
      a.attack ||
      a.damage ||
      a.template ||
      a.summon ||
      typeof item.clone !== "function")
  )
    reasons.push(
      "Ready cast requires no outcome targets/rolls/placements and native ephemeral item clone",
    );
  if (a.phase === "ready" && typeof item.clone === "function") {
    try {
      readyActivity(src);
    } catch {
      reasons.push("Native ephemeral held concentration clone/source provenance unavailable");
    }
  }
  if (a.phase === "release" && a.concentration)
    reasons.push(
      "Held release concentration is bound to original cast; arbitrary replacement forbidden",
    );
  if (a.damage) {
    if (typeof activity.rollDamage !== "function" || typeof activity.getDamageConfig !== "function")
      reasons.push("Native activity damage/healing unavailable");
    else {
      const config = activity.getDamageConfig({
        ability: a.attack?.abilityId,
        attackMode: a.attack?.attackMode,
        ammunition: a.attack?.ammunitionId ? actor.items.get(a.attack.ammunitionId) : undefined,
      });
      if (!Array.isArray(config.rolls) || !config.rolls.length || config.rolls.length > 16)
        reasons.push("Native bounded damage configuration unavailable");
      if (
        config.rolls?.some(
          (roll: Obj) => (roll.options?.types?.size ?? roll.options?.types?.length ?? 0) > 1,
        )
      )
        reasons.push("Native damage type selection requires explicit human workflow");
    }
  }
  if (!["attack", "save", "utility", "damage", "heal", "summon"].includes(activity.type))
    reasons.push("Activity type requires human native workflow");
  reasons.push(...placementLimitations(input, activity));
  if (activity.getLinkedActivity?.())
    reasons.push("Linked activity requires human native workflow");
  if (activity.canUse === false || item.isOwner === false || item.isEmbedded === false)
    reasons.push("Native activity cannot currently be used");
  if (activity.requiresSpellSlot && activity.consumption?.spellSlot && !a.spellSlot)
    reasons.push("Explicit spell slot/upcast choice required");
  if (a.spellSlot) {
    const slot = actor.system.spells?.[a.spellSlot],
      level = slot?.level ?? Number(a.spellSlot.slice(5));
    if (
      !activity.requiresSpellSlot ||
      !activity.consumption?.spellSlot ||
      !slot ||
      (!(slot.value > 0) && a.phase !== "release") ||
      level < item.system.level
    )
      reasons.push("Invalid, unavailable or inapplicable native spell slot");
    if (a.scaling !== undefined && a.scaling !== level - item.system.level)
      reasons.push("Scaling must match explicit native slot level");
  } else if (activity.canScale && a.scaling === undefined)
    reasons.push("Explicit native resource scaling choice required");
  if (
    (activity.requiresConcentration || a.phase === "ready") &&
    a.phase !== "release" &&
    !a.concentration
  )
    reasons.push("Explicit concentration begin/replacement choice required");
  if (
    (activity.requiresConcentration || a.phase === "ready") &&
    a.phase !== "release" &&
    (actor.concentration?.effects?.size ?? 0) >=
      (actor.system.attributes?.concentration?.limit ?? 1) &&
    !a.concentration?.endEffectId
  )
    reasons.push("Explicit existing concentration replacement effect required");
  if (a.concentration && !activity.requiresConcentration && a.phase !== "ready")
    reasons.push("Concentration choice is inapplicable");
  if (
    a.concentration?.endEffectId &&
    ![...(actor.concentration?.effects?.values() ?? [])].some(
      (e: Obj) => e.id === a.concentration?.endEffectId,
    )
  )
    reasons.push("Concentration replacement effect unavailable");
  if (
    (activity.requiresConcentration || a.phase) &&
    game.settings.get("dnd5e", "disableConcentration") === true
  )
    reasons.push("Native concentration automation disabled; human native workflow required");
  for (const d of a.rulesDecisions) {
    if (
      !d.lineOfEffect ||
      d.cover === "total" ||
      d.range === "out-of-range" ||
      d.reach === "out-of-reach"
    )
      reasons.push(`Target ${d.targetTokenId} denied by explicit rules decision`);
    if (d.range === "long-range" && a.advantage === "normal")
      reasons.push("Long-range disadvantage/advantage cancellation needs explicit decision");
    const target = src.targets.find((t) => t.id === d.targetTokenId),
      ac = target?.actor?.system.attributes?.ac;
    if (target?.actor?.statuses?.has("coverTotal")) reasons.push("Native target has total cover");
    if (Number.isFinite(ac?.override) && d.cover !== "none")
      reasons.push("Native AC override with cover requires human native adjudication");
  }
  if (activity.type === "attack" && a.phase !== "ready") {
    if (!a.attack || src.targets.length !== 1)
      reasons.push("Single-target attack with explicit native choices required");
    if (typeof activity.rollAttack !== "function") reasons.push("Native attack roll unavailable");
    const choices = a.attack;
    const abilities = activity._getAbilityOptions?.() ?? [];
    if (choices && !abilities.some((v: Obj) => v.value === choices.abilityId))
      reasons.push("Native attack ability choice unavailable");
    for (const [name, field, selected] of [
      ["ammunition", "ammunitionOptions", choices?.ammunitionId],
      ["mode", "attackModes", choices?.attackMode],
      ["mastery", "masteryOptions", choices?.mastery],
    ]) {
      const values = item.system[field as string] ?? [];
      if (values.length && !values.some((v: Obj) => v.value === selected && !v.disabled))
        reasons.push(`Explicit native attack ${name} choice required`);
      if (selected && !values.some((v: Obj) => v.value === selected && !v.disabled))
        reasons.push(`Invalid native attack ${name}`);
    }
    if (!Number.isFinite(src.targets[0]?.actor?.system.attributes?.ac?.value))
      reasons.push("Native target AC unavailable");
    const prototype = (CONFIG as unknown as Obj).ChatMessage?.dataModels?.attack?.prototype;
    if (!prototype || !Object.getOwnPropertyDescriptor(prototype, "evaluatedTargets")?.get)
      reasons.push("Native hit evaluator unavailable");
  } else if (a.attack) reasons.push("Attack choices are inapplicable to activity type");
  return reasons;
}
export function gmActivitiesRead(input: GmActivityInput): Record<string, unknown> {
  authorizeNative(input);
  const a = action(input),
    actor = nativeActor(input, a.tokenId, a.actorId) as unknown as Obj;
  const item = actor.items?.get(a.itemId);
  if (!item || !item.system.activities?.get(a.activityId))
    return {
      source: tokenState(nativeToken(input, a.tokenId) as unknown as Obj),
      itemId: a.itemId,
      activityId: a.activityId,
      itemMissing: !item,
      activityMissing: true,
      resources: resources(actor),
      targets: a.targetTokenIds.map((tokenId) =>
        tokenState(nativeToken(input, tokenId) as unknown as Obj),
      ),
      humanRequired: ["Source item/activity no longer exists; reconcile consumed/deleted resource"],
    };
  const src = source(input);
  let combatBudget: Record<string, unknown> | null;
  try {
    combatBudget = assertCombatActivityBudget(
      input,
      src.a.tokenId,
      String(src.activity.activation?.type ?? ""),
    );
  } catch {
    combatBudget = {
      decisionRequired: true,
      reason:
        "Initialize/reconcile the current native turn budget and interruption before activation",
    };
  }
  const heldSpell = heldState(input);
  return {
    source: tokenState(src.token),
    itemId: src.item.id,
    itemRevision: revision(src.item),
    activityId: src.activity.id,
    activityType: src.activity.type,
    activation: json(src.activity.activation),
    range: json(src.activity.range ?? src.item.system.range),
    target: json(src.activity.target),
    save: json(src.activity.save),
    consumption: json(src.activity.consumption),
    resources: resources(src.actor),
    concentration: [...(src.actor.concentration?.effects?.values() ?? [])].map((e: Obj) => ({
      effectId: e.id,
      revision: revision(e),
    })),
    targets: src.targets.map(tokenState),
    choices: {
      abilities: json(src.activity._getAbilityOptions?.() ?? []),
      attackModes: json(src.item.system.attackModes ?? []),
      ammunition: json(src.item.system.ammunitionOptions ?? []),
      mastery: json(src.item.system.masteryOptions ?? []),
    },
    combatBudget,
    activityConfiguration: activityConfiguration(src),
    heldSpell,
    placement: placementState(input, src.activity),
    humanRequired: [
      ...limitations(src, input),
      ...(heldSpell?.decisionRequired ? [String(heldSpell.reason)] : []),
      ...(combatBudget?.decisionRequired ? [String(combatBudget.reason)] : []),
    ],
  };
}
async function withTargets<T>(src: ReturnType<typeof source>, work: () => Promise<T>): Promise<T> {
  const user = game.user as unknown as Obj;
  if (typeof user.updateTokenTargets !== "function" || !user.targets)
    throw Error("Native explicit targeting unavailable");
  const prior = [...user.targets].map((t: Obj) => t.id);
  try {
    await user.updateTokenTargets(src.a.targetTokenIds);
    if (
      JSON.stringify([...user.targets].map((t: Obj) => t.id).sort()) !==
      JSON.stringify([...src.a.targetTokenIds].sort())
    )
      throw Error("Explicit native targets did not acknowledge");
    return await work();
  } finally {
    await user.updateTokenTargets(prior);
  }
}
function verifyMessage(
  messageId: string,
  src: ReturnType<typeof source>,
  input: GmActivityApplyInput,
  before: Set<string>,
) {
  const message = game.collections.get("ChatMessage")?.get(messageId) as unknown as Obj | undefined;
  if (!message || before.has(messageId)) throw Error("New native message readback unavailable");
  const data = message.toObject(),
    expected =
      src.a.rollMode === "publicroll"
        ? []
        : src.a.rollMode === "selfroll"
          ? [input.userId]
          : [...game.users.values()].filter((u) => u.isGM).map((u) => u.id);
  if (
    JSON.stringify([...(data.whisper ?? [])].sort()) !== JSON.stringify(expected.sort()) ||
    Boolean(data.blind) !== (src.a.rollMode === "blindroll")
  )
    throw Error("Native message privacy acknowledgement mismatch");
  if (
    data.flags?.["foundry-local-api"]?.correlationId !== input.correlationId ||
    data.speaker?.actor !== src.actor.id ||
    data.speaker?.scene !== input.sceneId
  )
    throw Error("Native message correlation/speaker scope mismatch");
  const descriptors = data.system?.targets;
  if (
    !Array.isArray(descriptors) ||
    JSON.stringify(descriptors.map((t: Obj) => t.token).sort()) !==
      JSON.stringify(src.targets.map((t) => t.uuid).sort())
  )
    throw Error("Native message targets differ from explicit scope");
  return message;
}
export function gmActivitiesApply(input: GmActivityApplyInput) {
  return runNativeMutation(
    input,
    () => gmActivitiesRead(input),
    async () => {
      const src = source(input),
        reasons = limitations(src, input);
      const held = src.a.phase === "release" ? await validateRelease(input, src) : null;
      const initialCanvas = canvas;
      const initialGeometry = JSON.stringify(placementState(input, src.activity).sceneGeometry);
      const initialConfiguration = JSON.stringify(activityConfiguration(src));
      const initialTargeting = targetingBinding(src);
      const verifyTargeting = () => {
        authorizeNative(input);
        if (
          canvas !== initialCanvas ||
          JSON.stringify(placementState(input, src.activity).sceneGeometry) !== initialGeometry ||
          nativeToken(input, src.a.tokenId) !== src.token
        )
          throw Error("Native canvas/scene/level/source token changed during activity");
        const selected = [...((game.user as unknown as Obj).targets ?? [])]
          .map((t: Obj) => t.id)
          .sort();
        if (JSON.stringify(selected) !== JSON.stringify([...src.a.targetTokenIds].sort()))
          throw Error("Native target selection changed during activity; reconcile without reroll");
        if (targetingBinding(src) !== initialTargeting)
          throw Error(
            "Native target/source position, binding or target rules state changed; reconcile without reroll",
          );
        if (src.a.phase && JSON.stringify(activityConfiguration(src)) !== initialConfiguration)
          throw Error("Held spell configuration changed during native workflow");
        if (nativeActor(input, src.a.tokenId, src.a.actorId) !== src.actor)
          throw Error("Native source actor document changed");
        for (const target of src.targets)
          if (
            nativeToken(input, target.id) !== target ||
            (nativeToken(input, target.id) as unknown as Obj).actor !== target.actor
          )
            throw Error("Native target actor document changed");
      };
      if (reasons.length) throw Error(`Human-required: ${reasons.join("; ")}`);
      const hooks = Hooks as unknown as Obj;
      if (typeof hooks.on !== "function" || typeof hooks.off !== "function")
        throw Error("Native usage correlation hooks unavailable");
      return withTargets(src, async () => {
        await spendCombatActivityBudget(
          input,
          src.a.tokenId,
          String(src.activity.activation?.type ?? ""),
        );
        verifyTargeting();
        const beforeMessages = new Set(game.collections.get("ChatMessage")?.keys() ?? []);
        const concentrationBefore = new Set(
          [...(src.actor.concentration?.effects?.values() ?? [])].map((e: Obj) => e.id),
        );
        let used: Obj | undefined;
        const hook = hooks.on(
          "dnd5e.postUseActivity",
          (activity: Obj, _config: Obj, result: Obj) => {
            if (
              activity.id === src.activity.id &&
              activity.actor?.id === src.actor.id &&
              result.message?.flags?.["foundry-local-api"]?.correlationId === input.correlationId
            )
              used = activity;
          },
        );
        try {
          let activating = src.activity;
          if (src.a.phase === "ready") activating = readyActivity(src);
          const concentration = held
            ? held.originalConcentration
              ? { begin: true, end: held.concentrationEffectId }
              : { begin: false, end: false }
            : src.a.concentration
              ? { begin: true, end: src.a.concentration.endEffectId ?? null }
              : undefined;
          const usage = {
            create: false,
            subsequentActions: false,
            ...(src.a.spellSlot ? { spell: { slot: src.a.spellSlot } } : {}),
            ...(src.a.scaling !== undefined ? { scaling: src.a.scaling } : {}),
            ...(concentration ? { concentration } : {}),
            ...(held ? { consume: false } : {}),
          };
          const result = await activating.use(
            usage,
            { configure: false },
            {
              create: true,
              rollMode: src.a.rollMode,
              data: {
                flags: {
                  "foundry-local-api": {
                    correlationId: input.correlationId,
                    idempotencyKey: input.idempotencyKey,
                  },
                },
              },
            },
          );
          if (!result?.message?.id || !used)
            throw Error(
              "Native activity cancelled or acknowledgement missing; reconcile resources before retry",
            );
          const usageMessage = verifyMessage(result.message.id, src, input, beforeMessages);
          if (src.a.template || src.a.summon) {
            const scaledReasons = placementLimitations(input, used);
            if (scaledReasons.length)
              throw Error(
                "Scaled native placement eligibility unavailable; reconcile without repeating",
              );
          }
          verifyTargeting();
          let concentrationEffectId: string | null = null;
          if (concentration?.begin) {
            const maintained = [...(src.actor.concentration?.effects?.values() ?? [])] as Obj[];
            const created = maintained.filter((e) => !concentrationBefore.has(e.id));
            if (
              created.length !== 1 ||
              !(result.effects ?? []).some((e: Obj) => e.id === created[0]!.id) ||
              (concentration.end && maintained.some((e) => e.id === concentration.end))
            )
              throw Error(
                "Native concentration begin/replacement completion not verified; reconcile without reactivation",
              );
            concentrationEffectId = created[0]!.id;
          }
          if (src.a.phase === "ready") await completeHeldSpellReady(input, concentrationEffectId!);
          let attack: Obj | null = null;
          let damageConfig: Obj = { isCritical: false };
          let damageOrigin = result.message.id;
          if (src.a.attack) {
            const choice = src.a.attack,
              target = src.targets[0]!,
              d = src.a.rulesDecisions[0]!;
            const coverBonus = d.cover === "half" ? 2 : d.cover === "three-quarters" ? 5 : 0;
            const targetAC =
              target.actor.system.attributes.ac.value +
              Math.max(0, coverBonus - (target.actor.system.attributes.ac.cover ?? 0));
            const ammunition = choice.ammunitionId
              ? src.actor.items.get(choice.ammunitionId)
              : undefined;
            const rolls = await used.rollAttack(
              {
                target: targetAC,
                ability: choice.abilityId,
                ammunition: choice.ammunitionId ?? false,
                attackMode: choice.attackMode ?? false,
                mastery: choice.mastery ?? false,
                rolls: [
                  {
                    options:
                      src.a.advantage === "advantage"
                        ? { advantage: true }
                        : src.a.advantage === "disadvantage"
                          ? { disadvantage: true }
                          : {},
                  },
                ],
              },
              { configure: false },
              {
                create: true,
                rollMode: src.a.rollMode,
                data: {
                  system: {
                    origin: result.message.id,
                    targets: usageMessage
                      .toObject()
                      .system.targets.map((descriptor: Obj) => ({ ...descriptor, ac: targetAC })),
                  },
                  flags: { "foundry-local-api": { correlationId: input.correlationId } },
                },
              },
            );
            if (
              !Array.isArray(rolls) ||
              rolls.length !== 1 ||
              !Number.isFinite(rolls[0].total) ||
              typeof rolls[0].formula !== "string"
            )
              throw Error(
                "Attack roll cancelled or unavailable after activity use; reconcile without reroll",
              );
            verifyTargeting();
            const roll = rolls[0],
              prototype = (CONFIG as unknown as Obj).ChatMessage.dataModels.attack.prototype;
            const attackMessage = verifyMessage(roll.parent?.id, src, input, beforeMessages);
            if (attackMessage.toObject().system?.origin !== result.message.id)
              throw Error("Native attack is not linked to activity use");
            if (attackMessage.toObject().system?.targets?.[0]?.ac !== targetAC)
              throw Error("Native attack target AC differs from explicit cover decision");
            const evaluated = Object.getOwnPropertyDescriptor(
              prototype,
              "evaluatedTargets",
            )!.get!.call({ parent: { rolls }, targets: [{ ac: targetAC }] });
            if (evaluated.length !== 1 || typeof evaluated[0].isMiss !== "boolean")
              throw Error("Native hit outcome acknowledgement unavailable");
            attack = {
              targetTokenId: target.id,
              formula: String(roll.formula).slice(0, 1000),
              total: roll.total,
              critical: roll.isCritical === true,
              fumble: roll.isFumble === true,
              hit: !evaluated[0].isMiss,
              messageId: attackMessage.id,
              targetAC,
              coverBonus,
              nativeCover: target.actor.system.attributes.ac.cover ?? 0,
              options: json(roll.options),
            };
            damageConfig = {
              isCritical: roll.isCritical === true,
              ability: roll.options?.ability,
              attackMode: roll.options?.attackMode,
              ammunition,
            };
            damageOrigin = attackMessage.id;
          }
          let damage: Obj[] | null = null;
          if (src.a.damage && (!attack || attack.hit)) {
            verifyTargeting();
            const rolls = await used.rollDamage(
              damageConfig,
              { configure: false },
              {
                create: true,
                rollMode: src.a.rollMode,
                data: {
                  system: { origin: result.message.id },
                  flags: {
                    "foundry-local-api": {
                      correlationId: input.correlationId,
                      attackMessageId: attack?.messageId ?? null,
                    },
                  },
                },
              },
            );
            if (!Array.isArray(rolls) || !rolls.length || rolls.length > 16)
              throw Error("Native linked damage cancelled/unavailable; reconcile without reroll");
            verifyTargeting();
            damage = rolls.map((roll: Obj) => {
              const native = (CONFIG as unknown as Obj).DND5E;
              if (
                !Number.isFinite(roll.total) ||
                typeof roll.formula !== "string" ||
                typeof roll.options?.type !== "string" ||
                !Object.hasOwn(
                  { ...native?.damageTypes, ...native?.healingTypes },
                  roll.options.type,
                )
              )
                throw Error("Native typed damage evidence unavailable");
              if (Boolean(roll.isCritical) !== Boolean(damageConfig.isCritical))
                throw Error("Native damage critical linkage differs from original attack");
              const message = verifyMessage(roll.parent?.id, src, input, beforeMessages);
              if (
                message.toObject().system?.origin !== result.message.id ||
                message.toObject().flags?.["foundry-local-api"]?.attackMessageId !==
                  (attack?.messageId ?? null)
              )
                throw Error("Native damage message linkage unavailable");
              return {
                messageId: message.id,
                sourceMessageId: damageOrigin,
                formula: String(roll.formula).slice(0, 1000),
                value: roll.total,
                type: roll.options.type,
                properties: [...(roll.options.properties ?? [])],
                critical: damageConfig.isCritical === true,
                nativeOptions: json(roll.options),
              };
            });
          }
          const placement = await placeActivity(input, used, verifyTargeting);
          verifyTargeting();
          if (src.a.phase === "release") await completeHeldSpellRelease(input);
          return {
            phase: src.a.phase ?? null,
            heldConfiguration: src.a.phase === "ready" ? activityConfiguration(src) : null,
            placement,
            messageId: result.message.id,
            activityUuid:
              used.uuid ?? `${src.actor.uuid}.Item.${src.item.id}.Activity.${src.activity.id}`,
            updates: json(result.updates),
            effects: (result.effects ?? []).map((e: Obj) => e.id),
            resourcesAfter: resources(src.actor),
            attack,
            damage,
            save: json(used.save),
            rulesDecisions: src.a.rulesDecisions,
            followUp: {
              humanRequired: true,
              reason: src.a.damage
                ? "Native typed rolls are complete. Apply these exact components through the separate typed damage/healing operation; target saves, save multipliers and effects require explicit human decisions. Do not reactivate or reroll."
                : "Damage rolling was not selected; use human native chat UI for later activity-linked outcome steps. Do not activate or spend again.",
            },
          };
        } finally {
          hooks.off("dnd5e.postUseActivity", hook);
        }
      });
    },
    async () => {
      const reasons = limitations(source(input), input);
      if (reasons.length) throw Error(`Human-required: ${reasons.join("; ")}`);
      const src = source(input);
      if (src.a.phase === "ready") assertHeldSpellReady(input);
      if (src.a.phase === "release") await validateRelease(input, src);
      assertCombatActivityBudget(input, src.a.tokenId, String(src.activity.activation?.type ?? ""));
    },
  );
}
registerCommand(GM_ACTIVITIES_COMMANDS.READ, gmActivitiesRead);
registerCommand(GM_ACTIVITIES_COMMANDS.APPLY, gmActivitiesApply);
