// Phase 19 — Folders.
//
// Base CRUD reuses the Phase 8 `makeDocumentEndpoints()` factory with
// `documentType: "Folder"`, same as JournalEntry/Actor/Item/Scene/Macro/
// Combat/Playlist/RollTable/Cards. The one extra PLAN.md's Phase 19 calls
// for ("move documents between folders") is hand-rolled here — see
// module/src/commands/folders.ts for the matching module-side handler.
import { z } from "zod";

import {
  FOLDER_COMMANDS,
  type DocumentData,
  type FolderMoveDocumentInput,
} from "@foundry-local-api/shared";

import { makeDocumentEndpoints } from "./documents.js";
import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";

const moveDocumentSchema = z.object({
  documentType: z.string().min(1),
  id: z.string().min(1),
  folderId: z.string().min(1).nullable(),
});

const moveDocumentDescriptor: EndpointDescriptor<FolderMoveDocumentInput, DocumentData> = {
  name: "foundry_move_document_to_folder",
  description:
    "Moves any folder-capable document (Actor, Item, JournalEntry, Scene, Macro, Playlist, " +
    "RollTable, Cards, or a Folder itself to renest it) into a folder by id, or to the root " +
    "when folderId is null.",
  method: "post",
  path: "/folders/move-document",
  inputSchema: moveDocumentSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<FolderMoveDocumentInput, DocumentData>(
      FOLDER_COMMANDS.MOVE_DOCUMENT,
      input,
    ),
};

export const folderEndpointDescriptors: AnyEndpointDescriptor[] = [
  ...makeDocumentEndpoints({
    documentType: "Folder",
    routeBase: "folders",
    toolSingular: "folder",
    toolPlural: "folders",
  }),
  moveDocumentDescriptor,
];
