// Phase 16 — Combat & Combat Tracker.
//
// Base CRUD reuses the Phase 8 `makeDocumentEndpoints()` factory with
// `documentType: "Combat"`, same as JournalEntry/Actor/Item/Scene/Macro. The
// extras PLAN.md's Phase 16 calls for (start/next-turn/next-round/end,
// add/remove combatant, roll initiative) are hand-rolled here — see
// module/src/commands/combats.ts for the matching module-side handlers.
//
// Turn/round control and roll-initiative return the updated Combat's
// `toObject()` (consistent with Phase 11's scene activate returning
// `toObject()`), so a caller can see the new turn/round/initiative order
// without a follow-up `GET`. Add-combatant returns the created Combatant's
// own data (consistent with every embedded-create descriptor since Phase
// 10); remove-combatant returns a `DocumentDeleteResult` keyed on the
// combatant's id.
//
// Phase 39 added embedded Combatant update (`PUT .../combatants/:combatantId`),
// following the same embedded-child-route shape as remove-combatant.
// Phase 40 added previous-turn/previous-round, mirroring next-turn/
// next-round as direct pass-throughs to `Combat#previousTurn()`/
// `Combat#previousRound()`. Unlike Phase 37's `endCombat()` finding, Foundry
// core's source shows neither method opening a dialog — but this hasn't been
// live-verified against a running world the way Phase 37's fixes were, so
// treat that as an assumption to confirm on the next live smoke-test pass.
import { z } from "zod";

import {
  COMBAT_COMMANDS,
  type CombatAddCombatantInput,
  type CombatIdInput,
  type CombatRemoveCombatantInput,
  type CombatRollInitiativeInput,
  type CombatUpdateCombatantInput,
  type DocumentData,
  type DocumentDeleteResult,
} from "@foundry-local-api/shared";

import { makeDocumentEndpoints } from "./documents.js";
import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";

const idSchema = z.object({ id: z.string().min(1) });
const documentDataSchema = z.record(z.string(), z.unknown());
const addCombatantSchema = idSchema.extend({ data: documentDataSchema });
const removeCombatantSchema = z.object({
  id: z.string().min(1),
  combatantId: z.string().min(1),
});
const updateCombatantSchema = z.object({
  id: z.string().min(1),
  combatantId: z.string().min(1),
  data: documentDataSchema,
});
const rollInitiativeSchema = idSchema.extend({
  combatantIds: z.array(z.string().min(1)).optional(),
});

const startDescriptor: EndpointDescriptor<CombatIdInput, DocumentData> = {
  name: "foundry_start_combat",
  description: "Starts a combat encounter, setting round 1 and rolling the initial turn order.",
  method: "post",
  path: "/combats/:id/start",
  inputSchema: idSchema,
  handler: ({ id }, { foundryClient }) =>
    foundryClient.call<CombatIdInput, DocumentData>(COMBAT_COMMANDS.START, { id }),
};

const nextTurnDescriptor: EndpointDescriptor<CombatIdInput, DocumentData> = {
  name: "foundry_combat_next_turn",
  description: "Advances a combat to the next turn.",
  method: "post",
  path: "/combats/:id/next-turn",
  inputSchema: idSchema,
  handler: ({ id }, { foundryClient }) =>
    foundryClient.call<CombatIdInput, DocumentData>(COMBAT_COMMANDS.NEXT_TURN, { id }),
};

const nextRoundDescriptor: EndpointDescriptor<CombatIdInput, DocumentData> = {
  name: "foundry_combat_next_round",
  description: "Advances a combat to the next round.",
  method: "post",
  path: "/combats/:id/next-round",
  inputSchema: idSchema,
  handler: ({ id }, { foundryClient }) =>
    foundryClient.call<CombatIdInput, DocumentData>(COMBAT_COMMANDS.NEXT_ROUND, { id }),
};

const previousTurnDescriptor: EndpointDescriptor<CombatIdInput, DocumentData> = {
  name: "foundry_combat_previous_turn",
  description: "Steps a combat back to the previous turn.",
  method: "post",
  path: "/combats/:id/previous-turn",
  inputSchema: idSchema,
  handler: ({ id }, { foundryClient }) =>
    foundryClient.call<CombatIdInput, DocumentData>(COMBAT_COMMANDS.PREVIOUS_TURN, { id }),
};

const previousRoundDescriptor: EndpointDescriptor<CombatIdInput, DocumentData> = {
  name: "foundry_combat_previous_round",
  description: "Steps a combat back to the previous round.",
  method: "post",
  path: "/combats/:id/previous-round",
  inputSchema: idSchema,
  handler: ({ id }, { foundryClient }) =>
    foundryClient.call<CombatIdInput, DocumentData>(COMBAT_COMMANDS.PREVIOUS_ROUND, { id }),
};

const endDescriptor: EndpointDescriptor<CombatIdInput, DocumentDeleteResult> = {
  name: "foundry_end_combat",
  // Ending a combat deletes it (Foundry core's own `Combat#endCombat()` is
  // just a confirmation dialog around `this.delete()` — see this file's
  // module-side counterpart, module/src/commands/combats.ts, for the
  // live-verified deviation-log entry), so this returns a delete result
  // (`{id}`), not the since-deleted document's data.
  description: "Ends a combat encounter (deletes it).",
  method: "post",
  path: "/combats/:id/end",
  inputSchema: idSchema,
  handler: ({ id }, { foundryClient }) =>
    foundryClient.call<CombatIdInput, DocumentDeleteResult>(COMBAT_COMMANDS.END, { id }),
};

const addCombatantDescriptor: EndpointDescriptor<CombatAddCombatantInput, DocumentData> = {
  name: "foundry_add_combatant",
  description: "Adds a new embedded Combatant to a combat (e.g. from a token/actor).",
  method: "post",
  path: "/combats/:id/combatants",
  inputSchema: addCombatantSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<CombatAddCombatantInput, DocumentData>(COMBAT_COMMANDS.ADD_COMBATANT, input),
};

const removeCombatantDescriptor: EndpointDescriptor<
  CombatRemoveCombatantInput,
  DocumentDeleteResult
> = {
  name: "foundry_remove_combatant",
  description: "Removes an embedded Combatant from a combat by id.",
  method: "delete",
  path: "/combats/:id/combatants/:combatantId",
  inputSchema: removeCombatantSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<CombatRemoveCombatantInput, DocumentDeleteResult>(
      COMBAT_COMMANDS.REMOVE_COMBATANT,
      input,
    ),
};

const updateCombatantDescriptor: EndpointDescriptor<CombatUpdateCombatantInput, DocumentData> = {
  name: "foundry_update_combatant",
  description:
    "Updates fields on an embedded Combatant (e.g. defeated, hidden, initiative, name override).",
  method: "put",
  path: "/combats/:id/combatants/:combatantId",
  inputSchema: updateCombatantSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<CombatUpdateCombatantInput, DocumentData>(
      COMBAT_COMMANDS.UPDATE_COMBATANT,
      input,
    ),
};

const rollInitiativeDescriptor: EndpointDescriptor<CombatRollInitiativeInput, DocumentData> = {
  name: "foundry_roll_combat_initiative",
  description:
    "Rolls initiative for the given combatant ids, or for every combatant missing initiative " +
    "if no ids are given.",
  method: "post",
  path: "/combats/:id/roll-initiative",
  inputSchema: rollInitiativeSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<CombatRollInitiativeInput, DocumentData>(
      COMBAT_COMMANDS.ROLL_INITIATIVE,
      input,
    ),
};

export const combatEndpointDescriptors: AnyEndpointDescriptor[] = [
  ...makeDocumentEndpoints({
    documentType: "Combat",
    routeBase: "combats",
    toolSingular: "combat",
    toolPlural: "combats",
  }),
  startDescriptor,
  nextTurnDescriptor,
  nextRoundDescriptor,
  previousTurnDescriptor,
  previousRoundDescriptor,
  endDescriptor,
  addCombatantDescriptor,
  removeCombatantDescriptor,
  updateCombatantDescriptor,
  rollInitiativeDescriptor,
];
