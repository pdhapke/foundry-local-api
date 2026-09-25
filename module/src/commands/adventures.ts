// Phase 53 — Adventure Document Import/Export command handlers. Registered
// against the same command dispatcher registry Phase 2 set up
// (module/src/command-registry.ts) and imported for side effects from
// module/src/index.ts.
//
// `Adventure` is compendium-only in Foundry (v10+) — no `game.collections`
// entry, no top-level world collection, unlike Actor/Item/Scene/etc. It only
// ever lives inside an Adventure-type compendium pack, reached the same way
// Phase 20/51 reach any pack entry (`game.packs` -> `pack.getDocument(id)`).
//
// `requirePack()`/`requirePackEntry()`/`requireGM()` are duplicated locally
// here rather than imported from commands/packs.ts, matching this project's
// existing precedent of a small per-file `requireGM()` in packs.ts/
// permissions.ts/users.ts/world-time.ts rather than a shared helpers module.
//
// Both handlers are GM-gated: export creates world-structural content inside
// a pack, and import creates/updates arbitrary documents across many world
// collections in one call — the same class of write Phase 51 GM-gates for
// pack lifecycle operations.
import {
  ADVENTURE_COMMANDS,
  type AdventureExportInput,
  type AdventureImportResult,
  type DocumentData,
  type PackEntryIdInput,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";

function requirePack(packId: string): FoundryCompendiumCollection {
  const pack = game.packs.get(packId);
  if (!pack) {
    throw new Error(`Compendium pack "${packId}" not found`);
  }
  return pack;
}

function requireGM(action: string): void {
  if (!game.user.isGM) {
    throw new Error(`Only a GM may ${action}.`);
  }
}

async function requirePackEntry(
  pack: FoundryCompendiumCollection,
  entryId: string,
): Promise<FoundryDocument> {
  const entry = await pack.getDocument(entryId);
  if (!entry) {
    throw new Error(`Entry "${entryId}" not found in pack "${pack.metadata.id}"`);
  }
  return entry;
}

/**
 * Explicit id-field -> world-collection type -> `Adventure.contentFields`
 * key table (Phase 53), documented rather than inferred generically from
 * string manipulation (e.g. stripping a trailing "Ids"), since the mapping
 * isn't uniform (`journalIds` -> `journal`, `tableIds` -> `tables`,
 * `cardsIds` -> `cards`, everything else `<x>Ids` -> `<x>s`).
 */
const CONTENT_FIELD_MAP: ReadonlyArray<{
  idField: keyof Pick<
    AdventureExportInput,
    | "actorIds"
    | "itemIds"
    | "sceneIds"
    | "journalIds"
    | "macroIds"
    | "tableIds"
    | "cardsIds"
    | "playlistIds"
    | "folderIds"
    | "combatIds"
  >;
  /** The `game.collections` key (Foundry document type name) this id list is resolved against. */
  foundryType: string;
  /** The matching key under `Adventure.contentFields` the resolved documents are assembled into. */
  contentField: string;
}> = [
  { idField: "actorIds", foundryType: "Actor", contentField: "actors" },
  { idField: "itemIds", foundryType: "Item", contentField: "items" },
  { idField: "sceneIds", foundryType: "Scene", contentField: "scenes" },
  { idField: "journalIds", foundryType: "JournalEntry", contentField: "journal" },
  { idField: "macroIds", foundryType: "Macro", contentField: "macros" },
  { idField: "tableIds", foundryType: "RollTable", contentField: "tables" },
  { idField: "cardsIds", foundryType: "Cards", contentField: "cards" },
  { idField: "playlistIds", foundryType: "Playlist", contentField: "playlists" },
  { idField: "folderIds", foundryType: "Folder", contentField: "folders" },
  { idField: "combatIds", foundryType: "Combat", contentField: "combats" },
];

registerCommand(
  ADVENTURE_COMMANDS.EXPORT,
  async (input: AdventureExportInput): Promise<DocumentData> => {
    requireGM("export an adventure");
    const pack = requirePack(input.packId);

    const content: Record<string, Record<string, unknown>[]> = {};
    for (const mapping of CONTENT_FIELD_MAP) {
      const ids = input[mapping.idField];
      if (!ids || ids.length === 0) {
        continue;
      }
      const collection = game.collections.get(mapping.foundryType);
      if (!collection) {
        throw new Error(`No world collection for document type "${mapping.foundryType}"`);
      }
      content[mapping.contentField] = ids.map((id) => {
        const doc = collection.get(id);
        if (!doc) {
          throw new Error(`${mapping.foundryType} "${id}" not found`);
        }
        return doc.toObject();
      });
    }

    const data: Record<string, unknown> = {
      name: input.name,
      ...(input.img !== undefined ? { img: input.img } : {}),
      ...(input.caption !== undefined ? { caption: input.caption } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...content,
    };

    const created = await pack.documentClass.create(data, { pack: pack.metadata.id });
    if (!created) {
      throw new Error(`Failed to create adventure entry in pack "${input.packId}"`);
    }
    return created.toObject();
  },
);

registerCommand(
  ADVENTURE_COMMANDS.IMPORT,
  async ({ packId, entryId }: PackEntryIdInput): Promise<AdventureImportResult> => {
    requireGM("import an adventure");
    const pack = requirePack(packId);
    const entry = (await requirePackEntry(pack, entryId)) as FoundryAdventureDocument;
    return entry.import({ dialog: false });
  },
);
