// Phase 18 — RollTables & Cards (Cards half) command handlers. Registered
// against the same command dispatcher registry Phase 2 set up
// (module/src/command-registry.ts) and imported for side effects from
// module/src/index.ts.
//
// Cards stack CRUD itself is NOT re-implemented here: it's already covered
// generically by Phase 8's documentList/Get/Create/Update/Delete commands
// with `documentType: "Cards"` (see server/src/endpoints/cards.ts, which
// calls the same `makeDocumentEndpoints()` factory JournalEntry/Actor/Item/
// Scene/Macro/Combat/Playlist/RollTable use). This file only adds the
// card-pile extras PLAN.md's Phase 18 calls for: draw, shuffle, reset.
import {
  CARDS_COMMANDS,
  type CardsDrawInput,
  type CardsIdInput,
  type DocumentData,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";

function requireCardsStack(id: string): FoundryCardsStack {
  const collection = game.collections.get("Cards") as Map<string, FoundryCardsStack> | undefined;
  const stack = collection?.get(id);
  if (!stack) {
    throw new Error(`Cards stack "${id}" not found`);
  }
  return stack;
}

registerCommand(
  CARDS_COMMANDS.DRAW,
  async ({ id, sourceId, number }: CardsDrawInput): Promise<DocumentData[]> => {
    const target = requireCardsStack(id);
    const source = requireCardsStack(sourceId);
    const drawn = await target.draw(source, number ?? 1);
    return drawn.map((card) => card.toObject());
  },
);

registerCommand(CARDS_COMMANDS.SHUFFLE, async ({ id }: CardsIdInput): Promise<DocumentData> => {
  const stack = requireCardsStack(id);
  await stack.shuffle();
  return stack.toObject();
});

registerCommand(CARDS_COMMANDS.RESET, async ({ id }: CardsIdInput): Promise<DocumentData> => {
  const stack = requireCardsStack(id);
  await stack.reset();
  return stack.toObject();
});
