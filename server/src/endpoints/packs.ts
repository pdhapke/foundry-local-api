// Phase 20 — Compendium Packs.
//
// A compendium pack has no `game.collections` entry of its own (unlike every
// document-CRUD phase since Phase 8), so all seven descriptors here are
// hand-rolled, following the same `<parent>Id`/`<child>Id` embedded-id shape
// Phase 12 established for embedded tokens — packId/entryId here. See
// module/src/commands/packs.ts for the matching module-side handlers.
import { z } from "zod";

import {
  PACK_COMMANDS,
  type DocumentData,
  type DocumentDeleteResult,
  type PackCreateEntryInput,
  type PackEntryIdInput,
  type PackIdInput,
  type PackIndexEntry,
  type PackInfo,
  type PackUpdateEntryInput,
} from "@foundry-local-api/shared";

import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";

const documentDataSchema = z.record(z.string(), z.unknown());
const packIdSchema = z.object({ packId: z.string().min(1) });
const entryIdSchema = packIdSchema.extend({ entryId: z.string().min(1) });
const createSchema = packIdSchema.extend({ data: documentDataSchema });
const updateSchema = entryIdSchema.extend({ changes: documentDataSchema });

const listPacksDescriptor: EndpointDescriptor<void, PackInfo[]> = {
  name: "foundry_list_packs",
  description:
    "Lists every compendium pack available in the world (id, label, document type, source package).",
  method: "get",
  path: "/packs",
  handler: (_input, { foundryClient }) =>
    foundryClient.call<undefined, PackInfo[]>(PACK_COMMANDS.LIST),
};

const getPackIndexDescriptor: EndpointDescriptor<PackIdInput, PackIndexEntry[]> = {
  name: "foundry_get_pack_index",
  description:
    "Reads a compendium pack's index: lightweight entries (id, name, and a few other fields) without loading each full document.",
  method: "get",
  path: "/packs/:packId/index",
  inputSchema: packIdSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<PackIdInput, PackIndexEntry[]>(PACK_COMMANDS.GET_INDEX, input),
};

const getPackEntryDescriptor: EndpointDescriptor<PackEntryIdInput, DocumentData> = {
  name: "foundry_get_pack_entry",
  description: "Reads a single compendium entry's full document data by id.",
  method: "get",
  path: "/packs/:packId/entries/:entryId",
  inputSchema: entryIdSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<PackEntryIdInput, DocumentData>(PACK_COMMANDS.GET_ENTRY, input),
};

const createPackEntryDescriptor: EndpointDescriptor<PackCreateEntryInput, DocumentData> = {
  name: "foundry_create_pack_entry",
  description: "Creates a new entry (document) directly inside a compendium pack.",
  method: "post",
  path: "/packs/:packId/entries",
  inputSchema: createSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<PackCreateEntryInput, DocumentData>(PACK_COMMANDS.CREATE_ENTRY, input),
};

const updatePackEntryDescriptor: EndpointDescriptor<PackUpdateEntryInput, DocumentData> = {
  name: "foundry_update_pack_entry",
  description: "Updates fields on an existing compendium entry.",
  method: "put",
  path: "/packs/:packId/entries/:entryId",
  inputSchema: updateSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<PackUpdateEntryInput, DocumentData>(PACK_COMMANDS.UPDATE_ENTRY, input),
};

const deletePackEntryDescriptor: EndpointDescriptor<PackEntryIdInput, DocumentDeleteResult> = {
  name: "foundry_delete_pack_entry",
  description: "Deletes an entry from a compendium pack by id.",
  method: "delete",
  path: "/packs/:packId/entries/:entryId",
  inputSchema: entryIdSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<PackEntryIdInput, DocumentDeleteResult>(PACK_COMMANDS.DELETE_ENTRY, input),
};

const importPackEntryDescriptor: EndpointDescriptor<PackEntryIdInput, DocumentData> = {
  name: "foundry_import_pack_entry",
  description:
    "Imports a compendium entry into the world, creating a new document in the matching world collection.",
  method: "post",
  path: "/packs/:packId/entries/:entryId/import",
  inputSchema: entryIdSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<PackEntryIdInput, DocumentData>(PACK_COMMANDS.IMPORT_ENTRY, input),
};

export const packEndpointDescriptors: AnyEndpointDescriptor[] = [
  listPacksDescriptor,
  getPackIndexDescriptor,
  getPackEntryDescriptor,
  createPackEntryDescriptor,
  updatePackEntryDescriptor,
  deletePackEntryDescriptor,
  importPackEntryDescriptor,
];
