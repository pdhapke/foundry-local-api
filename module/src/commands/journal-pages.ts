// Phase 13 — Journal Entries & Pages command handlers. Registered against
// the same command dispatcher registry Phase 2 set up
// (module/src/command-registry.ts) and imported for side effects from
// module/src/index.ts.
//
// JournalEntry CRUD is NOT re-implemented here: it's already covered
// generically by Phase 8's documentList/Get/Create/Update/Delete commands
// with `documentType: "JournalEntry"` (see server/src/endpoints/
// documents.ts, the factory's original proving-ground). This file only adds
// list/get/create/update/delete for embedded JournalEntryPage documents,
// mirroring the scene-embedded-token pattern Phase 12 established
// (module/src/commands/tokens.ts).
import {
  JOURNAL_PAGE_COMMANDS,
  type DocumentData,
  type DocumentDeleteResult,
  type JournalPageCreateInput,
  type JournalPageIdInput,
  type JournalPageListInput,
  type JournalPageUpdateInput,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";

function requireJournalEntry(id: string): FoundryJournalEntry {
  const collection = game.collections.get("JournalEntry") as
    | Map<string, FoundryJournalEntry>
    | undefined;
  const journalEntry = collection?.get(id);
  if (!journalEntry) {
    throw new Error(`JournalEntry "${id}" not found`);
  }
  return journalEntry;
}

function requirePage(journalEntry: FoundryJournalEntry, pageId: string): FoundryDocument {
  const page = journalEntry.pages.get(pageId);
  if (!page) {
    throw new Error(`JournalEntryPage "${pageId}" not found on journal entry "${journalEntry.id}"`);
  }
  return page;
}

registerCommand(
  JOURNAL_PAGE_COMMANDS.LIST,
  ({ journalEntryId }: JournalPageListInput): DocumentData[] =>
    Array.from(requireJournalEntry(journalEntryId).pages.values()).map((page) => page.toObject()),
);

registerCommand(
  JOURNAL_PAGE_COMMANDS.GET,
  ({ journalEntryId, pageId }: JournalPageIdInput): DocumentData =>
    requirePage(requireJournalEntry(journalEntryId), pageId).toObject(),
);

registerCommand(
  JOURNAL_PAGE_COMMANDS.CREATE,
  async ({ journalEntryId, data }: JournalPageCreateInput): Promise<DocumentData> => {
    const [created] = await requireJournalEntry(journalEntryId).createEmbeddedDocuments(
      "JournalEntryPage",
      [data],
    );
    if (!created) {
      throw new Error("Failed to create journal entry page");
    }
    return created.toObject();
  },
);

registerCommand(
  JOURNAL_PAGE_COMMANDS.UPDATE,
  async ({ journalEntryId, pageId, changes }: JournalPageUpdateInput): Promise<DocumentData> => {
    const page = requirePage(requireJournalEntry(journalEntryId), pageId);
    await page.update(changes);
    return page.toObject();
  },
);

registerCommand(
  JOURNAL_PAGE_COMMANDS.DELETE,
  async ({ journalEntryId, pageId }: JournalPageIdInput): Promise<DocumentDeleteResult> => {
    const page = requirePage(requireJournalEntry(journalEntryId), pageId);
    await page.delete();
    return { id: pageId };
  },
);
