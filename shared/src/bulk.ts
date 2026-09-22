// Phase 28 — Bulk/Batch & Query Endpoints command names and payload/result
// shapes, shared between the server's bulk endpoint descriptors
// (server/src/endpoints/bulk.ts) and the module's generic bulk command
// handlers (module/src/commands/bulk.ts).
//
// This is a separate file from documents.ts rather than a sixth/seventh/
// eighth/ninth addition to DOCUMENT_COMMANDS because these four commands
// aren't baked to one documentType via closure the way
// makeDocumentEndpoints()'s five per-type CRUD descriptors are (one call to
// that factory per document type, e.g. Actor/Item/Scene). Just like Phase 8's
// own five commands, `documentType` travels in every payload here, and there
// is a single shared set of REST routes/MCP tools that serve every document
// type generically — not one query/batch route per type.

import type { DocumentTypeInput } from "./documents.js";

export const BULK_COMMANDS = {
  QUERY: "documentQuery",
  BATCH_CREATE: "documentBatchCreate",
  BATCH_UPDATE: "documentBatchUpdate",
  BATCH_DELETE: "documentBatchDelete",
} as const;

/**
 * Filters documents of `documentType` by exact-match equality on top-level
 * fields of each document's `toObject()`. No nested-field paths, no
 * operators beyond equality, and no sort — deliberately as small as PLAN.md's
 * Phase 28 one-liner calls for.
 */
export interface DocumentQueryInput extends DocumentTypeInput {
  filter?: Record<string, unknown> | undefined;
  limit?: number | undefined;
}

export interface DocumentBatchCreateInput extends DocumentTypeInput {
  items: Record<string, unknown>[];
}

export interface DocumentBatchUpdateEntry {
  id: string;
  changes: Record<string, unknown>;
}

export interface DocumentBatchUpdateInput extends DocumentTypeInput {
  updates: DocumentBatchUpdateEntry[];
}

export interface DocumentBatchDeleteInput extends DocumentTypeInput {
  ids: string[];
}

/** The ids actually deleted, per Foundry's native `deleteDocuments()` return value. */
export interface DocumentBatchDeleteResult {
  ids: string[];
}
