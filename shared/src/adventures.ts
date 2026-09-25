// Phase 53 — Adventure Document Import/Export.
//
// `Adventure` is compendium-only in Foundry (v10+) — no `game.collections`
// entry, no top-level world collection, unlike Actor/Item/Scene/etc. It only
// ever lives inside an Adventure-type compendium pack, reached the same way
// Phase 20/51 reach any pack entry (`game.packs` -> `pack.getDocument(id)`).
// Import reuses `PackEntryIdInput` from shared/src/packs.ts as-is (packId +
// entryId) since importing an adventure entry needs nothing beyond that pair
// — no new "import input" type is defined here; callers import
// `PackEntryIdInput` directly from `@foundry-local-api/shared` (already
// re-exported there via packs.ts). Export is a new shape: it takes a target
// pack plus per-document-type world ids to assemble into the new Adventure's
// content.

export const ADVENTURE_COMMANDS = {
  EXPORT: "adventureExport",
  IMPORT: "adventureImport",
} as const;

/**
 * Input for assembling and creating a new Adventure entry inside a
 * compendium pack (Phase 53). Each `*Ids` field lists world-document ids
 * of the matching type to bundle into the adventure's content; all are
 * optional since an adventure need not include every document type.
 */
export interface AdventureExportInput {
  packId: string;
  name: string;
  img?: string | undefined;
  caption?: string | undefined;
  description?: string | undefined;
  actorIds?: string[] | undefined;
  itemIds?: string[] | undefined;
  sceneIds?: string[] | undefined;
  journalIds?: string[] | undefined;
  macroIds?: string[] | undefined;
  tableIds?: string[] | undefined;
  cardsIds?: string[] | undefined;
  playlistIds?: string[] | undefined;
  folderIds?: string[] | undefined;
  combatIds?: string[] | undefined;
}

/**
 * Whatever `Adventure#import()` resolves to. Read defensively (Phase 34
 * convention): the exact field shape isn't live-verified against a running
 * world, so this is a plain pass-through rather than a hand-specified
 * interface.
 */
export type AdventureImportResult = Record<string, unknown>;
