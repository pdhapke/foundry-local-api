// Phase 19 — Folders command handler. Registered against the same command
// dispatcher registry Phase 2 set up (module/src/command-registry.ts) and
// imported for side effects from module/src/index.ts.
//
// Folder CRUD itself is NOT re-implemented here: it's already covered
// generically by Phase 8's documentList/Get/Create/Update/Delete commands
// with `documentType: "Folder"` (see server/src/endpoints/folders.ts, which
// calls the same `makeDocumentEndpoints()` factory JournalEntry/Actor/Item/
// Scene/Macro/Combat/Playlist/RollTable/Cards use). This file only adds the
// one Folder-specific extra PLAN.md's Phase 19 calls for: moving a document
// into a folder.
//
// Moving a document is just setting its own `folder` field via the generic
// `FoundryDocument#update()` Phase 8 already declared — no new ambient
// declaration was needed.
import {
  FOLDER_COMMANDS,
  type DocumentData,
  type FolderMoveDocumentInput,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";

registerCommand(
  FOLDER_COMMANDS.MOVE_DOCUMENT,
  async ({ documentType, id, folderId }: FolderMoveDocumentInput): Promise<DocumentData> => {
    const collection = game.collections.get(documentType);
    const doc = collection?.get(id);
    if (!doc) {
      throw new Error(`${documentType} "${id}" not found`);
    }
    await doc.update({ folder: folderId });
    return doc.toObject();
  },
);
