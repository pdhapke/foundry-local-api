// Phase 27 — Localization & Misc Utilities. Command names and payload/result
// shapes shared between the server's endpoints
// (server/src/endpoints/localization.ts) and the module's command handlers
// (module/src/commands/localization.ts).
//
// `localize`/`enrichHtml` wrap Foundry's `game.i18n` and `TextEditor`
// client-only APIs — the same "first ambient declaration of a client-only
// Foundry API" shape Phase 14's `Roll` and Phase 24's `FilePicker`
// established (see foundry-globals.d.ts's Phase 27 note). `search` is read
// narrowly per PLAN.md's own "if applicable" hedge: Foundry has no single
// stable, queryable "search everything" API (its sidebar quick-search uses
// `SearchFilter`, a UI-focused utility, not a clean API surface), so this
// implements a minimal name-substring search across `game.collections`
// using only the already-declared generic `FoundryDocument` surface
// (Phase 8) — no new ambient declaration needed for it.

export const LOCALIZATION_COMMANDS = {
  LOCALIZE: "localize",
  ENRICH_HTML: "enrichHtml",
  SEARCH: "search",
} as const;

export interface LocalizeInput {
  key: string;
  /** Interpolation data. When given, resolves via `game.i18n.format()`; when omitted, via `game.i18n.localize()`. */
  data?: Record<string, unknown> | undefined;
}

export interface LocalizeResult {
  key: string;
  text: string;
}

export interface EnrichHtmlInput {
  content: string;
}

export interface EnrichHtmlResult {
  html: string;
}

export interface SearchInput {
  query: string;
  /** Document type names to search (e.g. `["Actor", "Item"]`). Omit to search every collection. */
  types?: string[] | undefined;
}

export interface SearchMatch {
  documentType: string;
  id: string;
  name: string;
}

export interface SearchResult {
  matches: SearchMatch[];
}
