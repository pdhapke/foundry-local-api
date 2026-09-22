// Phase 28 — Bulk/Batch & Query Endpoints.
//
// A generic filtered-query endpoint across document collections, plus batch
// create/update/delete, to cut round-trips for larger operations (PLAN.md's
// Phase 28 one-liner). Unlike the per-type routes `makeDocumentEndpoints()`
// (documents.ts) generates once per document type, these four descriptors
// are mounted once and take `documentType` in the request body, exactly
// mirroring Phase 8's own generic command shape — see shared/src/bulk.ts and
// module/src/commands/bulk.ts.
//
// Query filtering is exact-match equality on a document's top-level
// `toObject()` fields only — no nested paths, no operators, no sort — kept
// deliberately as small as the rest of this codebase's phases.
import { z } from "zod";

import {
  BULK_COMMANDS,
  type DocumentBatchCreateInput,
  type DocumentBatchDeleteInput,
  type DocumentBatchDeleteResult,
  type DocumentBatchUpdateInput,
  type DocumentData,
  type DocumentQueryInput,
} from "@foundry-local-api/shared";

import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";

const querySchema = z.object({
  documentType: z.string().min(1),
  filter: z.record(z.string(), z.unknown()).optional(),
  limit: z.number().int().positive().optional(),
});

const batchCreateSchema = z.object({
  documentType: z.string().min(1),
  items: z.array(z.record(z.string(), z.unknown())).min(1),
});

const batchUpdateSchema = z.object({
  documentType: z.string().min(1),
  updates: z
    .array(
      z.object({
        id: z.string().min(1),
        changes: z.record(z.string(), z.unknown()),
      }),
    )
    .min(1),
});

const batchDeleteSchema = z.object({
  documentType: z.string().min(1),
  ids: z.array(z.string().min(1)).min(1),
});

const queryDescriptor: EndpointDescriptor<DocumentQueryInput, DocumentData[]> = {
  name: "foundry_query_documents",
  description:
    "Lists documents of the given type, filtered by exact-match equality on top-level fields " +
    "(e.g. {\"name\": \"Goblin\"}), optionally capped to `limit` results.",
  method: "post",
  path: "/documents/query",
  inputSchema: querySchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<DocumentQueryInput, DocumentData[]>(BULK_COMMANDS.QUERY, input),
};

const batchCreateDescriptor: EndpointDescriptor<DocumentBatchCreateInput, DocumentData[]> = {
  name: "foundry_batch_create_documents",
  description: "Creates many documents of the given type in one call.",
  method: "post",
  path: "/documents/batch-create",
  inputSchema: batchCreateSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<DocumentBatchCreateInput, DocumentData[]>(BULK_COMMANDS.BATCH_CREATE, input),
};

const batchUpdateDescriptor: EndpointDescriptor<DocumentBatchUpdateInput, DocumentData[]> = {
  name: "foundry_batch_update_documents",
  description: "Updates many documents of the given type in one call, each identified by its own id.",
  method: "post",
  path: "/documents/batch-update",
  inputSchema: batchUpdateSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<DocumentBatchUpdateInput, DocumentData[]>(BULK_COMMANDS.BATCH_UPDATE, input),
};

const batchDeleteDescriptor: EndpointDescriptor<DocumentBatchDeleteInput, DocumentBatchDeleteResult> = {
  name: "foundry_batch_delete_documents",
  description:
    "Permanently deletes every document of the given type whose id is listed. This cannot be " +
    "undone — use with care.",
  method: "post",
  path: "/documents/batch-delete",
  inputSchema: batchDeleteSchema,
  annotations: {
    title: "Batch Delete Documents (permanently deletes multiple documents)",
    destructiveHint: true,
  },
  handler: (input, { foundryClient }) =>
    foundryClient.call<DocumentBatchDeleteInput, DocumentBatchDeleteResult>(
      BULK_COMMANDS.BATCH_DELETE,
      input,
    ),
};

export const bulkEndpointDescriptors: AnyEndpointDescriptor[] = [
  queryDescriptor,
  batchCreateDescriptor,
  batchUpdateDescriptor,
  batchDeleteDescriptor,
];
