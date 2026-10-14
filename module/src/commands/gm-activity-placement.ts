import type { GmActivityInput, GmActivityAction } from "@foundry-local-api/shared";
import { authorizeNative, nativeScene, nativeToken } from "./native-gm-runtime.js";
type Obj = Record<string, any>;
const json = (v: unknown): any =>
  JSON.parse(
    JSON.stringify(v ?? null, (_key, value: unknown) =>
      value instanceof Set ? [...value] : value,
    ),
  );
const native = () => (globalThis as unknown as Obj).dnd5e;
function position(input: GmActivityInput, p: Obj) {
  const scene = nativeScene(input) as unknown as Obj;
  const d = scene.toObject();
  const bounds = scene.dimensions?.sceneRect ?? { x: 0, y: 0, width: d.width, height: d.height };
  if (
    ![p.x, p.y, bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
    p.x < bounds.x ||
    p.y < bounds.y ||
    p.x > bounds.x + bounds.width ||
    p.y > bounds.y + bounds.height
  )
    throw Error("Explicit placement lies outside native scene bounds");
}
function profileActivity(input: GmActivityInput, activity: Obj): Obj {
  const a = input.action;
  const scaling =
    a.scaling ??
    (a.spellSlot
      ? (activity.actor.system.spells[a.spellSlot]?.level ?? Number(a.spellSlot.slice(5))) -
        activity.item.system.level
      : 0);
  if (!scaling) return activity;
  // Same native item preparation as _prepareUsageScaling, without consumption or message creation.
  if (typeof activity.item.clone !== "function")
    throw Error("Native scaled profile preparation unavailable");
  const sourceBefore = JSON.stringify(activity.item.toObject());
  const clone = activity.item.clone({ "flags.dnd5e.scaling": scaling }, { keepId: true });
  if (
    clone === activity.item ||
    clone.uuid !== activity.item.uuid ||
    clone.actor !== activity.actor ||
    typeof clone.prepareFinalAttributes !== "function"
  )
    throw Error("Native scaled profile source provenance unavailable");
  clone.prepareFinalAttributes();
  const prepared = clone.system.activities.get(activity.id);
  if (
    !prepared ||
    prepared.actor !== activity.actor ||
    prepared.uuid !== activity.uuid ||
    JSON.stringify(activity.item.toObject()) !== sourceBefore
  )
    throw Error("Native scaled profile preparation changed real source");
  return prepared;
}
function summonSource(input: GmActivityInput, activity: Obj) {
  const a = input.action.summon!;
  const profile = [...(activity.profiles ?? [])].find((p: Obj) => p._id === a.profileId);
  const actor = game.collections.get("Actor")?.get(a.actorId) as unknown as Obj | undefined;
  if (
    !profile ||
    !Array.isArray(activity.availableProfiles) ||
    !activity.availableProfiles.some((p: Obj) => p._id === profile._id) ||
    !actor ||
    (activity.summon?.mode === "cr"
      ? actor.uuid !== `Actor.${a.actorId}`
      : actor.uuid !== profile.uuid) ||
    actor.isOwner !== true ||
    actor.prototypeToken?.actorLink !== false ||
    actor.prototypeToken.randomImg
  )
    throw Error(
      "Summon requires exact owned existing world Actor profile with unlinked non-wildcard prototype",
    );
  if (activity.summon?.mode === "cr") {
    const simplify = native()?.utils?.simplifyBonus;
    if (typeof simplify !== "function")
      throw Error("Native deterministic summon CR bounds unavailable");
    const max = Number(simplify(profile.cr, activity.getRollData({ deterministic: true }))),
      cr = actor.system.details?.cr;
    if (
      actor.toObject().type !== "npc" ||
      !Number.isFinite(max) ||
      !Number.isFinite(cr) ||
      cr > max ||
      cr < 0 ||
      (profile.types?.size && !profile.types.has(actor.system.details?.type?.value))
    )
      throw Error("Explicit world summon Actor fails exact native CR/type query filters");
  }
  return { actor, profile };
}
function nativeTemplateActivity(input: GmActivityInput, activity: Obj): Obj {
  const scene = nativeScene(input) as unknown as Obj,
    t = activity.target.template;
  const units = scene.grid?.units ?? scene.toObject().grid?.units;
  if (t.units === units) return activity;
  const convert = native()?.utils?.convertLength;
  if (typeof convert !== "function" || typeof activity.item.clone !== "function")
    throw Error("Native strict length conversion/ephemeral template clone unavailable");
  const updates: Obj = {};
  for (const field of ["size", "width", "height"])
    if (t[field] !== undefined && t[field] !== null) {
      const value = convert(t[field], t.units, units);
      if (!Number.isFinite(value) || value < 0)
        throw Error("Native converted template dimension unavailable");
      updates[`system.activities.${activity.id}.target.template.${field}`] = value;
    }
  updates[`system.activities.${activity.id}.target.template.units`] = units;
  const clone = activity.item.clone(updates, { keepId: true }),
    prepared = clone.system.activities.get(activity.id);
  if (
    clone === activity.item ||
    clone.uuid !== activity.item.uuid ||
    prepared.uuid !== activity.uuid ||
    prepared.actor !== activity.actor
  )
    throw Error("Native converted template clone provenance unavailable");
  return prepared;
}
export function placementState(input: GmActivityInput, activity: Obj) {
  const scene = nativeScene(input) as unknown as Obj;
  let summon: Obj | null = null;
  if (input.action.summon) {
    try {
      const prepared = profileActivity(input, activity);
      const { actor, profile } = summonSource(input, prepared);
      summon = {
        actor: json(actor.toObject()),
        prototype: json(actor.prototypeToken.toObject()),
        profile: json(profile),
        availableProfiles: json(prepared.availableProfiles),
      };
    } catch {
      summon = { decisionRequired: true };
    }
  }
  const outputKinds = ["Region", "Token"].map((name) => ({
    name,
    docs: [...scene.getEmbeddedCollection(name).values()].filter((doc: Obj) => {
      if (typeof doc.toObject !== "function") return false;
      const d = doc.toObject(),
        f = d.flags?.dnd5e,
        summoned = d.delta?.flags?.dnd5e?.summon ?? d.delta?.["flags.dnd5e.summon"];
      return name === "Region"
        ? f?.activity === activity.uuid
        : summoned?.origin === activity.item.uuid && summoned?.activity === activity.id;
    }),
  }));
  return {
    sceneGeometry: json({
      width: scene.toObject().width,
      height: scene.toObject().height,
      grid: scene.toObject().grid,
      bounds: scene.dimensions?.sceneRect,
      activeLevelId: (canvas as unknown as Obj).level?.id ?? null,
    }),
    summon,
    existingOutputs: outputKinds.flatMap(({ name, docs }) =>
      docs.slice(0, 256).map((doc: Obj) => ({
        documentName: name,
        id: doc.id,
        uuid: doc.uuid,
        sourceFlags: json(doc.toObject().flags?.["foundry-local-api"]),
        effectIds: name === "Token" ? [...(doc.actor?.effects?.keys() ?? [])] : [],
      })),
    ),
    outputInventory: {
      complete: outputKinds.every(({ docs }) => docs.length <= 256),
      limitPerKind: 256,
      matchedCounts: Object.fromEntries(outputKinds.map(({ name, docs }) => [name, docs.length])),
    },
  };
}
export function placementLimitations(input: GmActivityInput, activity: Obj): string[] {
  const a = input.action,
    reasons: string[] = [];
  try {
    if (a.template) {
      const t = activity.target?.template;
      if (
        !t?.type ||
        typeof native()?.canvas?.AbilityTemplate?.fromActivity !== "function" ||
        typeof (globalThis as unknown as Obj).foundry?.documents?.BaseRegion
          ?._migrateMeasuredTemplateData !== "function"
      )
        throw Error("Exact installed native template factory unavailable");
      nativeTemplateActivity(input, activity);
      if (
        !["circle", "cone", "cube", "line", "sphere", "cylinder", "square", "wall"].includes(
          t.type,
        ) ||
        activity.applicableBehaviors?.length ||
        activity.applicableBehaviors?.size
      )
        throw Error(
          "Modern attached/behavior Regions require native interactive placement; legacy template adapter cannot invent Region automation",
        );
      if (
        !Number.isFinite(t.size) ||
        t.size <= 0 ||
        !Number.isInteger(t.count || 1) ||
        (t.count || 1) !== a.template.placements.length
      )
        throw Error("Exact native template size/count and matching placements required");
      for (const p of a.template.placements) position(input, p);
    } else if (activity.target?.template?.type && a.phase !== "ready")
      throw Error("Explicit native template placements required before consumption");
    if (a.summon) {
      if (
        activity.type !== "summon" ||
        activity.canSummon !== true ||
        typeof activity.getChanges !== "function" ||
        typeof activity.getTokenData !== "function" ||
        typeof activity.getRollData !== "function" ||
        typeof (globalThis as unknown as Obj).Roll !== "function"
      )
        throw Error(
          "Exact native direct summon profile API required; CR query/import requires native human selection",
        );
      summonSource(input, profileActivity(input, activity));
      for (const [field, values] of [
        ["creatureSize", activity.creatureSizes],
        ["creatureType", activity.creatureTypes],
      ] as const) {
        const selected = a.summon[field];
        if ((values?.size && !values.has(selected)) || (selected && !values?.has(selected)))
          throw Error("Explicit valid native summon size/type required");
      }
      for (const p of a.summon.placements) position(input, p);
    } else if (activity.type === "summon" && a.phase !== "ready")
      throw Error("Explicit native summon profile and placements required");
  } catch (e) {
    reasons.push((e as Error).message);
  }
  return reasons;
}
function security(data: Obj, nativeNullOwnership = false): boolean {
  return Object.entries(data).some(
    ([k, v]) =>
      (/(^|\.)(ownership|permission|permissions|actorLink)$/.test(k) &&
        !(nativeNullOwnership && k === "ownership" && v === null)) ||
      (v && typeof v === "object" && security(v, nativeNullOwnership)),
  );
}
export async function placeActivity(
  input: GmActivityInput,
  activity: Obj,
  verifySource: () => void = () => {},
): Promise<Obj> {
  authorizeNative(input);
  const a: GmActivityAction = input.action,
    scene = nativeScene(input) as unknown as Obj;
  const initialCanvas = canvas;
  const sceneGeometry = JSON.stringify(placementState(input, activity).sceneGeometry);
  const sourceActor = (nativeToken(input, a.tokenId) as unknown as Obj).actor;
  const sourceItem = sourceActor.items.get(a.itemId),
    sourceActivity = sourceItem?.system.activities.get(a.activityId);
  const fence = () => {
    authorizeNative(input);
    verifySource();
    if (
      canvas !== initialCanvas ||
      nativeScene(input) !== scene ||
      JSON.stringify(placementState(input, activity).sceneGeometry) !== sceneGeometry ||
      (nativeToken(input, a.tokenId) as unknown as Obj).actor !== sourceActor ||
      sourceActor.items.get(a.itemId) !== sourceItem ||
      sourceItem?.system.activities.get(a.activityId) !== sourceActivity
    )
      throw Error("Native placement source/scene/geometry changed; reconcile without repeating");
  };
  const result: Obj = { templates: [], summons: [] };
  if (a.template) {
    const prepared = nativeTemplateActivity(input, activity);
    const factory = native().canvas.AbilityTemplate.fromActivity(
      prepared,
      a.template.placements[0],
    );
    if (!Array.isArray(factory) || factory.length !== a.template.placements.length)
      throw Error("Native template hook veto/count mismatch after consumption");
    const nativeTemplates = factory.map((template: Obj, i: number) => {
      const p = a.template!.placements[i]!,
        original = template.document.toObject();
      template.document.updateSource({
        x: p.x,
        y: p.y,
        direction: original.t === "rect" ? original.direction : p.direction,
      });
      const d = template.document.toObject();
      delete d._id;
      if (
        d.flags?.dnd5e?.origin !== activity.uuid ||
        d.flags?.dnd5e?.item !== activity.item.uuid ||
        (d.author ?? d.user) !== input.userId ||
        !Number.isFinite(d.distance)
      )
        throw Error("Native template source/geometry proof unavailable");
      return d;
    });
    const core = (globalThis as unknown as Obj).foundry.documents.BaseRegion;
    const data = nativeTemplates.map((template: Obj) => {
      const d = core._migrateMeasuredTemplateData(
        { ...template, author: template.author ?? template.user },
        {
          grid: scene.grid,
          gridTemplates: game.settings.get("core", "gridTemplates"),
          coneTemplateType: game.settings.get("core", "coneTemplateType"),
          users: [...game.users.values()].map((u) => ({ _id: u.id, name: u.name })),
        },
      );
      delete d._id;
      d.flags ??= {};
      d.flags.core ??= {};
      d.flags.core.MeasuredTemplate = true;
      d.flags.dnd5e = {
        ...d.flags.dnd5e,
        activity: activity.uuid,
        item: activity.item.uuid,
        origin: (nativeToken(input, a.tokenId) as unknown as Obj).uuid,
      };
      d.flags["foundry-local-api"] = {
        correlationId: (input as unknown as Obj).correlationId,
        idempotencyKey: (input as unknown as Obj).idempotencyKey,
      };
      if ((canvas as unknown as Obj).level?.id) d.levels = [(canvas as unknown as Obj).level.id];
      const ownership = { default: 0, [input.userId]: 3 };
      if (
        JSON.stringify(d.ownership) !== JSON.stringify(ownership) ||
        !Array.isArray(d.shapes) ||
        d.shapes.length !== 1 ||
        d.behaviors?.length
      )
        throw Error("Native Region geometry/security contract unavailable");
      return d;
    });
    fence();
    const created = await scene.createEmbeddedDocuments("Region", data);
    fence();
    if (created.length !== data.length)
      throw Error(
        "Native Region creation partial; reconcile existingOutputs with original receipt key",
      );
    result.templates = created.map((doc: Obj, i: number) => {
      const persisted = scene.getEmbeddedCollection("Region").get(doc.id),
        d = persisted?.toObject();
      if (!d) throw Error("Native Region persistence acknowledgement unavailable");
      for (const k of [
        "shapes",
        "flags",
        "ownership",
        "levels",
        "elevation",
        "visibility",
        "behaviors",
      ])
        if (JSON.stringify(d[k]) !== JSON.stringify(data[i]![k]))
          throw Error("Native persisted Region differs from native geometry/security factory");
      return {
        regionId: doc.id,
        uuid: doc.uuid,
        nativeData: json(d),
        nativeTemplateData: json(nativeTemplates[i]),
        effectIds: [...(doc.behaviors?.keys() ?? [])],
        ruling: a.template!.ruling,
      };
    });
  }
  if (a.summon) {
    const { actor, profile } = summonSource(input, activity),
      snapshot = JSON.stringify(actor.toObject()),
      prototype = JSON.stringify(actor.prototypeToken.toObject());
    const summonFence = () => {
      fence();
      if (
        (game.collections.get("Actor")?.get(a.summon!.actorId) as unknown) !== actor ||
        JSON.stringify(actor.toObject()) !== snapshot ||
        JSON.stringify(actor.prototypeToken.toObject()) !== prototype ||
        actor.prototypeToken.actorLink !== false
      )
        throw Error("Native summon source identity/security changed before dispatch");
    };
    const options = {
      profile: a.summon.profileId,
      creatureSize: a.summon.creatureSize,
      creatureType: a.summon.creatureType,
    };
    const hooks = Hooks as unknown as Obj;
    if (hooks.call("dnd5e.preSummon", activity, profile, options) === false)
      throw Error("Native summon veto after consumption");
    summonFence();
    const count = new (globalThis as unknown as Obj).Roll(
      profile.count || "1",
      activity.getRollData(),
    );
    await count.evaluate();
    summonFence();
    const n = Number.parseInt(String(count.total), 10);
    if (!Number.isInteger(n) || n < 1 || n > 16 || n > a.summon.placements.length)
      throw Error("Native summon count exceeds explicit placement bound; reconcile without reroll");
    const tokenData: Obj[] = [];
    for (const p of a.summon.placements.slice(0, n)) {
      summonFence();
      const size = a.summon.creatureSize
        ? (CONFIG as unknown as Obj).DND5E.actorSizes[a.summon.creatureSize]
        : null;
      const placement = {
        ...p,
        ...(size ? { width: size.token ?? 1, height: size.token ?? 1 } : {}),
      };
      const changes = await activity.getChanges(actor, profile, options);
      summonFence();
      if (security(changes))
        throw Error("Native summon changes attempted permission/link alteration");
      const config = { actor, placement, ...changes };
      if (hooks.call("dnd5e.preSummonToken", activity, profile, config, options) === false)
        throw Error("Native summon token veto after consumption");
      if (
        config.actor !== actor ||
        security(config.actorUpdates) ||
        security(config.tokenUpdates) ||
        security(config.placement) ||
        actor.prototypeToken.actorLink !== false
      )
        throw Error("Native summon hook altered security");
      summonFence();
      const d = await activity.getTokenData(config);
      summonFence();
      hooks.callAll("dnd5e.summonToken", activity, profile, d, options);
      const flags = d.delta?.flags?.dnd5e?.summon ?? d.delta?.["flags.dnd5e.summon"];
      if (
        d.actorLink !== false ||
        d.actorId !== actor.id ||
        security(d.delta ?? {}, true) ||
        flags?.origin !== activity.item.uuid ||
        flags?.activity !== activity.id ||
        flags?.profile !== profile._id ||
        d.x !== p.x ||
        d.y !== p.y ||
        d.elevation !== p.elevation ||
        d.rotation !== p.rotation
      )
        throw Error(
          "Native summon token binding/security/placement differs from explicit selection",
        );
      summonFence();
      d.flags ??= {};
      d.flags["foundry-local-api"] = {
        correlationId: (input as unknown as Obj).correlationId,
        idempotencyKey: (input as unknown as Obj).idempotencyKey,
      };
      tokenData.push(d);
      if (
        JSON.stringify(actor.toObject()) !== snapshot ||
        JSON.stringify(actor.prototypeToken.toObject()) !== prototype
      )
        throw Error("Summon source actor mutated unexpectedly");
    }
    summonFence();
    const created = await scene.createEmbeddedDocuments("Token", tokenData, {
      dnd5e: { autoRollNPCHP: "no" },
    });
    summonFence();
    hooks.callAll("dnd5e.postSummon", activity, profile, created, options);
    summonFence();
    if (
      created.length !== n ||
      JSON.stringify(actor.toObject()) !== snapshot ||
      JSON.stringify(actor.prototypeToken.toObject()) !== prototype
    )
      throw Error("Native summon partial/source mutation; reconcile without repeating");
    result.summons = created.map((doc: Obj, i: number) => {
      const persisted = scene.getEmbeddedCollection("Token").get(doc.id),
        d = persisted?.toObject();
      if (
        !d ||
        doc.actorLink === true ||
        d.actorLink !== false ||
        d.actorId !== actor.id ||
        JSON.stringify(d.delta) !== JSON.stringify(tokenData[i]!.delta) ||
        JSON.stringify(d.flags?.["foundry-local-api"]) !==
          JSON.stringify(tokenData[i]!.flags?.["foundry-local-api"]) ||
        d.x !== tokenData[i]!.x ||
        d.y !== tokenData[i]!.y ||
        d.elevation !== tokenData[i]!.elevation ||
        d.rotation !== tokenData[i]!.rotation
      )
        throw Error("Native summon persisted delta/security/position not acknowledged");
      const effectIds = [...(doc.actor?.effects?.keys() ?? [])];
      if ((d.delta?.effects ?? []).some((effect: Obj) => !effectIds.includes(effect._id)))
        throw Error("Native summon effect creation not acknowledged");
      return {
        tokenId: doc.id,
        uuid: doc.uuid,
        nativeData: json(d),
        effectIds,
        ruling: a.summon!.ruling,
      };
    });
    result.summonCount = { formula: String(count.formula).slice(0, 1000), total: count.total };
  }
  return result;
}
