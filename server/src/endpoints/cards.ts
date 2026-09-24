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
//
// Phase 49 added pass (move specific cards to one other stack) and deal
// (distribute cards to multiple destination stacks in cyclical order) — the
// two card-pile operations this phase's original comment deliberately
// narrowed out. Pass returns the moved Card documents (same "return the
// created/moved child" convention as draw); deal returns the source stack's
// own `toObject()` (same convention as shuffle/reset), since the interesting
// state change for a multi-destination deal is what's left in the source.
import { z } from "zod";

import {
  CARDS_COMMANDS,
  type CardsDealInput,
  type CardsDrawInput,
  type CardsIdInput,
  type CardsPassInput,
  type DocumentData,
} from "@foundry-local-api/shared";

import { makeDocumentEndpoints } from "./documents.js";
import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";

const idSchema = z.object({ id: z.string().min(1) });
const drawSchema = idSchema.extend({
  sourceId: z.string().min(1),
  number: z.number().int().positive().optional(),
});
const passSchema = idSchema.extend({
  toId: z.string().min(1),
  cardIds: z.array(z.string().min(1)).min(1),
});
const dealSchema = idSchema.extend({
  toIds: z.array(z.string().min(1)).min(1),
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

const passDescriptor: EndpointDescriptor<CardsPassInput, DocumentData[]> = {
  name: "foundry_pass_cards",
  description: "Moves specific cards out of a Cards stack and into another one.",
  method: "post",
  path: "/cards/:id/pass",
  inputSchema: passSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<CardsPassInput, DocumentData[]>(CARDS_COMMANDS.PASS, input),
};

const dealDescriptor: EndpointDescriptor<CardsDealInput, DocumentData> = {
  name: "foundry_deal_cards",
  description:
    "Deals cards from a Cards stack to one or more destination stacks in cyclical order " +
    "(e.g. dealing a hand to each player).",
  method: "post",
  path: "/cards/:id/deal",
  inputSchema: dealSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<CardsDealInput, DocumentData>(CARDS_COMMANDS.DEAL, input),
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
  passDescriptor,
  dealDescriptor,
];
