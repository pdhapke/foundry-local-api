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
  type Dnd5eActorIdInput,
  type Dnd5eActorSheetResult,
  type Dnd5eConfigResult,
  type Dnd5eInventoryItem,
} from "@foundry-local-api/shared";

import type { AnyEndpointDescriptor, EndpointDescriptor } from "../../endpoints/types.js";

const idSchema = z.object({ id: z.string().min(1) });

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

export const dnd5eEndpointDescriptors: AnyEndpointDescriptor[] = [
  getConfigDescriptor,
  getActorSheetDescriptor,
  getActorInventoryDescriptor,
];
