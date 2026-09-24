// Phase 20 — Compendium Packs.
//
// A compendium pack has no `game.collections` entry of its own (unlike every
// document-CRUD phase since Phase 8), so all descriptors here are
// hand-rolled, following the same `<parent>Id`/`<child>Id` embedded-id shape
// Phase 12 established for embedded tokens — packId/entryId here. See
// module/src/commands/packs.ts for the matching module-side handlers.
//
// Phase 51 added the three pack-*lifecycle* descriptors at the bottom
// (create/delete/duplicate the pack itself) — Phase 20 only ever covered
// entries within an already-existing pack.
import { z } from "zod";

import {
  PACK_COMMANDS,
  type DocumentData,
  type DocumentDeleteResult,
  type PackCreateEntryInput,
  type PackCreatePackInput,
  type PackDuplicatePackInput,
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

// Phase 51 — pack lifecycle. Read defensively per the Phase 34 convention:
// `CompendiumCollection.createCompendium()`'s metadata shape is documented
// but not live-verified against a running world, so this only requires the
// two fields Foundry's own docs call the minimum (`type`, `label`) and
// passes everything else through mostly as-is rather than over-specifying.
const createPackSchema = z.object({
  type: z.string().min(1),
  label: z.string().min(1),
  name: z.string().min(1).optional(),
});
const duplicatePackSchema = packIdSchema.extend({ label: z.string().min(1).optional() });

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

// Phase 51 — Compendium Pack Lifecycle. Phase 20 only covers entries within
// an existing pack; these three drive the pack itself. `POST /packs` and
// `DELETE /packs/:packId` are new path shapes not previously registered (the
// existing entry-level routes all live under `/packs/:packId/entries[/...]`),
// so there's no Phase-50-style `:packId`-swallowing risk to guard against
// here — confirmed by reading every existing descriptor above before adding
// these.
const createPackDescriptor: EndpointDescriptor<PackCreatePackInput, PackInfo> = {
  name: "foundry_create_pack",
  description: "Creates a new, empty compendium pack of the given document type.",
  method: "post",
  path: "/packs",
  inputSchema: createPackSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<PackCreatePackInput, PackInfo>(PACK_COMMANDS.CREATE_PACK, input),
};

const deletePackDescriptor: EndpointDescriptor<PackIdInput, DocumentDeleteResult> = {
  name: "foundry_delete_pack",
  description:
    "Deletes an entire compendium pack, including every entry inside it. WARNING: this is " +
    "destructive and cannot be undone — the pack and all its contents are permanently removed, " +
    "not just emptied.",
  method: "delete",
  path: "/packs/:packId",
  inputSchema: packIdSchema,
  annotations: {
    title: "Delete Compendium Pack",
    destructiveHint: true,
  },
  handler: (input, { foundryClient }) =>
    foundryClient.call<PackIdInput, DocumentDeleteResult>(PACK_COMMANDS.DELETE_PACK, input),
};

const duplicatePackDescriptor: EndpointDescriptor<PackDuplicatePackInput, PackInfo> = {
  name: "foundry_duplicate_pack",
  description: "Duplicates a compendium pack, including all of its entries, under a new label.",
  method: "post",
  path: "/packs/:packId/duplicate",
  inputSchema: duplicatePackSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<PackDuplicatePackInput, PackInfo>(PACK_COMMANDS.DUPLICATE_PACK, input),
};

export const packEndpointDescriptors: AnyEndpointDescriptor[] = [
  listPacksDescriptor,
  getPackIndexDescriptor,
  getPackEntryDescriptor,
  createPackEntryDescriptor,
  updatePackEntryDescriptor,
  deletePackEntryDescriptor,
  importPackEntryDescriptor,
  createPackDescriptor,
  deletePackDescriptor,
  duplicatePackDescriptor,
];
