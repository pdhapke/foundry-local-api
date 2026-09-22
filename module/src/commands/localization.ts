// Phase 27 — Localization & Misc Utilities command handlers. Registered
// against the same command dispatcher registry Phase 2 set up
// (module/src/command-registry.ts) and imported for side effects from
// module/src/index.ts.
//
// `localize`/`enrichHtml` are thin wrappers over `game.i18n`/`TextEditor`,
// both client-only Foundry APIs (see foundry-globals.d.ts's Phase 27 note).
// `search` resolves entirely off `game.collections`/`FoundryDocument`, both
// already declared by Phase 8 — no new ambient surface needed for it.
import {
  LOCALIZATION_COMMANDS,
  type EnrichHtmlInput,
  type EnrichHtmlResult,
  type LocalizeInput,
  type LocalizeResult,
  type SearchInput,
  type SearchMatch,
  type SearchResult,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";

registerCommand(LOCALIZATION_COMMANDS.LOCALIZE, ({ key, data }: LocalizeInput): LocalizeResult => ({
  key,
  text: data === undefined ? game.i18n.localize(key) : game.i18n.format(key, data),
}));

registerCommand(
  LOCALIZATION_COMMANDS.ENRICH_HTML,
  async ({ content }: EnrichHtmlInput): Promise<EnrichHtmlResult> => ({
    html: await TextEditor.enrichHTML(content),
  }),
);

registerCommand(LOCALIZATION_COMMANDS.SEARCH, ({ query, types }: SearchInput): SearchResult => {
  const lowerQuery = query.toLowerCase();
  const documentTypes = types ?? Array.from(game.collections.keys());
  const matches: SearchMatch[] = [];

  for (const documentType of documentTypes) {
    const collection = game.collections.get(documentType);
    if (!collection) {
      continue;
    }
    for (const doc of collection.values()) {
      const name = doc.toObject()["name"];
      if (typeof name === "string" && name.toLowerCase().includes(lowerQuery)) {
        matches.push({ documentType, id: doc.id, name });
      }
    }
  }

  return { matches };
});
