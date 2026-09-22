// Phase 10 — Items.
//
// World Item CRUD reuses the Phase 8 `makeDocumentEndpoints()` factory with
// `documentType: "Item"`, identical to how Phase 9 wires Actor CRUD. The
// four embedded-item descriptors below are hand-rolled since an embedded
// Item lives under an owning Actor (`/api/actors/:actorId/items[/:itemId]`),
// not its own top-level collection, so it isn't covered by Phase 8's
// top-level Document CRUD factory. Actor#items *listing* already exists as
// `foundry_list_actor_items` (Phase 9, server/src/endpoints/actors.ts); this
// phase adds get/create/update/delete for a single embedded item. See
// module/src/commands/items.ts for the matching module-side handlers.
import { z } from "zod";

import {
  EMBEDDED_ITEM_COMMANDS,
  type DocumentData,
  type DocumentDeleteResult,
  type EmbeddedItemCreateInput,
  type EmbeddedItemIdInput,
  type EmbeddedItemUpdateInput,
} from "@foundry-local-api/shared";

import { makeDocumentEndpoints } from "./documents.js";
import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";

const documentDataSchema = z.record(z.string(), z.unknown());
const embeddedIdSchema = z.object({ actorId: z.string().min(1), itemId: z.string().min(1) });
const createSchema = z.object({ actorId: z.string().min(1), data: documentDataSchema });
const updateSchema = embeddedIdSchema.extend({ changes: documentDataSchema });

const getEmbeddedItemDescriptor: EndpointDescriptor<EmbeddedItemIdInput, DocumentData> = {
  name: "foundry_get_actor_item",
  description: "Reads a single embedded Item document from an actor by id.",
  method: "get",
  path: "/actors/:actorId/items/:itemId",
  inputSchema: embeddedIdSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<EmbeddedItemIdInput, DocumentData>(EMBEDDED_ITEM_COMMANDS.GET, input),
};

const createEmbeddedItemDescriptor: EndpointDescriptor<EmbeddedItemCreateInput, DocumentData> = {
  name: "foundry_create_actor_item",
  description: "Creates a new embedded Item document on an actor.",
  method: "post",
  path: "/actors/:actorId/items",
  inputSchema: createSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<EmbeddedItemCreateInput, DocumentData>(EMBEDDED_ITEM_COMMANDS.CREATE, input),
};

const updateEmbeddedItemDescriptor: EndpointDescriptor<EmbeddedItemUpdateInput, DocumentData> = {
  name: "foundry_update_actor_item",
  description: "Updates fields on an existing embedded Item document on an actor.",
  method: "put",
  path: "/actors/:actorId/items/:itemId",
  inputSchema: updateSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<EmbeddedItemUpdateInput, DocumentData>(EMBEDDED_ITEM_COMMANDS.UPDATE, input),
};

const deleteEmbeddedItemDescriptor: EndpointDescriptor<EmbeddedItemIdInput, DocumentDeleteResult> =
  {
    name: "foundry_delete_actor_item",
    description: "Deletes an embedded Item document from an actor by id.",
    method: "delete",
    path: "/actors/:actorId/items/:itemId",
    inputSchema: embeddedIdSchema,
    handler: (input, { foundryClient }) =>
      foundryClient.call<EmbeddedItemIdInput, DocumentDeleteResult>(
        EMBEDDED_ITEM_COMMANDS.DELETE,
        input,
      ),
  };

export const itemEndpointDescriptors: AnyEndpointDescriptor[] = [
  ...makeDocumentEndpoints({
    documentType: "Item",
    routeBase: "items",
    toolSingular: "item",
    toolPlural: "items",
  }),
  getEmbeddedItemDescriptor,
  createEmbeddedItemDescriptor,
  updateEmbeddedItemDescriptor,
  deleteEmbeddedItemDescriptor,
];
