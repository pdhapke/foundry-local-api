// Phase 34 — dnd5e Integration: Detection & Read-Only Data.
//
// Three read-only descriptors ("prove the slice" first, same as Phase 6),
// following the exact `EndpointDescriptor` pattern every core domain uses
// (server/src/endpoints/meta.ts) — the only difference from a core domain's
// descriptors is that these are never spread into `allEndpointDescriptors`
// (server/src/endpoints/index.ts); they're mounted exclusively through the
// Phase 32 integration registry/router (../registry.ts -> ./index.ts's
// `dnd5eIntegration`), active only when the connected world's system is
// dnd5e (../types.ts's `detect`).
import { z } from "zod";

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

import type { AnyEndpointDescriptor, EndpointDescriptor } from "../../endpoints/types.js";

const idSchema = z.object({ id: z.string().min(1) });

// Phase 35 — write-action descriptors. `ability`/`skill` are validated only
// as non-empty strings, not a closed enum: `CONFIG.DND5E`'s actual
// ability/skill ids are dynamic and version-dependent (see Phase 34's own
// `dnd5e_get_config` tool, which exists precisely so a caller can discover
// the real ids rather than this codebase hardcoding them).
const abilityRollSchema = z.object({ id: z.string().min(1), ability: z.string().min(1) });
const skillRollSchema = z.object({ id: z.string().min(1), skill: z.string().min(1) });
const restSchema = z.object({ id: z.string().min(1), type: z.enum(["short", "long"]) });
const spellSlotSchema = z.object({
  id: z.string().min(1),
  level: z.union([z.number().int().min(1).max(9), z.literal("pact")]),
  delta: z.number().int(),
});

const getConfigDescriptor: EndpointDescriptor<void, Dnd5eConfigResult> = {
  name: "dnd5e_get_config",
  description:
    "Relevant slices of dnd5e's CONFIG.DND5E (abilities, skills, damage types, condition types) so a caller doesn't need hardcoded dnd5e knowledge to interpret raw actor data.",
  method: "get",
  path: "/dnd5e/config",
  handler: (_input, { foundryClient }) =>
    foundryClient.call<undefined, Dnd5eConfigResult>(DND5E_COMMANDS.CONFIG),
};

const getActorSheetDescriptor: EndpointDescriptor<Dnd5eActorIdInput, Dnd5eActorSheetResult> = {
  name: "dnd5e_get_actor_sheet",
  description:
    "Structured dnd5e actor sheet summary: abilities, saves, skills, AC, HP, senses, currency, spell slots, class/level, proficiency bonus.",
  method: "get",
  path: "/dnd5e/actors/:id/sheet",
  inputSchema: idSchema,
  handler: ({ id }, { foundryClient }) =>
    foundryClient.call<Dnd5eActorIdInput, Dnd5eActorSheetResult>(DND5E_COMMANDS.ACTOR_SHEET, {
      id,
    }),
};

const getActorInventoryDescriptor: EndpointDescriptor<Dnd5eActorIdInput, Dnd5eInventoryItem[]> = {
  name: "dnd5e_get_actor_inventory",
  description:
    "An actor's items with dnd5e-specific fields: quantity, equipped, attuned, activities.",
  method: "get",
  path: "/dnd5e/actors/:id/inventory",
  inputSchema: idSchema,
  handler: ({ id }, { foundryClient }) =>
    foundryClient.call<Dnd5eActorIdInput, Dnd5eInventoryItem[]>(DND5E_COMMANDS.ACTOR_INVENTORY, {
      id,
    }),
};

const rollAbilityCheckDescriptor: EndpointDescriptor<Dnd5eAbilityRollInput, Dnd5eRollActionResult> =
  {
    name: "dnd5e_roll_ability_check",
    description: "Rolls a dnd5e ability check for an actor (e.g. a Strength check).",
    method: "post",
    path: "/dnd5e/actors/:id/roll/ability-check",
    inputSchema: abilityRollSchema,
    handler: ({ id, ability }, { foundryClient }) =>
      foundryClient.call<Dnd5eAbilityRollInput, Dnd5eRollActionResult>(
        DND5E_COMMANDS.ROLL_ABILITY_CHECK,
        { id, ability },
      ),
  };

const rollSavingThrowDescriptor: EndpointDescriptor<Dnd5eAbilityRollInput, Dnd5eRollActionResult> =
  {
    name: "dnd5e_roll_saving_throw",
    description: "Rolls a dnd5e saving throw for an actor (e.g. a Dexterity save).",
    method: "post",
    path: "/dnd5e/actors/:id/roll/saving-throw",
    inputSchema: abilityRollSchema,
    handler: ({ id, ability }, { foundryClient }) =>
      foundryClient.call<Dnd5eAbilityRollInput, Dnd5eRollActionResult>(
        DND5E_COMMANDS.ROLL_SAVING_THROW,
        { id, ability },
      ),
  };

const rollSkillDescriptor: EndpointDescriptor<Dnd5eSkillRollInput, Dnd5eRollActionResult> = {
  name: "dnd5e_roll_skill",
  description: "Rolls a dnd5e skill check for an actor (e.g. Stealth).",
  method: "post",
  path: "/dnd5e/actors/:id/roll/skill",
  inputSchema: skillRollSchema,
  handler: ({ id, skill }, { foundryClient }) =>
    foundryClient.call<Dnd5eSkillRollInput, Dnd5eRollActionResult>(DND5E_COMMANDS.ROLL_SKILL, {
      id,
      skill,
    }),
};

const rollDeathSaveDescriptor: EndpointDescriptor<Dnd5eActorIdInput, Dnd5eRollActionResult> = {
  name: "dnd5e_roll_death_save",
  description: "Rolls a dnd5e death saving throw for an actor.",
  method: "post",
  path: "/dnd5e/actors/:id/roll/death-save",
  inputSchema: idSchema,
  handler: ({ id }, { foundryClient }) =>
    foundryClient.call<Dnd5eActorIdInput, Dnd5eRollActionResult>(DND5E_COMMANDS.ROLL_DEATH_SAVE, {
      id,
    }),
};

const restDescriptor: EndpointDescriptor<Dnd5eRestInput, Dnd5eRestResult> = {
  name: "dnd5e_rest",
  description: "Runs a short or long rest for an actor (HP/resource recovery).",
  method: "post",
  path: "/dnd5e/actors/:id/rest",
  inputSchema: restSchema,
  handler: ({ id, type }, { foundryClient }) =>
    foundryClient.call<Dnd5eRestInput, Dnd5eRestResult>(DND5E_COMMANDS.REST, { id, type }),
};

const adjustSpellSlotDescriptor: EndpointDescriptor<Dnd5eSpellSlotInput, Dnd5eSpellSlotResult> = {
  name: "dnd5e_adjust_spell_slot",
  description:
    "Spends or restores one dnd5e spell slot for an actor (negative delta spends, positive restores).",
  method: "post",
  path: "/dnd5e/actors/:id/spell-slots",
  inputSchema: spellSlotSchema,
  handler: ({ id, level, delta }, { foundryClient }) =>
    foundryClient.call<Dnd5eSpellSlotInput, Dnd5eSpellSlotResult>(
      DND5E_COMMANDS.ADJUST_SPELL_SLOT,
      {
        id,
        level,
        delta,
      },
    ),
};

const useItemDescriptor: EndpointDescriptor<Dnd5eItemUseInput, Dnd5eItemUseResult> = {
  name: "dnd5e_use_item",
  description:
    "Triggers a dnd5e item's use (e.g. consuming a charge, activating an activity), searched across world items and every actor's embedded items.",
  method: "post",
  path: "/dnd5e/items/:id/use",
  inputSchema: idSchema,
  handler: ({ id }, { foundryClient }) =>
    foundryClient.call<Dnd5eItemUseInput, Dnd5eItemUseResult>(DND5E_COMMANDS.USE_ITEM, { id }),
};

export const dnd5eEndpointDescriptors: AnyEndpointDescriptor[] = [
  getConfigDescriptor,
  getActorSheetDescriptor,
  getActorInventoryDescriptor,
  rollAbilityCheckDescriptor,
  rollSavingThrowDescriptor,
  rollSkillDescriptor,
  rollDeathSaveDescriptor,
  restDescriptor,
  adjustSpellSlotDescriptor,
  useItemDescriptor,
];
