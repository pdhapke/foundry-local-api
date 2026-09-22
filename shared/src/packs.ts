// Phase 20 — Compendium Packs. Unlike every document-CRUD phase since Phase
// 8 (JournalEntry/Actor/Item/Scene/Macro/Combat/Playlist/RollTable/Cards/
// Folder), a compendium pack has no `game.collections` entry at all — packs
// live on their own top-level `game.packs` collection, keyed by pack id
// (e.g. "world.my-macros" or "dnd5e.monsters"), so this is hand-rolled from
// scratch like Phase 12's tokens, following the same `<parent>Id`/`<child>Id`
// embedded-id shape those established (packId/entryId here). Shared between
// the server's pack endpoints (server/src/endpoints/packs.ts) and the
// module's pack command handlers (module/src/commands/packs.ts).
//
// Entry data itself reuses Phase 8's `DocumentData`/`DocumentDeleteResult`
// shapes (shared/src/documents.ts) — a compendium entry is a regular Foundry
// Document, just stored in a pack instead of a world collection.

export const PACK_COMMANDS = {
  LIST: "packList",
  GET_INDEX: "packGetIndex",
  GET_ENTRY: "packGetEntry",
  CREATE_ENTRY: "packCreateEntry",
  UPDATE_ENTRY: "packUpdateEntry",
  DELETE_ENTRY: "packDeleteEntry",
  IMPORT_ENTRY: "packImportEntry",
} as const;

/** One pack's metadata, as surfaced by `CompendiumCollection#metadata`. */
export interface PackInfo {
  /** The pack's own id, e.g. "world.my-macros" or "dnd5e.monsters". */
  id: string;
  label: string;
  /** The Foundry document type this pack stores, e.g. "Actor", "Item", "JournalEntry". */
  type: string;
  /** The id of the package (world/system/module) that owns this pack. */
  package: string;
  packageType: string;
  system?: string;
  path: string;
}

/** A lightweight entry from a pack's index (not the full document). */
export type PackIndexEntry = Record<string, unknown> & { _id: string; name: string };

export interface PackIdInput {
  packId: string;
}

export interface PackEntryIdInput {
  packId: string;
  entryId: string;
}

export interface PackCreateEntryInput {
  packId: string;
  data: Record<string, unknown>;
}

export interface PackUpdateEntryInput {
  packId: string;
  entryId: string;
  changes: Record<string, unknown>;
}
