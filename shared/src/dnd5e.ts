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
export const DND5E_COMMANDS = {
  CONFIG: "dnd5eConfig",
  ACTOR_SHEET: "dnd5eActorSheet",
  ACTOR_INVENTORY: "dnd5eActorInventory",
} as const;

export interface Dnd5eActorIdInput {
  id: string;
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
