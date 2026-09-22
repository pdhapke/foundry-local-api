// Phase 20 — Compendium Packs command handlers. Registered against the same
// command dispatcher registry Phase 2 set up (module/src/command-registry.ts)
// and imported for side effects from module/src/index.ts.
//
// A compendium pack has no `game.collections` entry of its own — packs live
// on their own top-level `game.packs` collection, keyed by pack id. Once a
// pack entry is loaded via `pack.getDocument()`, it's a regular
// `FoundryDocument`: its own `.update()`/`.delete()` already route back to
// the pack it came from (the same finding Phase 10 made for embedded
// documents routing through their parent), so no special "pack" option is
// needed there. Creating a new entry does need one, since there's no
// existing document instance to route through yet:
// `pack.documentClass.create(data, { pack: pack.metadata.id })`.
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

import { registerCommand } from "../command-registry.js";

function requirePack(packId: string): FoundryCompendiumCollection {
  const pack = game.packs.get(packId);
  if (!pack) {
    throw new Error(`Compendium pack "${packId}" not found`);
  }
  return pack;
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

registerCommand(PACK_COMMANDS.LIST, (): PackInfo[] =>
  Array.from(game.packs.values()).map((pack) => ({
    id: pack.metadata.id,
    label: pack.metadata.label,
    type: pack.metadata.type,
    package: pack.metadata.package,
    packageType: pack.metadata.packageType,
    ...(pack.metadata.system !== undefined ? { system: pack.metadata.system } : {}),
    path: pack.metadata.path,
  })),
);

registerCommand(
  PACK_COMMANDS.GET_INDEX,
  async ({ packId }: PackIdInput): Promise<PackIndexEntry[]> =>
    Array.from((await requirePack(packId).getIndex()).values()),
);

registerCommand(
  PACK_COMMANDS.GET_ENTRY,
  async ({ packId, entryId }: PackEntryIdInput): Promise<DocumentData> =>
    (await requirePackEntry(requirePack(packId), entryId)).toObject(),
);

registerCommand(
  PACK_COMMANDS.CREATE_ENTRY,
  async ({ packId, data }: PackCreateEntryInput): Promise<DocumentData> => {
    const pack = requirePack(packId);
    const created = await pack.documentClass.create(data, { pack: pack.metadata.id });
    if (!created) {
      throw new Error(`Failed to create entry in pack "${packId}"`);
    }
    return created.toObject();
  },
);

registerCommand(
  PACK_COMMANDS.UPDATE_ENTRY,
  async ({ packId, entryId, changes }: PackUpdateEntryInput): Promise<DocumentData> => {
    const entry = await requirePackEntry(requirePack(packId), entryId);
    await entry.update(changes);
    return entry.toObject();
  },
);

registerCommand(
  PACK_COMMANDS.DELETE_ENTRY,
  async ({ packId, entryId }: PackEntryIdInput): Promise<DocumentDeleteResult> => {
    const entry = await requirePackEntry(requirePack(packId), entryId);
    await entry.delete();
    return { id: entryId };
  },
);

registerCommand(
  PACK_COMMANDS.IMPORT_ENTRY,
  async ({ packId, entryId }: PackEntryIdInput): Promise<DocumentData> => {
    const pack = requirePack(packId);
    const worldCollection = game.collections.get(pack.metadata.type);
    if (!worldCollection) {
      throw new Error(`No world collection for document type "${pack.metadata.type}"`);
    }
    const imported = await worldCollection.importFromCompendium(pack, entryId);
    return imported.toObject();
  },
);
