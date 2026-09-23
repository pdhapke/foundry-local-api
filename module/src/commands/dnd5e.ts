// Phase 34 — dnd5e Integration: Detection & Read-Only Data, module-side
// command handlers. Registered against the same command dispatcher registry
// Phase 2 set up (module/src/command-registry.ts) and imported for side
// effects from module/src/index.ts. Only ever invoked when the connected
// world's active system is dnd5e (server/src/integrations/dnd5e/index.ts's
// `detect`), but every field read here is still defensive (optional
// chaining, `?? 0`/`?? {}`/`[]` fallbacks) by design.
//
// *** IMPORTANT — implemented against documented-but-UNVERIFIED dnd5e data
// model conventions, no live Foundry+dnd5e instance was available. ***
// Every other phase since Phase 6 has carried a "not yet smoke-tested
// against a live Foundry instance" caveat for its use of Foundry's own core
// API, which is long-stable and extensively documented. This file carries a
// STRONGER version of that caveat: the exact shape being read here
// (`CONFIG.DND5E`'s per-entry structure, `Actor#system`'s field paths,
// where a class item stores its level, dnd5e 3.x+'s Activities structure)
// is itself part of what's being guessed at, not just whether Foundry's own
// stable API still behaves as documented. PLAN.md's own Phase 35 text notes
// dnd5e's API "has changed materially across its 2.x -> 3.x -> 4.x
// releases" — the same is true of its data model, not just its method
// signatures. This needs a live smoke-test against a real dnd5e world
// (ideally across a couple of dnd5e versions) before being trusted in
// production. See PLAN.md's Phase 34 deviation-log entry for the specific
// field-path assumptions made.
//
// No module-side command handler file in this codebase is unit-tested
// directly (Phase 31's deviation log: they need a real/heavily-mocked
// `game` global) — only pure extracted helpers are. This file follows that
// same precedent rather than inventing new test infrastructure for it.
//
// Phase 35 adds the seven write-action commands below the Phase 34 read-only
// ones (roll actions, rest, spell-slot adjustment, item use). It carries the
// SAME strengthened no-live-instance caveat above, plus a further wrinkle
// unique to it: this phase's actions genuinely mutate game state (HP, spent
// spell slots, consumed item charges), so a wrong assumption here has a
// bigger blast radius than a wrong read. See PLAN.md's Phase 35 deviation
// log for the `callFirstAvailableMethod` multi-candidate-name strategy this
// uses instead of committing to one dnd5e method name per action.
import {
  DND5E_COMMANDS,
  type Dnd5eAbilityRollInput,
  type Dnd5eActorIdInput,
  type Dnd5eActorSheetResult,
  type Dnd5eConfigResult,
  type Dnd5eInventoryItem,
  type Dnd5eItemUseInput,
  type Dnd5eItemUseResult,
  type Dnd5eRestInput,
  type Dnd5eRestResult,
  type Dnd5eRollActionResult,
  type Dnd5eSkillRollInput,
  type Dnd5eSpellSlotInput,
  type Dnd5eSpellSlotResult,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";

function requireActor(id: string): FoundryActor {
  const collection = game.collections.get("Actor") as Map<string, FoundryActor> | undefined;
  const actor = collection?.get(id);
  if (!actor) {
    throw new Error(`Actor "${id}" not found`);
  }
  return actor;
}

/**
 * Calls the first of `candidates` that exists as a function on `target`.
 * dnd5e's actor roll methods went through two independent axes of change
 * across versions (see this file's header comment and PLAN.md's Phase 37
 * live-smoke-test deviation log): the METHOD NAME (e.g. `rollAbilityTest` ->
 * `rollAbilityCheck`) and, separately, the CALL SHAPE — older dnd5e took
 * positional args `(value, options)`; dnd5e 4.x+'s Activities-era API (live-
 * verified against an installed dnd5e 6.0.3) takes config objects
 * `(config, dialog, message)` instead. For each candidate name found, this
 * tries the modern config-object shape first and falls back to the legacy
 * positional shape on failure, before moving to the next candidate name —
 * this doesn't assume which shape a given name implies, since that pairing
 * isn't confidently known to be stable across every dnd5e release.
 * `modernArgs`/`legacyArgs` are each a full argument list for their shape.
 */
async function callFirstAvailableRollMethod<T>(
  target: Record<string, unknown>,
  candidates: string[],
  modernArgs: unknown[],
  legacyArgs: unknown[],
): Promise<T> {
  const errors: string[] = [];
  for (const name of candidates) {
    const fn = target[name];
    if (typeof fn !== "function") {
      continue;
    }
    try {
      return await (fn as (...a: unknown[]) => Promise<T>).apply(target, modernArgs);
    } catch (modernError) {
      try {
        return await (fn as (...a: unknown[]) => Promise<T>).apply(target, legacyArgs);
      } catch (legacyError) {
        errors.push(
          `${name}: modern call shape failed (${(modernError as Error)?.message ?? modernError}), legacy call shape failed (${(legacyError as Error)?.message ?? legacyError})`,
        );
      }
    }
  }
  throw new Error(
    `None of the expected dnd5e methods (${candidates.join(", ")}) could be called with either the modern config-object or legacy positional call shape — the installed dnd5e version may use a different API than this integration was built against. Attempts: ${errors.join("; ") || "no matching method found"}`,
  );
}

/**
 * Skips dnd5e's roll-configuration dialog — there's no human in this
 * headless, API-driven call to click through it. Live-verified against
 * dnd5e 6.0.3's `BasicRollDialogConfiguration` shape (`dialog.configure`).
 */
const DIALOG_SKIP_CONFIRM = { configure: false };
/** Matches Foundry's own default of posting the roll result to chat. */
const MESSAGE_CREATE = { create: true };

/**
 * Normalizes whatever dnd5e's roll-action methods return (a `Roll`/`D20Roll`
 * instance, or an array of them on some dnd5e versions) into the same
 * `{formula, total, result, dice}` shape Phase 14's plain formula evaluation
 * already uses — dnd5e's roll classes carry the exact same fields. Throws a
 * diagnosable error rather than returning a garbage result if the call was
 * cancelled (e.g. a dialog this integration can't click through) or the
 * installed dnd5e version's return shape differs from what's expected here.
 */
function toRollActionResult(rollLike: unknown): Dnd5eRollActionResult {
  const roll = Array.isArray(rollLike) ? rollLike[0] : rollLike;
  const r = roll as
    { formula?: unknown; total?: unknown; result?: unknown; dice?: unknown } | null | undefined;
  if (!r || typeof r.total !== "number") {
    throw new Error(
      "The dnd5e roll action did not return a completed roll — it may have been cancelled (e.g. a dialog this integration couldn't skip), or this dnd5e version's return shape differs from what was expected.",
    );
  }
  const dice = Array.isArray(r.dice) ? r.dice : [];
  return {
    formula: String(r.formula ?? ""),
    total: r.total,
    result: String(r.result ?? ""),
    dice: dice.map((d) => {
      const die = d as { faces?: unknown; results?: unknown };
      const results = Array.isArray(die.results) ? die.results : [];
      return {
        faces: Number(die.faces ?? 0),
        results: results.map((x) => Number((x as { result?: unknown })?.result ?? 0)),
      };
    }),
  };
}

/** Passed to every roll-action call — see this file's header comment for why. */
const ROLL_ACTION_OPTIONS = { fastForward: true, chatMessage: true };

/**
 * Locates an Item by id across both world items and every actor's embedded
 * items — the `/dnd5e/items/:id/use` route has no actor segment (per
 * PLAN.md's own Phase 35 path), so the item must be found generically rather
 * than assumed to live under one known parent.
 */
function findItemById(id: string): FoundryItem {
  const worldItems = game.collections.get("Item") as Map<string, FoundryItem> | undefined;
  const worldMatch = worldItems?.get(id);
  if (worldMatch) {
    return worldMatch;
  }
  const actors = game.collections.get("Actor") as Map<string, FoundryActor> | undefined;
  for (const actor of actors?.values() ?? []) {
    const match = actor.items.get(id) as FoundryItem | undefined;
    if (match) {
      return match;
    }
  }
  throw new Error(
    `Item "${id}" not found (searched world items and every actor's embedded items).`,
  );
}

/** A `CONFIG.DND5E.<slice>` entry, as documented across dnd5e 2.x-4.x. */
interface Dnd5eConfigEntry {
  label?: unknown;
  abbreviation?: unknown;
  ability?: unknown;
}

function isConfigEntry(value: unknown): value is Dnd5eConfigEntry {
  return typeof value === "object" && value !== null;
}

/**
 * Iterates a `CONFIG.DND5E.<slice>` record (e.g. `abilities`/`damageTypes`),
 * skipping any entry that isn't a plain object — defensive against a dnd5e
 * version whose slice is nested/structured differently than documented.
 */
function configEntries(slice: unknown): [string, Dnd5eConfigEntry][] {
  if (typeof slice !== "object" || slice === null) {
    return [];
  }
  return Object.entries(slice as Record<string, unknown>).filter(
    (pair): pair is [string, Dnd5eConfigEntry] => isConfigEntry(pair[1]),
  );
}

function localizedLabel(entry: Dnd5eConfigEntry, fallbackKey: string): string {
  const rawLabel = typeof entry.label === "string" ? entry.label : fallbackKey;
  return game.i18n.localize(rawLabel);
}

registerCommand(DND5E_COMMANDS.CONFIG, (): Dnd5eConfigResult => {
  // Narrow local cast, not a shared ambient `CONFIG` widening: `CONFIG.DND5E`
  // is entirely dnd5e-specific and every other command in this codebase
  // relies on `CONFIG`'s existing generic `{documentType: {documentClass}}`
  // shape (module/src/types/foundry-globals.d.ts) staying exactly as-is.
  const DND5E_CONFIG = (CONFIG as unknown as { DND5E?: Record<string, unknown> }).DND5E;
  if (!DND5E_CONFIG) {
    return { abilities: [], skills: [], damageTypes: [], conditionTypes: [] };
  }

  const abilities = configEntries(DND5E_CONFIG["abilities"]).map(([id, entry]) => {
    const label = localizedLabel(entry, id);
    const rawAbbreviation = typeof entry.abbreviation === "string" ? entry.abbreviation : null;
    return {
      id,
      label,
      abbreviation: rawAbbreviation !== null ? game.i18n.localize(rawAbbreviation) : label,
    };
  });

  const skills = configEntries(DND5E_CONFIG["skills"]).map(([id, entry]) => ({
    id,
    label: localizedLabel(entry, id),
    ability: typeof entry.ability === "string" ? entry.ability : "",
  }));

  const damageTypes = configEntries(DND5E_CONFIG["damageTypes"]).map(([id, entry]) => ({
    id,
    label: localizedLabel(entry, id),
  }));

  const conditionTypes = configEntries(DND5E_CONFIG["conditionTypes"]).map(([id, entry]) => ({
    id,
    label: localizedLabel(entry, id),
  }));

  return { abilities, skills, damageTypes, conditionTypes };
});

registerCommand(DND5E_COMMANDS.ACTOR_SHEET, ({ id }: Dnd5eActorIdInput): Dnd5eActorSheetResult => {
  const actor = requireActor(id);
  // One narrow cast: dnd5e's actor data model isn't part of the generic
  // ambient `FoundryActor#system: Record<string, unknown>` surface (see
  // foundry-globals.d.ts's Phase 34 note) — every field read off `sys`
  // below is still individually defaulted, so a missing/renamed field
  // degrades gracefully rather than throwing.
  const sys = actor.system as Record<string, any>;

  const abilities: Dnd5eActorSheetResult["abilities"] = {};
  for (const [key, value] of Object.entries<any>(sys["abilities"] ?? {})) {
    abilities[key] = {
      value: value?.value ?? 0,
      mod: value?.mod ?? 0,
      save: value?.save ?? 0,
      proficient: value?.proficient ?? 0,
    };
  }

  const skills: Dnd5eActorSheetResult["skills"] = {};
  for (const [key, value] of Object.entries<any>(sys["skills"] ?? {})) {
    skills[key] = {
      total: value?.total ?? 0,
      passive: value?.passive ?? 0,
      // dnd5e's skill entry names its own proficiency-multiplier field
      // `value` (not `proficient`) — mapped to `proficient` here for a
      // consistent public shape alongside `abilities` above.
      proficient: value?.value ?? 0,
      ability: value?.ability ?? "",
    };
  }

  const spellSlots: Dnd5eActorSheetResult["spellSlots"] = {};
  for (const [key, value] of Object.entries<any>(sys["spells"] ?? {})) {
    spellSlots[key] = { value: value?.value ?? 0, max: value?.max ?? 0 };
  }

  const classItems = Array.from(actor.items.values()).filter(
    (item) => (item.toObject() as { type?: string }).type === "class",
  );
  const classes = classItems.map((item) => ({
    name: (item.toObject() as { name?: string }).name ?? "",
    level: ((item as FoundryItem).system?.["levels"] as number | undefined) ?? 0,
  }));
  const level =
    classes.length > 0
      ? classes.reduce((sum, c) => sum + c.level, 0)
      : ((sys["details"]?.level as number | undefined) ?? 0);

  return {
    id: actor.id,
    name: (actor.toObject() as { name?: string }).name ?? "",
    abilities,
    skills,
    armorClass: sys["attributes"]?.ac?.value ?? 0,
    hitPoints: {
      value: sys["attributes"]?.hp?.value ?? 0,
      max: sys["attributes"]?.hp?.max ?? 0,
      temp: sys["attributes"]?.hp?.temp ?? 0,
    },
    senses: sys["attributes"]?.senses ?? {},
    currency: sys["currency"] ?? {},
    spellSlots,
    classes,
    level,
    proficiencyBonus: sys["attributes"]?.prof ?? 0,
  };
});

/**
 * dnd5e 3.x+ stores an item's Activities as a keyed object/Collection-like
 * structure (`Record<string, {name?, type?}>` once serialized via
 * `toObject()`), not an array. Older dnd5e versions have no Activities
 * system at all. Both cases (absent, or present-but-not-object) degrade to
 * an empty array rather than throwing.
 */
function extractActivities(itemSys: Record<string, unknown>): Dnd5eInventoryItem["activities"] {
  const raw = itemSys["activities"];
  if (typeof raw !== "object" || raw === null) {
    return [];
  }
  return Object.entries(raw as Record<string, unknown>).map(([key, entry]) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    return {
      id: key,
      name: String(e["name"] ?? ""),
      type: String(e["type"] ?? ""),
    };
  });
}

registerCommand(DND5E_COMMANDS.ACTOR_INVENTORY, ({ id }: Dnd5eActorIdInput): Dnd5eInventoryItem[] =>
  Array.from(requireActor(id).items.values()).map((item) => {
    const obj = item.toObject() as Record<string, unknown>;
    const itemSys = (obj["system"] ?? {}) as Record<string, unknown>;
    return {
      id: item.id,
      name: String(obj["name"] ?? ""),
      type: String(obj["type"] ?? ""),
      quantity: Number(itemSys["quantity"] ?? 1),
      equipped: Boolean(itemSys["equipped"] ?? false),
      attuned: Boolean(itemSys["attuned"] ?? itemSys["attunement"] ?? false),
      activities: extractActivities(itemSys),
    };
  }),
);

// --- Phase 35 — write actions -------------------------------------------

registerCommand(
  DND5E_COMMANDS.ROLL_ABILITY_CHECK,
  async ({ id, ability }: Dnd5eAbilityRollInput): Promise<Dnd5eRollActionResult> => {
    const actor = requireActor(id);
    const roll = await callFirstAvailableRollMethod(
      actor as unknown as Record<string, unknown>,
      ["rollAbilityCheck", "rollAbilityTest"],
      [{ ability }, DIALOG_SKIP_CONFIRM, MESSAGE_CREATE],
      [ability, ROLL_ACTION_OPTIONS],
    );
    return toRollActionResult(roll);
  },
);

registerCommand(
  DND5E_COMMANDS.ROLL_SAVING_THROW,
  async ({ id, ability }: Dnd5eAbilityRollInput): Promise<Dnd5eRollActionResult> => {
    const actor = requireActor(id);
    const roll = await callFirstAvailableRollMethod(
      actor as unknown as Record<string, unknown>,
      ["rollSavingThrow", "rollAbilitySave"],
      [{ ability }, DIALOG_SKIP_CONFIRM, MESSAGE_CREATE],
      [ability, ROLL_ACTION_OPTIONS],
    );
    return toRollActionResult(roll);
  },
);

registerCommand(
  DND5E_COMMANDS.ROLL_SKILL,
  async ({ id, skill }: Dnd5eSkillRollInput): Promise<Dnd5eRollActionResult> => {
    const actor = requireActor(id);
    const roll = await callFirstAvailableRollMethod(
      actor as unknown as Record<string, unknown>,
      ["rollSkill"],
      [{ skill }, DIALOG_SKIP_CONFIRM, MESSAGE_CREATE],
      [skill, ROLL_ACTION_OPTIONS],
    );
    return toRollActionResult(roll);
  },
);

registerCommand(
  DND5E_COMMANDS.ROLL_DEATH_SAVE,
  async ({ id }: Dnd5eActorIdInput): Promise<Dnd5eRollActionResult> => {
    const actor = requireActor(id);
    const roll = await callFirstAvailableRollMethod(
      actor as unknown as Record<string, unknown>,
      ["rollDeathSave"],
      [{}, DIALOG_SKIP_CONFIRM, MESSAGE_CREATE],
      [ROLL_ACTION_OPTIONS],
    );
    return toRollActionResult(roll);
  },
);

registerCommand(
  DND5E_COMMANDS.REST,
  async ({ id, type }: Dnd5eRestInput): Promise<Dnd5eRestResult> => {
    const actor = requireActor(id);
    const methodName = type === "short" ? "shortRest" : "longRest";
    const fn = (actor as unknown as Record<string, unknown>)[methodName];
    if (typeof fn !== "function") {
      throw new Error(
        `Actor has no ${methodName}() method — unexpected for a dnd5e actor; the installed dnd5e version may differ from what this integration was built against.`,
      );
    }
    const result = await (fn as (opts: unknown) => Promise<unknown>).call(actor, {
      dialog: false,
      chat: true,
    });
    // dnd5e's own rest-result object shape (`dhp`/`newDay`) is documented but
    // not confidently stable across versions — see this file's header
    // comment and PLAN.md's Phase 35 deviation log — so both fields are
    // defaulted defensively rather than assumed present.
    const r = (result ?? {}) as Record<string, unknown>;
    return {
      type,
      deltaHitPoints: Number(r["dhp"] ?? r["deltaHitPoints"] ?? 0),
      newDay: Boolean(r["newDay"] ?? false),
    };
  },
);

registerCommand(
  DND5E_COMMANDS.ADJUST_SPELL_SLOT,
  async ({ id, level, delta }: Dnd5eSpellSlotInput): Promise<Dnd5eSpellSlotResult> => {
    const actor = requireActor(id);
    // Deliberately not calling any dnd5e-specific method: there's no stable,
    // documented "spend/restore one spell slot" method in dnd5e's public
    // API (slot spending normally happens internally during spellcasting-
    // activity use). Instead this reads/writes the actor's own
    // `system.spells.<key>.value` field directly via the generic
    // `Document#update()` Phase 8 already proved reliable.
    const key = level === "pact" ? "pact" : `spell${level}`;
    const sys = actor.system as Record<string, any>;
    const slot = (sys?.["spells"]?.[key] ?? {}) as { value?: number; max?: number };
    const max = Number(slot.max ?? 0);
    const current = Number(slot.value ?? 0);
    const next = Math.max(0, Math.min(max, current + delta));
    await actor.update({ [`system.spells.${key}.value`]: next });
    return { level, value: next, max };
  },
);

registerCommand(
  DND5E_COMMANDS.USE_ITEM,
  async ({ id }: Dnd5eItemUseInput): Promise<Dnd5eItemUseResult> => {
    const item = findItemById(id);
    // Deliberately calls the item's own top-level use() rather than
    // targeting a specific Activity by id: PLAN.md's own Phase 35 wording is
    // just "trigger an item/activity use" with no activity-id input, and on
    // dnd5e 3.x+ (Activities), an item's use() already handles activity
    // selection internally — the faithful, minimal reading of that bullet.
    const fn = (item as unknown as Record<string, unknown>)["use"];
    if (typeof fn !== "function") {
      throw new Error(`Item "${id}" has no use() method on this dnd5e version.`);
    }
    // Live-verified against dnd5e 6.0.3: calling use() with no dialog config
    // (all-defaults) pops an interactive item-usage configuration dialog on
    // the GM's client — `{configure: false}` (same skip as the roll-action
    // commands above) suppresses that one. But for an Activity that defines
    // an automatic follow-up roll (e.g. AttackActivity rolling its attack
    // right after a weapon is "used"), dnd5e 6.0.3 hardcodes an EMPTY dialog
    // config for that follow-up roll (`AttackActivity#_triggerSubsequentActions`
    // calls `this.rollAttack({event}, {}, {...})`, ignoring whatever `dialog`
    // was passed to `use()`) — so that second dialog can't be suppressed
    // through the public API at all, and would otherwise block here waiting
    // for a human click on every weapon use. `subsequentActions: false` in
    // the usage config skips triggering that follow-up roll entirely: the
    // item is still consumed/its chat card still posted, but a caller wanting
    // the actual attack/damage roll needs a separate, dedicated roll call
    // (out of scope for this endpoint per PLAN.md's own minimal "trigger a
    // use" wording — no activity-id or roll-target input exists here to
    // configure one anyway).
    await (fn as (usage: unknown, dialog: unknown, message: unknown) => Promise<unknown>).call(
      item,
      { subsequentActions: false },
      DIALOG_SKIP_CONFIRM,
      MESSAGE_CREATE,
    );
    const obj = item.toObject() as Record<string, unknown>;
    return { id: item.id, name: String(obj["name"] ?? ""), used: true };
  },
);
