// Phase 18 — RollTables & Cards (RollTable half).
//
// Base CRUD reuses the Phase 8 `makeDocumentEndpoints()` factory with
// `documentType: "RollTable"`, same as JournalEntry/Actor/Item/Scene/Macro/
// Combat/Playlist. The one extra PLAN.md's Phase 18 calls for
// ("draw-from-table") is hand-rolled here — see
// module/src/commands/roll-tables.ts for the matching module-side handler.
import { z } from "zod";

import {
  ROLL_TABLE_COMMANDS,
  type RollTableDrawInput,
  type RollTableDrawResult,
} from "@foundry-local-api/shared";

import { makeDocumentEndpoints } from "./documents.js";
import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";

const drawSchema = z.object({
  id: z.string().min(1),
  displayChat: z.boolean().optional(),
});

const drawDescriptor: EndpointDescriptor<RollTableDrawInput, RollTableDrawResult> = {
  name: "foundry_draw_roll_table",
  description:
    "Draws one result from a RollTable by id, evaluating the table's roll formula and returning " +
    "the drawn TableResult(s). Posts to chat by default, same as Foundry's own table draw.",
  method: "post",
  path: "/roll-tables/:id/draw",
  inputSchema: drawSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<RollTableDrawInput, RollTableDrawResult>(ROLL_TABLE_COMMANDS.DRAW, input),
};

export const rollTableEndpointDescriptors: AnyEndpointDescriptor[] = [
  ...makeDocumentEndpoints({
    documentType: "RollTable",
    routeBase: "roll-tables",
    toolSingular: "roll_table",
    toolPlural: "roll_tables",
  }),
  drawDescriptor,
];
