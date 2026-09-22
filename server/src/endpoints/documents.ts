// Phase 8 — Generic Document CRUD Core.
//
// `makeDocumentEndpoints()` is the route-factory + tool-factory PLAN.md's
// Phase 8 calls for: given a Foundry document type name plus the REST/MCP
// naming to use for it, it returns five descriptors (list/get/create/update/
// delete) that all call the same five generic module-side commands (see
// shared/src/documents.ts and module/src/commands/documents.ts) with
// `documentType` baked in via closure. Proven first against `JournalEntry`,
// the simplest document type (no embedded collections) — later phases
// (Actors, Items, Scenes, ...) call this same factory with their own type
// name and naming, then layer any type-specific extras on top.
import { z } from "zod";

import {
  DOCUMENT_COMMANDS,
  type DocumentCreateInput,
  type DocumentData,
  type DocumentDeleteResult,
  type DocumentIdInput,
  type DocumentTypeInput,
  type DocumentUpdateInput,
} from "@foundry-local-api/shared";

import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";

export interface DocumentEndpointConfig {
  /** Foundry's own document type name, e.g. "JournalEntry" — matches `game.collections`/`CONFIG` keys. */
  documentType: string;
  /** REST path segment for the collection, e.g. "journal-entries" (mounted under `/api`). */
  routeBase: string;
  /** snake_case singular used in per-document MCP tool names, e.g. "journal_entry". */
  toolSingular: string;
  /** snake_case plural used in the list MCP tool name, e.g. "journal_entries". */
  toolPlural: string;
}

const documentDataSchema = z.record(z.string(), z.unknown());
const idSchema = z.object({ id: z.string().min(1) });
const createSchema = z.object({ data: documentDataSchema });
const updateSchema = idSchema.extend({ changes: documentDataSchema });

/**
 * Builds the five generic CRUD descriptors for one Foundry document type.
 * REST: `GET/POST /<routeBase>`, `GET/PUT/DELETE /<routeBase>/:id`.
 */
export function makeDocumentEndpoints(config: DocumentEndpointConfig): AnyEndpointDescriptor[] {
  const { documentType, routeBase, toolSingular, toolPlural } = config;

  const listDescriptor: EndpointDescriptor<void, DocumentData[]> = {
    name: `foundry_list_${toolPlural}`,
    description: `Lists every ${documentType} document in the current world.`,
    method: "get",
    path: `/${routeBase}`,
    handler: (_input, { foundryClient }) =>
      foundryClient.call<DocumentTypeInput, DocumentData[]>(DOCUMENT_COMMANDS.LIST, {
        documentType,
      }),
  };

  const getDescriptor: EndpointDescriptor<{ id: string }, DocumentData> = {
    name: `foundry_get_${toolSingular}`,
    description: `Reads a single ${documentType} document by id.`,
    method: "get",
    path: `/${routeBase}/:id`,
    inputSchema: idSchema,
    handler: ({ id }, { foundryClient }) =>
      foundryClient.call<DocumentIdInput, DocumentData>(DOCUMENT_COMMANDS.GET, {
        documentType,
        id,
      }),
  };

  const createDescriptor: EndpointDescriptor<{ data: Record<string, unknown> }, DocumentData> = {
    name: `foundry_create_${toolSingular}`,
    description: `Creates a new ${documentType} document.`,
    method: "post",
    path: `/${routeBase}`,
    inputSchema: createSchema,
    handler: ({ data }, { foundryClient }) =>
      foundryClient.call<DocumentCreateInput, DocumentData>(DOCUMENT_COMMANDS.CREATE, {
        documentType,
        data,
      }),
  };

  const updateDescriptor: EndpointDescriptor<
    { id: string; changes: Record<string, unknown> },
    DocumentData
  > = {
    name: `foundry_update_${toolSingular}`,
    description: `Updates fields on an existing ${documentType} document.`,
    method: "put",
    path: `/${routeBase}/:id`,
    inputSchema: updateSchema,
    handler: ({ id, changes }, { foundryClient }) =>
      foundryClient.call<DocumentUpdateInput, DocumentData>(DOCUMENT_COMMANDS.UPDATE, {
        documentType,
        id,
        changes,
      }),
  };

  const deleteDescriptor: EndpointDescriptor<{ id: string }, DocumentDeleteResult> = {
    name: `foundry_delete_${toolSingular}`,
    description: `Deletes a ${documentType} document by id.`,
    method: "delete",
    path: `/${routeBase}/:id`,
    inputSchema: idSchema,
    handler: ({ id }, { foundryClient }) =>
      foundryClient.call<DocumentIdInput, DocumentDeleteResult>(DOCUMENT_COMMANDS.DELETE, {
        documentType,
        id,
      }),
  };

  return [listDescriptor, getDescriptor, createDescriptor, updateDescriptor, deleteDescriptor];
}

export const journalEntryEndpointDescriptors: AnyEndpointDescriptor[] = makeDocumentEndpoints({
  documentType: "JournalEntry",
  routeBase: "journal-entries",
  toolSingular: "journal_entry",
  toolPlural: "journal_entries",
});
