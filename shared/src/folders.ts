// Phase 19 — Folders. Command name and payload shape for the one
// Folder-specific extra layered on top of the Phase 8 generic document CRUD
// (Folder CRUD itself reuses DOCUMENT_COMMANDS with documentType: "Folder",
// identical to Scene/Actor/Item/Macro/Combat/Playlist/RollTable/Cards),
// shared between the server's folder endpoints
// (server/src/endpoints/folders.ts) and the module's folder command handlers
// (module/src/commands/folders.ts).
//
// Moving a document into a folder is just setting that document's own
// `folder` field — already possible via the generic `documentUpdate` command
// with `changes: { folder: ... }` — but PLAN.md's Phase 19 calls it out as
// its own operation, so it gets a dedicated, friendlier command/tool rather
// than requiring a caller to know the raw field name, consistent with how
// Phase 11's `activate`/Phase 12's `move` wrap a plain `update()` too. Unlike
// those, the document being moved isn't necessarily a Folder itself — it's
// any folder-capable document (Actor, Item, JournalEntry, Scene, Macro,
// Playlist, RollTable, Cards, or a Folder being renested) — so `documentType`
// travels in the payload the same way it does for the generic document
// commands.

export const FOLDER_COMMANDS = {
  MOVE_DOCUMENT: "folderMoveDocument",
} as const;

export interface FolderMoveDocumentInput {
  /** Foundry document type of the document being moved, e.g. "Actor", "JournalEntry", or "Folder" itself to renest a folder. */
  documentType: string;
  /** The document's id. */
  id: string;
  /** Target folder id, or null to move the document to the root (no folder). */
  folderId: string | null;
}
