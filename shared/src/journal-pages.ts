// Phase 13 — Journal Entries & Pages. JournalEntry CRUD itself was already
// proven in Phase 8 as the reference implementation for
// `makeDocumentEndpoints()` (documentType: "JournalEntry",
// server/src/endpoints/documents.ts) — this file only adds command names and
// payload/result shapes for embedded `JournalEntryPage` CRUD, following the
// same `<parent>Id`/`<child>Id`-shaped embedded pattern Phase 10 established
// for embedded items (shared/src/items.ts) and Phase 12 for embedded tokens
// (shared/src/tokens.ts). A JournalEntryPage only ever exists embedded on a
// JournalEntry (no top-level `game.collections` entry), so unlike items this
// needs its own LIST command too. Shared between the server's journal-page
// endpoints (server/src/endpoints/journal-pages.ts) and the module's
// embedded-page command handlers (module/src/commands/journal-pages.ts).

export const JOURNAL_PAGE_COMMANDS = {
  LIST: "journalEntryListPages",
  GET: "journalEntryGetPage",
  CREATE: "journalEntryCreatePage",
  UPDATE: "journalEntryUpdatePage",
  DELETE: "journalEntryDeletePage",
} as const;

export interface JournalPageListInput {
  journalEntryId: string;
}

export interface JournalPageIdInput {
  journalEntryId: string;
  pageId: string;
}

export interface JournalPageCreateInput {
  journalEntryId: string;
  data: Record<string, unknown>;
}

export interface JournalPageUpdateInput {
  journalEntryId: string;
  pageId: string;
  changes: Record<string, unknown>;
}
