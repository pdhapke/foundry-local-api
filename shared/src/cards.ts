// Phase 18 — RollTables & Cards (Cards half). Command names and payload
// shapes for the three card-pile extras layered on top of the Phase 8
// generic document CRUD (Cards stack CRUD itself reuses DOCUMENT_COMMANDS
// with documentType: "Cards", identical to Scene/Actor/Item/Macro/Combat/
// Playlist), shared between the server's cards endpoints
// (server/src/endpoints/cards.ts) and the module's cards command handlers
// (module/src/commands/cards.ts).
//
// Phase 49 added pass (move specific cards from this stack to another) and
// deal (distribute cards from this stack to multiple destination stacks in
// cyclical order) — the two card-pile operations the Phase 18 backlog note
// narrowed out ("moving cards between two other stacks, or one stack to
// many"). Both wrap Foundry's own `Cards#pass()`/`Cards#deal()`.

export const CARDS_COMMANDS = {
  DRAW: "cardsDraw",
  SHUFFLE: "cardsShuffle",
  RESET: "cardsReset",
  PASS: "cardsPass",
  DEAL: "cardsDeal",
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

export interface CardsPassInput {
  /** The source Cards stack's id (cards move out of this stack). */
  id: string;
  /** The destination Cards stack's id (cards move into this stack). */
  toId: string;
  /** Ids of the specific Card documents (embedded in the source stack) to move. */
  cardIds: string[];
}

export interface CardsDealInput {
  /** The source Cards stack's id (cards move out of this stack). */
  id: string;
  /** Ids of the destination Cards stacks, dealt to in cyclical order. */
  toIds: string[];
  /** How many cards to deal to each destination. Defaults to 1, matching Foundry's own `Cards#deal()`. */
  number?: number | undefined;
}
