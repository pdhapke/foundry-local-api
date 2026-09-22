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
import {
  DND5E_COMMANDS,
  type Dnd5eActorIdInput,
  type Dnd5eActorSheetResult,
  type Dnd5eConfigResult,
  type Dnd5eInventoryItem,
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
