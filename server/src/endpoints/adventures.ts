// Phase 53 — Adventure Document Import/Export.
//
// `Adventure` is compendium-only in Foundry (v10+) — no `game.collections`
// entry, no top-level world collection, unlike Actor/Item/Scene/etc. It only
// ever lives inside an Adventure-type compendium pack, reached the same way
// Phase 20/51 reach any pack entry. Own domain file (not folded into
// packs.ts) since this is content-assembly + a bulk-mutation verb rather
// than pack-entry CRUD. See module/src/commands/adventures.ts for the
// matching module-side handlers.
import { z } from "zod";

import {
  ADVENTURE_COMMANDS,
  type AdventureExportInput,
  type AdventureImportResult,
  type DocumentData,
  type PackEntryIdInput,
} from "@foundry-local-api/shared";

import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";

const idListSchema = z.array(z.string().min(1)).optional();

const exportAdventureSchema = z.object({
  packId: z.string().min(1),
  name: z.string().min(1),
  img: z.string().optional(),
  caption: z.string().optional(),
  description: z.string().optional(),
  actorIds: idListSchema,
  itemIds: idListSchema,
  sceneIds: idListSchema,
  journalIds: idListSchema,
  macroIds: idListSchema,
  tableIds: idListSchema,
  cardsIds: idListSchema,
  playlistIds: idListSchema,
  folderIds: idListSchema,
  combatIds: idListSchema,
});

const importAdventureSchema = z.object({
  packId: z.string().min(1),
  entryId: z.string().min(1),
});

const exportAdventureDescriptor: EndpointDescriptor<AdventureExportInput, DocumentData> = {
  name: "foundry_export_adventure",
  description:
    "Assembles world documents (by id, per document type) into a new Adventure compendium " +
    "entry inside the given pack — the convenience assembly step around creating an Adventure " +
    "entry by hand.",
  method: "post",
  path: "/packs/:packId/adventures",
  inputSchema: exportAdventureSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<AdventureExportInput, DocumentData>(ADVENTURE_COMMANDS.EXPORT, input),
};

const importAdventureDescriptor: EndpointDescriptor<PackEntryIdInput, AdventureImportResult> = {
  name: "foundry_import_adventure",
  description:
    "Imports an Adventure compendium entry into the world, creating/updating documents across " +
    "every world collection the adventure's content covers (actors, scenes, items, journals, " +
    "etc.) in one bulk operation. WARNING: this can create or overwrite many documents at once.",
  method: "post",
  path: "/packs/:packId/adventures/:entryId/import",
  inputSchema: importAdventureSchema,
  annotations: {
    title: "Import Adventure",
    destructiveHint: true,
  },
  handler: (input, { foundryClient }) =>
    foundryClient.call<PackEntryIdInput, AdventureImportResult>(ADVENTURE_COMMANDS.IMPORT, input),
};

export const adventureEndpointDescriptors: AnyEndpointDescriptor[] = [
  exportAdventureDescriptor,
  importAdventureDescriptor,
];
