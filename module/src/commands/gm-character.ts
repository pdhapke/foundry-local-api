import {
  GM_CHARACTER_COMMANDS,
  validateGmCharacterAction,
  type NativeGmInput,
  type NativeGmApplyInput,
} from "@foundry-local-api/shared";
import { registerCommand } from "../command-registry.js";
import { authorizeNative, nativeActor, runNativeMutation } from "./native-gm-runtime.js";

type Doc = FoundryDocument & {
  system: Record<string, any>;
  items: Map<string, Doc>;
  effects: Map<string, Doc>;
  statuses: Set<string>;
  concentration?: { effects: Set<Doc> };
  testUserPermission(user: unknown, level: string): boolean;
  applyDamage(components: unknown[], options: Record<string, unknown>): Promise<Doc>;
  toggleStatusEffect(id: string, options: Record<string, unknown>): Promise<unknown>;
  endConcentration(id: string): Promise<Doc[]>;
  [key: string]: any;
};
const record = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
const config = () => record((CONFIG as unknown as Record<string, unknown>)["DND5E"]);
const statusConfig = (id: string) =>
  record((CONFIG as unknown as Record<string, unknown>)["statusEffects"])[id];
const nativeCurrencyManager = () =>
  record(record((globalThis as unknown as Record<string, unknown>)["dnd5e"])["applications"])[
    "CurrencyManager"
  ] as { convertCurrency(actor: Doc): Promise<Doc> } | undefined;
const clone = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value ?? null, (_key, v: unknown) => (v instanceof Set ? [...v] : v)));
function actorFor(input: NativeGmInput): Doc {
  return nativeActor(
    input,
    String(input.action["tokenId"]),
    input.action["actorId"] as string | undefined,
  ) as unknown as Doc;
}
function settings(): Record<string, unknown> {
  const dnd = record((globalThis as unknown as Record<string, unknown>)["dnd5e"]);
  return {
    rulesVersion: record(dnd["settings"])["rulesVersion"] ?? null,
    restVariant: game.settings.get("dnd5e", "restVariant"),
    exhaustionDisabled: game.settings.get("dnd5e", "disableExhaustion"),
  };
}
function messages(): Doc[] {
  return [...(game.collections.get("ChatMessage")?.values() ?? [])] as Doc[];
}
function actorState(actor: Doc): Record<string, unknown> {
  const system = actor.system;
  const attrs = record(system["attributes"]);
  return {
    actorId: actor.id,
    hp: clone(attrs["hp"]),
    death: clone(attrs["death"]),
    xp: clone(record(system["details"])["xp"]),
    attunement: clone(attrs["attunement"]),
    exhaustion: clone(attrs["exhaustion"]),
    conditions: clone(system["conditions"]),
    movement: clone(attrs["movement"]),
    ac: clone(attrs["ac"]),
    skills: clone(system["skills"]),
    tools: clone(system["tools"]),
    abilities: clone(system["abilities"]),
    resources: clone(system["resources"]),
    spells: clone(system["spells"]),
    currency: clone(system["currency"]),
    traits: clone(system["traits"]),
    encumbrance: clone(attrs["encumbrance"]),
    statuses: [...(actor.statuses ?? [])].sort(),
    concentrationEffectIds: [...(actor.concentration?.effects ?? [])].map((e) => e.id).sort(),
    effects: [...(actor.effects?.values() ?? [])]
      .map((e) => ({ id: e.id, data: e.toObject() }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    items: [...(actor.items?.values() ?? [])]
      .map((i) => ({
        id: i.id,
        type: i.toObject()["type"],
        name: i.toObject()["name"],
        quantity: clone(i.system["quantity"]),
        equipped: clone(i.system["equipped"]),
        attunement: clone(i.system["attunement"]),
        attuned: clone(i.system["attuned"]),
        uses: clone(i.system["uses"]),
        hd: clone(i.system["hd"]),
        weight: clone(i.system["weight"]),
        container: clone(i.system["container"]),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    settings: settings(),
    concentrationPrompts: messages()
      .filter(
        (m) =>
          record(m.toObject()["speaker"])["actor"] === actor.id &&
          Array.isArray(m.system?.["buttons"]) &&
          m.system["buttons"].some((b: unknown) =>
            ["concentration", "endConcentration"].includes(record(b)["type"]),
          ),
      )
      .map((m) => m.id)
      .sort(),
  };
}
export function gmCharacterRead(input: NativeGmInput): Record<string, unknown> {
  authorizeNative(input);
  validateGmCharacterAction(input.action);
  if (input.action["kind"] === "party.roster") {
    const users = [...game.users.values()] as unknown as Array<{
      id: string;
      active: boolean;
      isGM: boolean;
      character?: Doc;
    }>;
    const actors = [...(game.collections.get("Actor")?.values() ?? [])] as Doc[];
    return {
      sceneId: input.sceneId,
      members: users
        .filter((u) => !u.isGM)
        .map((u) => ({
          userId: u.id,
          active: u.active,
          characterId: u.character?.id ?? null,
          ownedActorIds: actors
            .filter((a) => a.testUserPermission(u, "OWNER"))
            .map((a) => a.id)
            .sort(),
        }))
        .sort((a, b) => a.userId.localeCompare(b.userId)),
    };
  }
  const state = actorState(actorFor(input));
  if (input.action["sourceItemId"] !== undefined) {
    const sourceActor =
      input.action["sourceTokenId"] !== undefined
        ? (nativeActor(input, String(input.action["sourceTokenId"])) as unknown as Doc)
        : undefined;
    const item = sourceActor
      ? sourceActor.items.get(String(input.action["sourceItemId"]))
      : game.collections.get("Item")?.get(String(input.action["sourceItemId"]));
    if (sourceActor) state["sourceActor"] = actorState(sourceActor);
    state["sourceItem"] = item ? item.toObject() : null;
  }
  if (input.action["sourceMessageId"] !== undefined) {
    const message = messages().find((m) => m.id === input.action["sourceMessageId"]);
    state["sourceMessage"] = message ? message.toObject() : null;
  }
  return state;
}
function requireEntry(actor: Doc, collection: "items" | "effects", id: unknown): Doc {
  const entry = actor[collection].get(String(id));
  if (!entry) throw Error("Native embedded target missing from exact placed actor");
  return entry;
}
function preflight(actor: Doc, input: NativeGmApplyInput): void {
  const a = input.action,
    kind = String(a["kind"]);
  if (kind === "actor.stabilize") {
    const attributes = actor.system["attributes"];
    if (
      !statusConfig("stable") ||
      !statusConfig("unconscious") ||
      typeof actor.toggleStatusEffect !== "function" ||
      attributes?.hp?.value !== 0 ||
      !attributes?.death ||
      attributes.death.failure >= 3 ||
      actor.statuses.has("dead")
    )
      throw Error(
        "Explicit native stabilization requires a living zero-HP actor and configured stable/unconscious statuses",
      );
  }
  const methods: Record<string, string> = {
    "actor.damage": "applyDamage",
    "actor.condition": "toggleStatusEffect",
    "actor.exhaustion": "toggleStatusEffect",
    "actor.concentration.end": "endConcentration",
    "actor.hitDie": "rollHitDie",
    "actor.item.grant": "createEmbeddedDocuments",
    "actor.item.copy": "createEmbeddedDocuments",
    "actor.item.remove": "deleteEmbeddedDocuments",
  };
  const rollMethods: Record<string, string> = {
    skill: "rollSkill",
    tool: "rollToolCheck",
    ability: "rollAbilityCheck",
    save: "rollSavingThrow",
    death: "rollDeathSave",
    concentration: "rollConcentration",
  };
  const method =
    kind === "actor.check"
      ? rollMethods[String(a["check"])]
      : kind === "actor.rest"
        ? a["restType"] === "short"
          ? "shortRest"
          : "longRest"
        : methods[kind];
  if (method && typeof actor[method] !== "function")
    throw Error("Reviewed native method unavailable");
  if (kind === "actor.damage") {
    for (const c of a["components"] as Record<string, unknown>[]) {
      if (
        !record(config()["damageTypes"])[String(c["type"])] &&
        !record(config()["healingTypes"])[String(c["type"])]
      )
        throw Error("Unknown native damage/healing type");
      if (((c["properties"] ?? []) as string[]).some((p) => !record(config()["itemProperties"])[p]))
        throw Error("Unknown native damage property");
    }
    if (
      a["sourceMessageId"] !== undefined &&
      !messages().some(
        (m) =>
          m.id === a["sourceMessageId"] &&
          record(m.toObject()["speaker"])["scene"] === input.sceneId,
      )
    )
      throw Error("Native damage source scope mismatch");
  }
  if (kind === "actor.check") {
    const check = String(a["check"]),
      key = String(a["key"] ?? "");
    const table = check === "skill" ? "skills" : check === "tool" ? "tools" : "abilities";
    if (
      !["death", "concentration"].includes(check) &&
      !record(config()[table])[key] &&
      !(check === "tool" && record(config()["vehicleTypes"])[key])
    )
      throw Error("Unknown native skill/tool/ability");
    if (a["ability"] !== undefined && !record(config()["abilities"])[String(a["ability"])])
      throw Error("Unknown native ability");
    if (
      check === "death" &&
      (actor.system["attributes"]?.hp?.value !== 0 ||
        !actor.system["attributes"]?.death ||
        actor.system["attributes"].death.failure >= 3 ||
        actor.system["attributes"].death.success >= 3 ||
        actor.statuses.has("stable") ||
        actor.statuses.has("dead"))
    )
      throw Error("Native death save is not eligible");
    if (check === "concentration" && !actor.concentration?.effects.size)
      throw Error("No native concentration effect");
  }
  if (kind === "actor.condition") {
    const condition = statusConfig(String(a["conditionId"]));
    if (!condition || a["conditionId"] === "exhaustion" || record(condition)["levels"])
      throw Error("Unknown or leveled native condition");
  }
  if (kind === "actor.exhaustion") {
    const max = record(record(config()["conditionTypes"])["exhaustion"])["levels"];
    if (
      typeof max !== "number" ||
      Number(a["level"]) > max ||
      game.settings.get("dnd5e", "disableExhaustion")
    )
      throw Error("Native exhaustion unsupported");
  }
  if (
    kind === "actor.concentration.end" &&
    ![...(actor.concentration?.effects ?? [])].some((e) => e.id === a["effectId"])
  )
    throw Error("Effect is not maintained concentration");
  if (["actor.item.equip", "actor.item.quantity"].includes(kind)) {
    const item = requireEntry(actor, "items", a["itemId"]),
      field = kind === "actor.item.equip" ? "equipped" : "quantity";
    if (item.system[field] === undefined) throw Error("Native item field unavailable");
  }
  if (kind === "actor.item.attune") {
    const item = requireEntry(actor, "items", a["itemId"]);
    if (
      typeof item.system["attuned"] !== "boolean" ||
      !item.system["attunement"] ||
      !record(config()["attunementTypes"])[item.system["attunement"]]
    )
      throw Error("Native equippable attunement field unavailable");
  }
  if (kind === "actor.item.remove") requireEntry(actor, "items", a["itemId"]);
  if (["actor.item.grant", "actor.item.copy"].includes(kind)) {
    const sourceActor =
      kind === "actor.item.copy"
        ? (nativeActor(input, String(a["sourceTokenId"])) as unknown as Doc)
        : undefined;
    if (sourceActor === actor) throw Error("Copy source must be a distinct placed actor");
    const source = sourceActor
      ? sourceActor.items.get(String(a["sourceItemId"]))
      : (game.collections.get("Item")?.get(String(a["sourceItemId"])) as Doc | undefined);
    if (
      !source ||
      source.system["quantity"] === undefined ||
      actor.items.has(String(a["grantItemId"]))
    )
      throw Error("Real world Item source required and grant ID must be unused");
    if (sourceActor && Number(a["quantity"]) > Number(source.system["quantity"]))
      throw Error(
        "Source native item quantity is insufficient for the requested transfer copy step",
      );
  }
  if (
    kind === "actor.xp" &&
    (actor.system["isCharacter"] !== true || typeof actor.system["details"]?.xp?.value !== "number")
  )
    throw Error("Explicit XP reward requires a native character XP field");
  if (kind === "actor.hp.tempmax" && typeof actor.system["attributes"]?.hp?.tempmax !== "number")
    throw Error("Native temporary maximum HP field unavailable");
  if (
    kind === "actor.currency" &&
    (!record(config()["currencies"])[String(a["denomination"])] ||
      actor.system["currency"]?.[String(a["denomination"])] === undefined)
  )
    throw Error("Unknown native currency");
  if (
    kind === "actor.currency.convert" &&
    (typeof nativeCurrencyManager()?.convertCurrency !== "function" || !actor.system["currency"])
  )
    throw Error("Native currency conversion unavailable");
  if (kind === "actor.effect.duration") {
    requireEntry(actor, "effects", a["effectId"]);
    if (
      (a["duration"] as Record<string, unknown>)["seconds"] === undefined &&
      ![...(game.collections.get("Combat")?.values() ?? [])].some(
        (c) => c.toObject()["active"] === true && c.toObject()["scene"] === input.sceneId,
      )
    )
      throw Error("Turn duration requires current scene combat");
  }
}
async function stabilizeNative(actor: Doc, resetCounters: boolean): Promise<unknown> {
  if (resetCounters)
    await actor.update({
      "system.attributes.death.success": 0,
      "system.attributes.death.failure": 0,
    });
  await actor.toggleStatusEffect("unconscious", { active: true });
  await actor.toggleStatusEffect("stable", { active: true });
  const death = actor.system["attributes"]?.death;
  const actualEffect = [...actor.effects.values()].some((effect) => {
    const source = effect.toObject();
    return (
      source["disabled"] !== true &&
      Array.isArray(source["statuses"]) &&
      source["statuses"].includes("stable")
    );
  });
  if (
    actor.system["attributes"]?.hp?.value !== 0 ||
    death?.success !== 0 ||
    death?.failure !== 0 ||
    !actor.statuses.has("stable") ||
    !actor.statuses.has("unconscious") ||
    actor.statuses.has("dead") ||
    !actualEffect
  )
    throw Error("Native stabilization effect/counters/unconscious readback failed");
  return {
    nativeStableStatusVerified: true,
    unconscious: true,
    deathSaveEligible: false,
    stableRemovalRequiresExplicitDecision: true,
  };
}
function assertPrivacy(message: Doc, mode: string, input: NativeGmInput): void {
  const data = message.toObject();
  const recipients = Array.isArray(data["whisper"]) ? data["whisper"].map(String).sort() : [];
  const gms = [...game.users.values()]
    .filter((u) => u.isGM)
    .map((u) => u.id)
    .sort();
  const expected = mode === "selfroll" ? [input.userId] : mode === "publicroll" ? [] : gms;
  if (
    JSON.stringify(recipients) !== JSON.stringify(expected) ||
    Boolean(data["blind"]) !== (mode === "blindroll")
  )
    throw Error("Native roll privacy readback differs from explicit scope");
}
async function nativeRoll(
  actor: Doc,
  action: Record<string, unknown>,
  input: NativeGmApplyInput,
  hitDie = false,
): Promise<unknown> {
  const check = String(action["check"]);
  const mapping: Record<string, string> = {
    skill: "rollSkill",
    tool: "rollToolCheck",
    ability: "rollAbilityCheck",
    save: "rollSavingThrow",
    death: "rollDeathSave",
    concentration: "rollConcentration",
  };
  const method = hitDie ? "rollHitDie" : mapping[check];
  if (!method || typeof actor[method] !== "function")
    throw Error("Reviewed native roll method unavailable");
  const field = check === "save" || check === "ability" ? "ability" : check;
  const key = String(action["key"] ?? "");
  const table = check === "skill" ? "skills" : check === "tool" ? "tools" : "abilities";
  if (
    !hitDie &&
    !["death", "concentration"].includes(check) &&
    !record(config()[table])[key] &&
    !(check === "tool" && record(config()["vehicleTypes"])[key])
  )
    throw Error("Unknown native skill/tool/ability; no fallback roll permitted");
  if (action["ability"] !== undefined && !record(config()["abilities"])[String(action["ability"])])
    throw Error("Unknown native ability");
  if (
    check === "death" &&
    (actor.system["attributes"]?.hp?.value !== 0 || actor.system["attributes"]?.death?.failure >= 3)
  )
    throw Error("Native death save is not eligible");
  if (check === "concentration" && !actor.concentration?.effects.size)
    throw Error("No native concentration effect to challenge");
  const idsBefore = new Set(messages().map((m) => m.id));
  const rollConfig: Record<string, unknown> = hitDie
    ? { denomination: action["denomination"], modifyHitDice: true, modifyHitPoints: true }
    : {
        ...(key ? { [field]: key } : {}),
        ...(action["ability"] ? { ability: action["ability"] } : {}),
        ...(action["dc"] !== undefined ? { target: action["dc"] } : {}),
        ...(action["advantageMode"] === "advantage" ? { advantage: true } : {}),
        ...(action["advantageMode"] === "disadvantage" ? { disadvantage: true } : {}),
      };
  const completionEvent = hitDie
    ? "dnd5e.postRollHitDie"
    : check === "death"
      ? "dnd5e.postRollDeathSave"
      : null;
  let completedRolls: unknown;
  const hook = completionEvent
    ? Hooks.on(completionEvent, (completed: unknown, data: unknown) => {
        if (record(data)["subject"] === actor) completedRolls = completed;
      })
    : null;
  let rolls;
  try {
    rolls = await actor[method](
      rollConfig,
      { configure: false },
      {
        create: true,
        rollMode: action["rollMode"],
        data: { flags: { "foundry-local-api": { correlationId: input.correlationId } } },
      },
    );
  } finally {
    if (completionEvent && hook !== null)
      (Hooks as unknown as { off(name: string, id: number): void }).off(completionEvent, hook);
  }
  if (completionEvent && completedRolls !== rolls)
    throw Error(
      "Native post-roll mutation completion missing; roll may exist but HP/death/hit-die effects are not confirmed",
    );
  if (!Array.isArray(rolls) || rolls.length !== 1 || typeof rolls[0]?.total !== "number")
    throw Error("Native roll cancelled or unsupported result; do not replay");
  const roll = rolls[0];
  const messageId = roll.parent?.id;
  const message = messages().find((m) => m.id === messageId);
  if (
    !message ||
    idsBefore.has(message.id) ||
    record(record(record(message.toObject()["flags"])["foundry-local-api"]))["correlationId"] !==
      input.correlationId
  )
    throw Error("New correlated native roll message not verified");
  assertPrivacy(message, String(action["rollMode"]), input);
  const speaker = record(message.toObject()["speaker"]);
  if (speaker["actor"] !== actor.id || speaker["scene"] !== input.sceneId)
    throw Error("Native roll speaker scope mismatch");
  if (check === "death" && message.system?.["outcome"] === "stable")
    await stabilizeNative(actor, false);
  return {
    messageId,
    total: roll.total,
    formula: roll.formula,
    isCritical: Boolean(roll.isCritical),
    isFumble: Boolean(roll.isFumble),
    nativeOptions: clone(roll.options),
    outcome: clone(message.system?.["outcome"]),
    rollMode: action["rollMode"],
    concentrationDecisionPending: check === "concentration",
    concentrationEffectIds: [...(actor.concentration?.effects ?? [])].map((e) => e.id),
  };
}
async function apply(actor: Doc, input: NativeGmApplyInput): Promise<unknown> {
  const a = input.action;
  const kind = a["kind"];
  if (kind === "actor.damage") {
    if (typeof actor.applyDamage !== "function") throw Error("Native typed damage unavailable");
    const components = (a["components"] as Record<string, unknown>[]).map((c) => {
      const type = String(c["type"]);
      if (!record(config()["damageTypes"])[type] && !record(config()["healingTypes"])[type])
        throw Error("Unknown native damage/healing type");
      const props = (c["properties"] ?? []) as string[];
      if (props.some((p) => !record(config()["itemProperties"])[p]))
        throw Error("Unknown native damage property");
      return { type, value: c["value"], properties: new Set(props) };
    });
    const options: Record<string, unknown> = { multiplier: a["multiplier"] };
    if (a["sourceMessageId"] !== undefined) {
      const source = messages().find((m) => m.id === a["sourceMessageId"]);
      if (!source || record(source.toObject()["speaker"])["scene"] !== input.sceneId)
        throw Error("Native damage source message scope mismatch");
      options["originatingMessage"] = source;
    }
    let post: Record<string, unknown> | undefined;
    const hook = Hooks.on("dnd5e.applyDamage", (subject: unknown, amount: unknown) => {
      if (subject === actor) post = { amount };
    });
    try {
      const result = await actor.applyDamage(components, options);
      if (result !== actor || !post)
        throw Error(
          "Native damage completion hook missing; veto/cancellation or incomplete dispatch",
        );
      return {
        nativeApplied: true,
        ...post,
        concentrationDecisionPending: Boolean(actor.concentration?.effects.size),
        stableRemovalDecisionPending: actor.statuses.has("stable"),
      };
    } finally {
      (Hooks as unknown as { off(name: string, id: number): void }).off("dnd5e.applyDamage", hook);
    }
  }
  if (kind === "actor.check") return nativeRoll(actor, a, input);
  if (kind === "actor.hitDie") return nativeRoll(actor, a, input, true);
  if (kind === "actor.condition") {
    const condition = statusConfig(String(a["conditionId"]));
    if (!condition || String(a["conditionId"]) === "exhaustion" || record(condition)["levels"])
      throw Error("Unknown or leveled native condition; use an explicit level operation");
    await actor.toggleStatusEffect(String(a["conditionId"]), { active: a["active"] });
    if (actor.statuses.has(String(a["conditionId"])) !== a["active"])
      throw Error("Native condition readback failed");
  } else if (kind === "actor.exhaustion") {
    const max = record(record(config()["conditionTypes"])["exhaustion"])["levels"];
    if (
      typeof max !== "number" ||
      Number(a["level"]) > max ||
      game.settings.get("dnd5e", "disableExhaustion")
    )
      throw Error("Native exhaustion setting/level unsupported");
    await actor.toggleStatusEffect("exhaustion", {
      levels: Number(a["level"]) - Number(actor.system["conditions"]?.exhaustion ?? 0),
    });
    if (actor.system["conditions"]?.exhaustion !== a["level"])
      throw Error("Native exhaustion readback failed");
  } else if (kind === "actor.concentration.end") {
    if (![...(actor.concentration?.effects ?? [])].some((e) => e.id === a["effectId"]))
      throw Error("Effect is not maintained concentration");
    await actor.endConcentration(String(a["effectId"]));
    if ([...(actor.concentration?.effects ?? [])].some((e) => e.id === a["effectId"]))
      throw Error("Native concentration end readback failed");
  } else if (kind === "actor.stabilize") {
    return stabilizeNative(actor, true);
  } else if (kind === "actor.rest") {
    const method = a["restType"] === "short" ? "shortRest" : "longRest";
    if (typeof actor[method] !== "function") throw Error("Native rest unavailable");
    let completed = false;
    const hook = Hooks.on("dnd5e.restCompleted", (subject: unknown) => {
      if (subject === actor) completed = true;
    });
    let result;
    try {
      result = await actor[method]({
        dialog: false,
        chat: false,
        autoHD: false,
        advanceTime: false,
        advanceBastionTurn: false,
      });
    } finally {
      (Hooks as unknown as { off(name: string, id: number): void }).off(
        "dnd5e.restCompleted",
        hook,
      );
    }
    if (!completed || !result || result.type !== a["restType"] || !result.updateData)
      throw Error("Native rest cancelled or unsupported result");
    return {
      restType: result.type,
      deltas: clone(result.deltas),
      nativeUpdateData: clone(result.updateData),
      nativeItemUpdates: clone(result.updateItems),
      nativeDeletedItems: clone(result.deleteItems),
      timeAdvanced: false,
      hitDiceAutoSpent: false,
    };
  } else if (kind === "actor.item.equip" || kind === "actor.item.quantity") {
    const item = requireEntry(actor, "items", a["itemId"]);
    const field = kind === "actor.item.equip" ? "equipped" : "quantity";
    if (item.system[field] === undefined)
      throw Error("Native item does not support selected field");
    await item.update({ [`system.${field}`]: a[field] });
    if (item.system[field] !== a[field]) throw Error("Native inventory readback failed");
  } else if (kind === "actor.item.attune") {
    const item = requireEntry(actor, "items", a["itemId"]);
    await item.update({ "system.attuned": a["attuned"] });
    if (item.system["attuned"] !== a["attuned"]) throw Error("Native attunement readback failed");
    return { nativeAttuned: a["attuned"], eligibilityConfirmed: true };
  } else if (kind === "actor.item.remove") {
    const itemId = String(a["itemId"]);
    await actor["deleteEmbeddedDocuments"]("Item", [itemId]);
    if (actor.items.has(itemId)) throw Error("Native item removal readback failed");
    return { nativeDeletedItemId: itemId };
  } else if (kind === "actor.item.grant" || kind === "actor.item.copy") {
    const sourceActor =
      kind === "actor.item.copy"
        ? (nativeActor(input, String(a["sourceTokenId"])) as unknown as Doc)
        : undefined;
    const source = (
      sourceActor
        ? sourceActor.items.get(String(a["sourceItemId"]))
        : game.collections.get("Item")?.get(String(a["sourceItemId"]))
    ) as Doc;
    const sourceSnapshot = source.toObject();
    const data = structuredClone(sourceSnapshot);
    data["_id"] = a["grantItemId"];
    data["system"] = { ...record(data["system"]), quantity: a["quantity"] };
    const created = await actor["createEmbeddedDocuments"]("Item", [data], { keepId: true });
    if (sourceActor && (nativeActor(input, String(a["sourceTokenId"])) as unknown) !== sourceActor)
      throw Error("Source placed actor changed during native item copy");
    const currentSource = sourceActor
      ? sourceActor.items.get(String(a["sourceItemId"]))
      : game.collections.get("Item")?.get(String(a["sourceItemId"]));
    if (
      currentSource !== source ||
      JSON.stringify(source.toObject()) !== JSON.stringify(sourceSnapshot)
    )
      throw Error(
        "Native item source changed during copy; inspect the created target before any transfer step",
      );
    const item = actor.items.get(String(a["grantItemId"]));
    if (
      !Array.isArray(created) ||
      created.length !== 1 ||
      !item ||
      item.system["quantity"] !== a["quantity"] ||
      item.toObject()["type"] !== source.toObject()["type"]
    )
      throw Error("Native grant readback failed");
    return {
      grantItemId: item.id,
      sourceItemId: source.id,
      quantity: a["quantity"],
      transferPerformed: false,
    };
  } else if (kind === "actor.xp" || kind === "actor.hp.tempmax") {
    const path = kind === "actor.xp" ? "system.details.xp.value" : "system.attributes.hp.tempmax";
    await actor.update({ [path]: a["value"] });
    const value =
      kind === "actor.xp"
        ? actor.system["details"]?.xp?.value
        : actor.system["attributes"]?.hp?.tempmax;
    if (value !== a["value"]) throw Error("Native explicit character field readback failed");
    return { nativeField: path, value, advancementChoicesPerformed: false };
  } else if (kind === "actor.currency.convert") {
    const result = await nativeCurrencyManager()!.convertCurrency(actor);
    if (result !== actor) throw Error("Native currency conversion cancelled or unavailable");
    return { nativeCurrencyConversion: true, currency: clone(actor.system["currency"]) };
  } else if (kind === "actor.currency") {
    const denomination = String(a["denomination"]);
    if (
      !record(config()["currencies"])[denomination] ||
      actor.system["currency"]?.[denomination] === undefined
    )
      throw Error("Unknown native currency denomination");
    await actor.update({ [`system.currency.${denomination}`]: a["value"] });
    if (actor.system["currency"]?.[denomination] !== a["value"])
      throw Error("Native currency readback failed");
    return { operation: "explicit denomination grant/correction", transferPerformed: false };
  } else if (kind === "actor.effect.duration") {
    const effect = requireEntry(actor, "effects", a["effectId"]);
    const duration = a["duration"] as Record<string, unknown>;
    const combat = [...(game.collections.get("Combat")?.values() ?? [])].find(
      (c) => c.toObject()["active"] === true && c.toObject()["scene"] === input.sceneId,
    );
    if (duration["seconds"] === undefined && !combat)
      throw Error("Turn duration requires current scene combat");
    const nativeTime = game.time.worldTime;
    await effect.update({
      duration: {
        seconds: null,
        rounds: null,
        turns: null,
        ...duration,
        startTime: nativeTime,
        startRound: combat?.toObject()["round"] ?? null,
        startTurn: combat?.toObject()["turn"] ?? null,
      },
    });
    if (Object.entries(duration).some(([k, v]) => record(effect.toObject()["duration"])[k] !== v))
      throw Error("Native effect duration readback failed");
    return { expiryManagedByNativeSystem: true, saveToEndRequiresExplicitDecision: true };
  } else throw Error("Unsupported native character mutation");
  return { nativeStateVerified: true };
}
export async function gmCharacterApply(input: NativeGmApplyInput) {
  authorizeNative(input);
  validateGmCharacterAction(input.action, true);
  return runNativeMutation(
    input,
    () => gmCharacterRead(input),
    async () => {
      authorizeNative(input);
      const actor = actorFor(input);
      const result = await apply(actor, input);
      authorizeNative(input);
      if (actorFor(input) !== actor)
        throw Error(
          "Placed native actor binding changed during dispatch; reconcile the original actor before any new intent",
        );
      return result;
    },
    () => preflight(actorFor(input), input),
  );
}
registerCommand(GM_CHARACTER_COMMANDS.READ, gmCharacterRead);
registerCommand(GM_CHARACTER_COMMANDS.APPLY, gmCharacterApply);
