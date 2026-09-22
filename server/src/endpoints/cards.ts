// Phase 18 — RollTables & Cards (Cards half).
//
// Base CRUD reuses the Phase 8 `makeDocumentEndpoints()` factory with
// `documentType: "Cards"`, same as JournalEntry/Actor/Item/Scene/Macro/
// Combat/Playlist/RollTable. The extras PLAN.md's Phase 18 calls for ("card
// pile operations") are hand-rolled here — draw (move cards from one stack
// into another), shuffle (randomize a stack in place), and reset (recall
// every card dealt out of this stack back into it) — see
// module/src/commands/cards.ts for the matching module-side handlers.
//
// Draw returns the drawn Card documents' own data (consistent with every
// embedded-create descriptor since Phase 10); shuffle/reset return the
// affected Cards stack's own `toObject()` (consistent with Phase 11's scene
// `activate` and Phase 16's combat turn/round descriptors), so a caller can
// see the new state without a follow-up `GET`.
import { z } from "zod";

import {
  CARDS_COMMANDS,
  type CardsDrawInput,
  type CardsIdInput,
  type DocumentData,
} from "@foundry-local-api/shared";

import { makeDocumentEndpoints } from "./documents.js";
import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";

const idSchema = z.object({ id: z.string().min(1) });
const drawSchema = idSchema.extend({
  sourceId: z.string().min(1),
  number: z.number().int().positive().optional(),
});

const drawDescriptor: EndpointDescriptor<CardsDrawInput, DocumentData[]> = {
  name: "foundry_draw_cards",
  description: "Draws one or more cards from a source Cards stack (e.g. a deck) into this one.",
  method: "post",
  path: "/cards/:id/draw",
  inputSchema: drawSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<CardsDrawInput, DocumentData[]>(CARDS_COMMANDS.DRAW, input),
};

const shuffleDescriptor: EndpointDescriptor<CardsIdInput, DocumentData> = {
  name: "foundry_shuffle_cards",
  description: "Shuffles a Cards stack in place, randomizing its cards' order.",
  method: "post",
  path: "/cards/:id/shuffle",
  inputSchema: idSchema,
  handler: ({ id }, { foundryClient }) =>
    foundryClient.call<CardsIdInput, DocumentData>(CARDS_COMMANDS.SHUFFLE, { id }),
};

const resetDescriptor: EndpointDescriptor<CardsIdInput, DocumentData> = {
  name: "foundry_reset_cards",
  description: "Resets a Cards stack, recalling every card dealt out of it back into this stack.",
  method: "post",
  path: "/cards/:id/reset",
  inputSchema: idSchema,
  handler: ({ id }, { foundryClient }) =>
    foundryClient.call<CardsIdInput, DocumentData>(CARDS_COMMANDS.RESET, { id }),
};

export const cardsEndpointDescriptors: AnyEndpointDescriptor[] = [
  ...makeDocumentEndpoints({
    documentType: "Cards",
    routeBase: "cards",
    toolSingular: "cards_stack",
    toolPlural: "cards_stacks",
  }),
  drawDescriptor,
  shuffleDescriptor,
  resetDescriptor,
];
