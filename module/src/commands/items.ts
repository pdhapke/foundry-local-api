// Phase 10 — Items command handlers. Registered against the same command
// dispatcher registry Phase 2 set up (module/src/command-registry.ts) and
// imported for side effects from module/src/index.ts.
//
// World Item CRUD is NOT re-implemented here: it's already covered
// generically by Phase 8's documentList/Get/Create/Update/Delete commands
// with `documentType: "Item"` (see server/src/endpoints/items.ts, which
// calls the same `makeDocumentEndpoints()` factory JournalEntry/Actor use).
// This file only adds get/create/update/delete for a single embedded Item on
// an actor — the list side already exists as `ACTOR_COMMANDS.LIST_ITEMS`
// (Phase 9, module/src/commands/actors.ts).
import {
  EMBEDDED_ITEM_COMMANDS,
  type DocumentData,
  type DocumentDeleteResult,
  type EmbeddedItemCreateInput,
  type EmbeddedItemIdInput,
  type EmbeddedItemUpdateInput,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";

function requireActor(id: string): FoundryActor {
  const collection = game.collections.get("Actor") as Map<string, FoundryActor> | undefined;
  const actor = collection?.get(id);
  if (!actor) {
    throw new Error(`Actor "${id}" not found`);
  }
  return actor;
}

function requireEmbeddedItem(actor: FoundryActor, itemId: string): FoundryDocument {
  const item = actor.items.get(itemId);
  if (!item) {
    throw new Error(`Item "${itemId}" not found on actor "${actor.id}"`);
  }
  return item;
}

registerCommand(
  EMBEDDED_ITEM_COMMANDS.GET,
  ({ actorId, itemId }: EmbeddedItemIdInput): DocumentData =>
    requireEmbeddedItem(requireActor(actorId), itemId).toObject(),
);

registerCommand(
  EMBEDDED_ITEM_COMMANDS.CREATE,
  async ({ actorId, data }: EmbeddedItemCreateInput): Promise<DocumentData> => {
    const [created] = await requireActor(actorId).createEmbeddedDocuments("Item", [data]);
    if (!created) {
      throw new Error("Failed to create item");
    }
    return created.toObject();
  },
);

registerCommand(
  EMBEDDED_ITEM_COMMANDS.UPDATE,
  async ({ actorId, itemId, changes }: EmbeddedItemUpdateInput): Promise<DocumentData> => {
    const item = requireEmbeddedItem(requireActor(actorId), itemId);
    await item.update(changes);
    return item.toObject();
  },
);

registerCommand(
  EMBEDDED_ITEM_COMMANDS.DELETE,
  async ({ actorId, itemId }: EmbeddedItemIdInput): Promise<DocumentDeleteResult> => {
    const item = requireEmbeddedItem(requireActor(actorId), itemId);
    await item.delete();
    return { id: itemId };
  },
);
