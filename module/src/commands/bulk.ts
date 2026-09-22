// Phase 28 — Bulk/Batch & Query Endpoints command handlers. Registered
// against the same command dispatcher registry Phase 2 set up
// (module/src/command-registry.ts) and imported for side effects from
// module/src/index.ts.
//
// Like Phase 8's five generic document commands, these four are registered
// ONCE and serve every Foundry document type: `documentType` travels in the
// payload and selects `game.collections.get(documentType)` /
// `CONFIG[documentType].documentClass`, reusing the exact same lookup/error
// helpers Phase 8 built (`requireCollection`/`requireDocumentClass`,
// re-exported from module/src/commands/documents.ts) rather than
// duplicating them here.
//
// Batch create/update/delete use Foundry's native static bulk methods
// (`createDocuments()`/`updateDocuments()`/`deleteDocuments()`, Phase 28's
// addition to `FoundryDocumentClass` — see foundry-globals.d.ts) instead of
// looping N individual `.create()`/`.update()`/`.delete()` calls. That's the
// actual point of this phase: one Foundry hook cycle and one bridge
// round-trip per batch, not N — the whole reason PLAN.md's Phase 28 exists
// ("cut round-trips for larger operations").
import {
  BULK_COMMANDS,
  type DocumentBatchCreateInput,
  type DocumentBatchDeleteInput,
  type DocumentBatchDeleteResult,
  type DocumentBatchUpdateInput,
  type DocumentData,
  type DocumentQueryInput,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";
import { requireCollection, requireDocumentClass } from "./documents.js";

registerCommand(
  BULK_COMMANDS.QUERY,
  ({ documentType, filter, limit }: DocumentQueryInput): DocumentData[] => {
    const docs = Array.from(requireCollection(documentType).values()).map((doc) => doc.toObject());
    const filtered = filter
      ? docs.filter((doc) => Object.entries(filter).every(([key, value]) => doc[key] === value))
      : docs;
    return typeof limit === "number" ? filtered.slice(0, limit) : filtered;
  },
);

registerCommand(
  BULK_COMMANDS.BATCH_CREATE,
  async ({ documentType, items }: DocumentBatchCreateInput): Promise<DocumentData[]> => {
    const created = await requireDocumentClass(documentType).createDocuments(items);
    return created.map((doc) => doc.toObject());
  },
);

registerCommand(
  BULK_COMMANDS.BATCH_UPDATE,
  async ({ documentType, updates }: DocumentBatchUpdateInput): Promise<DocumentData[]> => {
    const payload = updates.map(({ id, changes }) => ({ _id: id, ...changes }));
    const updated = await requireDocumentClass(documentType).updateDocuments(payload);
    return updated.map((doc) => doc.toObject());
  },
);

registerCommand(
  BULK_COMMANDS.BATCH_DELETE,
  async ({ documentType, ids }: DocumentBatchDeleteInput): Promise<DocumentBatchDeleteResult> => {
    const deletedIds = await requireDocumentClass(documentType).deleteDocuments(ids);
    return { ids: deletedIds };
  },
);
