// Phase 18 — RollTables & Cards (RollTable half). Command name and payload/
// result shape for the one RollTable-specific extra layered on top of the
// Phase 8 generic document CRUD (RollTable CRUD itself reuses
// DOCUMENT_COMMANDS with documentType: "RollTable", identical to Scene/
// Actor/Item/Macro/Combat/Playlist), shared between the server's roll-table
// endpoints (server/src/endpoints/roll-tables.ts) and the module's
// roll-table command handlers (module/src/commands/roll-tables.ts).

export const ROLL_TABLE_COMMANDS = {
  DRAW: "rollTableDraw",
} as const;

export interface RollTableDrawInput {
  id: string;
  /** Whether to post the draw to chat, same default as Foundry's own `RollTable#draw()`. */
  displayChat?: boolean | undefined;
}

export interface RollTableDrawResult {
  roll: {
    formula: string;
    total: number;
  };
  /** The TableResult document(s) drawn, in draw order. */
  results: Record<string, unknown>[];
}
