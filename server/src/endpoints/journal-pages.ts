// Phase 13 — Journal Entries & Pages.
//
// JournalEntry CRUD reuses the Phase 8 `makeDocumentEndpoints()` factory with
// `documentType: "JournalEntry"` — it's actually already registered
// (`journalEntryEndpointDescriptors`, server/src/endpoints/documents.ts),
// since Phase 8 proved that factory against JournalEntry first. The five
// descriptors below are the new part this phase adds: embedded
// `JournalEntryPage` CRUD under
// `/api/journal-entries/:journalEntryId/pages[/:pageId]`, hand-rolled like
// Phase 12's embedded tokens since a page has no top-level
// `game.collections` entry of its own. See
// module/src/commands/journal-pages.ts for the matching module-side
// handlers.
import { z } from "zod";

import {
  JOURNAL_PAGE_COMMANDS,
  type DocumentData,
  type DocumentDeleteResult,
  type JournalPageCreateInput,
  type JournalPageIdInput,
  type JournalPageListInput,
  type JournalPageUpdateInput,
} from "@foundry-local-api/shared";

import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";

const documentDataSchema = z.record(z.string(), z.unknown());
const journalEntryIdSchema = z.object({ journalEntryId: z.string().min(1) });
const pageIdSchema = z.object({
  journalEntryId: z.string().min(1),
  pageId: z.string().min(1),
});
const createSchema = z.object({ journalEntryId: z.string().min(1), data: documentDataSchema });
const updateSchema = pageIdSchema.extend({ changes: documentDataSchema });

const listPagesDescriptor: EndpointDescriptor<JournalPageListInput, DocumentData[]> = {
  name: "foundry_list_journal_entry_pages",
  description: "Lists a JournalEntry's embedded JournalEntryPage documents.",
  method: "get",
  path: "/journal-entries/:journalEntryId/pages",
  inputSchema: journalEntryIdSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<JournalPageListInput, DocumentData[]>(JOURNAL_PAGE_COMMANDS.LIST, input),
};

const getPageDescriptor: EndpointDescriptor<JournalPageIdInput, DocumentData> = {
  name: "foundry_get_journal_entry_page",
  description: "Reads a single embedded JournalEntryPage document by id.",
  method: "get",
  path: "/journal-entries/:journalEntryId/pages/:pageId",
  inputSchema: pageIdSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<JournalPageIdInput, DocumentData>(JOURNAL_PAGE_COMMANDS.GET, input),
};

const createPageDescriptor: EndpointDescriptor<JournalPageCreateInput, DocumentData> = {
  name: "foundry_create_journal_entry_page",
  description: "Creates a new embedded JournalEntryPage document on a JournalEntry.",
  method: "post",
  path: "/journal-entries/:journalEntryId/pages",
  inputSchema: createSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<JournalPageCreateInput, DocumentData>(JOURNAL_PAGE_COMMANDS.CREATE, input),
};

const updatePageDescriptor: EndpointDescriptor<JournalPageUpdateInput, DocumentData> = {
  name: "foundry_update_journal_entry_page",
  description: "Updates fields on an existing embedded JournalEntryPage document.",
  method: "put",
  path: "/journal-entries/:journalEntryId/pages/:pageId",
  inputSchema: updateSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<JournalPageUpdateInput, DocumentData>(JOURNAL_PAGE_COMMANDS.UPDATE, input),
};

const deletePageDescriptor: EndpointDescriptor<JournalPageIdInput, DocumentDeleteResult> = {
  name: "foundry_delete_journal_entry_page",
  description: "Deletes an embedded JournalEntryPage document from a JournalEntry by id.",
  method: "delete",
  path: "/journal-entries/:journalEntryId/pages/:pageId",
  inputSchema: pageIdSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<JournalPageIdInput, DocumentDeleteResult>(
      JOURNAL_PAGE_COMMANDS.DELETE,
      input,
    ),
};

export const journalPageEndpointDescriptors: AnyEndpointDescriptor[] = [
  listPagesDescriptor,
  getPageDescriptor,
  createPageDescriptor,
  updatePageDescriptor,
  deletePageDescriptor,
];
