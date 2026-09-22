// Phase 10 — Items. Command names and payload/result shapes for embedded
// actor-item CRUD (world Item CRUD itself reuses DOCUMENT_COMMANDS with
// documentType: "Item", same as every other document type — no new commands
// needed for that part, see server/src/endpoints/items.ts). Shared between
// the server's item endpoints (server/src/endpoints/items.ts) and the
// module's embedded-item command handlers (module/src/commands/items.ts).
//
// An actor's embedded item *list* already exists as
// `ACTOR_COMMANDS.LIST_ITEMS` (Phase 9, shared/src/actors.ts) — this only
// adds get/create/update/delete for a single embedded item.

export const EMBEDDED_ITEM_COMMANDS = {
  GET: "actorGetItem",
  CREATE: "actorCreateItem",
  UPDATE: "actorUpdateItem",
  DELETE: "actorDeleteItem",
} as const;

export interface EmbeddedItemIdInput {
  actorId: string;
  itemId: string;
}

export interface EmbeddedItemCreateInput {
  actorId: string;
  data: Record<string, unknown>;
}

export interface EmbeddedItemUpdateInput {
  actorId: string;
  itemId: string;
  changes: Record<string, unknown>;
}
