// Phase 9 — Actors.
//
// Base CRUD reuses the Phase 8 `makeDocumentEndpoints()` factory with
// `documentType: "Actor"`, same as JournalEntry. The two extras PLAN.md's
// Phase 9 calls for (roll data, embedded items) are hand-rolled here since
// they're actor-specific, not generic document behavior — see
// module/src/commands/actors.ts for the matching module-side handlers.
import { z } from "zod";

import {
  ACTOR_COMMANDS,
  type ActorIdInput,
  type ActorRollData,
  type DocumentData,
} from "@foundry-local-api/shared";

import { makeDocumentEndpoints } from "./documents.js";
import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";

const idSchema = z.object({ id: z.string().min(1) });

const getRollDataDescriptor: EndpointDescriptor<ActorIdInput, ActorRollData> = {
  name: "foundry_get_actor_roll_data",
  description: "Reads an actor's system-specific roll data (Actor#getRollData()).",
  method: "get",
  path: "/actors/:id/roll-data",
  inputSchema: idSchema,
  handler: ({ id }, { foundryClient }) =>
    foundryClient.call<ActorIdInput, ActorRollData>(ACTOR_COMMANDS.GET_ROLL_DATA, { id }),
};

const listItemsDescriptor: EndpointDescriptor<ActorIdInput, DocumentData[]> = {
  name: "foundry_list_actor_items",
  description: "Lists an actor's embedded Item documents.",
  method: "get",
  path: "/actors/:id/items",
  inputSchema: idSchema,
  handler: ({ id }, { foundryClient }) =>
    foundryClient.call<ActorIdInput, DocumentData[]>(ACTOR_COMMANDS.LIST_ITEMS, { id }),
};

export const actorEndpointDescriptors: AnyEndpointDescriptor[] = [
  ...makeDocumentEndpoints({
    documentType: "Actor",
    routeBase: "actors",
    toolSingular: "actor",
    toolPlural: "actors",
  }),
  getRollDataDescriptor,
  listItemsDescriptor,
];
