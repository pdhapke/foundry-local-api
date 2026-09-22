// Phase 18 — RollTables & Cards (Cards half). Command names and payload
// shapes for the three card-pile extras layered on top of the Phase 8
// generic document CRUD (Cards stack CRUD itself reuses DOCUMENT_COMMANDS
// with documentType: "Cards", identical to Scene/Actor/Item/Macro/Combat/
// Playlist), shared between the server's cards endpoints
// (server/src/endpoints/cards.ts) and the module's cards command handlers
// (module/src/commands/cards.ts).

export const CARDS_COMMANDS = {
  DRAW: "cardsDraw",
  SHUFFLE: "cardsShuffle",
  RESET: "cardsReset",
} as const;

export interface CardsDrawInput {
  /** The destination Cards stack's id (e.g. a player's hand). */
  id: string;
  /** The source Cards stack's id to draw from (e.g. a deck). */
  sourceId: string;
  /** How many cards to draw. Defaults to 1, matching Foundry's own `Cards#draw()`. */
  number?: number | undefined;
}

export interface CardsIdInput {
  id: string;
}
