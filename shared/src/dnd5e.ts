// Phase 34 — dnd5e Integration: Detection & Read-Only Data.
//
// Command names and payload/result shapes for the first optional integration
// (Phase 32/33's framework), shared between the server's integration
// endpoints (server/src/integrations/dnd5e/endpoints.ts) and the module's
// dnd5e command handlers (module/src/commands/dnd5e.ts).
//
// Unlike the core domains in this directory, these commands only ever run in
// a Foundry world whose active system is dnd5e (server/src/integrations/
// dnd5e/index.ts's `detect`) — but the shapes themselves stay defensive
// against missing/renamed fields regardless, per this phase's PLAN.md
// deviation-log entry: no live dnd5e instance was available to verify field
// paths against, across any of dnd5e's 2.x/3.x/4.x releases.
//
// `id: string` input follows the same one-field-input convention every other
// domain uses (e.g. `ActorIdInput` in ./actors.ts) — redefined locally here
// rather than importing `ActorIdInput` across domain files, matching this
// codebase's existing precedent (every domain with an id-only input, e.g.
// `SceneIdInput`/`MacroIdInput`/`PackEntryIdInput`, defines its own rather
// than sharing one).
// Phase 35 — dnd5e Integration: Actions. Adds seven write-action commands
// (ability check/saving throw/skill/death-save rolls, rest, spell-slot
// adjustment, item use) on top of Phase 34's three read-only ones. Same
// no-live-instance caveat as Phase 34 applies here too, plus a stronger one:
// dnd5e's actor roll-method names have themselves changed across its
// 2.x/3.x/4.x releases (PLAN.md's own Phase 35 text) — see this phase's
// PLAN.md deviation-log entry and module/src/commands/dnd5e.ts's
// `callFirstAvailableMethod` for the multi-candidate-name mitigation this
// uses instead of committing to one method name per action.
//
// `Dnd5eRollActionResult` intentionally redefines the same three fields
// `RollEvaluateResult` (./rolls.ts) already declares, rather than importing
// it — matching this file's own existing precedent (see the header comment
// above) of not cross-importing a shape from another domain file even when
// it's structurally identical.
export const DND5E_COMMANDS = {
  CONFIG: "dnd5eConfig",
  ACTOR_SHEET: "dnd5eActorSheet",
  ACTOR_INVENTORY: "dnd5eActorInventory",
  ROLL_ABILITY_CHECK: "dnd5eRollAbilityCheck",
  ROLL_SAVING_THROW: "dnd5eRollSavingThrow",
  ROLL_SKILL: "dnd5eRollSkill",
  ROLL_DEATH_SAVE: "dnd5eRollDeathSave",
  REST: "dnd5eRest",
  ADJUST_SPELL_SLOT: "dnd5eAdjustSpellSlot",
  USE_ITEM: "dnd5eUseItem",
} as const;

export interface Dnd5eActorIdInput {
  id: string;
}

export interface Dnd5eAbilityRollInput extends Dnd5eActorIdInput {
  ability: string;
}

export interface Dnd5eSkillRollInput extends Dnd5eActorIdInput {
  skill: string;
}

export interface Dnd5eRestInput extends Dnd5eActorIdInput {
  type: "short" | "long";
}

export interface Dnd5eSpellSlotInput extends Dnd5eActorIdInput {
  level: number | "pact";
  delta: number;
}

export interface Dnd5eItemUseInput {
  id: string;
}

/** Normalized roll result — the same shape as `RollEvaluateResult` (./rolls.ts). */
export interface Dnd5eRollActionResult {
  formula: string;
  total: number;
  /** The resolved expression with each die replaced by its rolled value, e.g. "(4 + 2)". */
  result: string;
  dice: { faces: number; results: number[] }[];
}

export interface Dnd5eRestResult {
  type: "short" | "long";
  deltaHitPoints: number;
  newDay: boolean;
}

export interface Dnd5eSpellSlotResult {
  level: number | "pact";
  value: number;
  max: number;
}

export interface Dnd5eItemUseResult {
  id: string;
  name: string;
  used: boolean;
}

export interface Dnd5eConfigResult {
  abilities: { id: string; label: string; abbreviation: string }[];
  skills: { id: string; label: string; ability: string }[];
  damageTypes: { id: string; label: string }[];
  conditionTypes: { id: string; label: string }[];
}

export interface Dnd5eActorSheetResult {
  id: string;
  name: string;
  abilities: Record<string, { value: number; mod: number; save: number; proficient: number }>;
  skills: Record<string, { total: number; passive: number; proficient: number; ability: string }>;
  armorClass: number;
  hitPoints: { value: number; max: number; temp: number };
  senses: Record<string, number | string | undefined>;
  currency: Record<string, number>;
  spellSlots: Record<string, { value: number; max: number }>;
  classes: { name: string; level: number }[];
  level: number;
  proficiencyBonus: number;
}

export interface Dnd5eInventoryItem {
  id: string;
  name: string;
  type: string;
  quantity: number;
  equipped: boolean;
  attuned: boolean;
  activities: { id: string; name: string; type: string }[];
}
