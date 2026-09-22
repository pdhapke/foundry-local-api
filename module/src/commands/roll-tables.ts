// Phase 18 — RollTables & Cards (RollTable half) command handler. Registered
// against the same command dispatcher registry Phase 2 set up
// (module/src/command-registry.ts) and imported for side effects from
// module/src/index.ts.
//
// RollTable CRUD itself is NOT re-implemented here: it's already covered
// generically by Phase 8's documentList/Get/Create/Update/Delete commands
// with `documentType: "RollTable"` (see server/src/endpoints/roll-tables.ts,
// which calls the same `makeDocumentEndpoints()` factory JournalEntry/Actor/
// Item/Scene/Macro/Combat/Playlist use). This file only adds the one
// RollTable-specific extra PLAN.md's Phase 18 calls for: drawing a result.
import {
  ROLL_TABLE_COMMANDS,
  type RollTableDrawInput,
  type RollTableDrawResult,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";

function requireRollTable(id: string): FoundryRollTable {
  const collection = game.collections.get("RollTable") as Map<string, FoundryRollTable> | undefined;
  const table = collection?.get(id);
  if (!table) {
    throw new Error(`RollTable "${id}" not found`);
  }
  return table;
}

registerCommand(
  ROLL_TABLE_COMMANDS.DRAW,
  async ({ id, displayChat }: RollTableDrawInput): Promise<RollTableDrawResult> => {
    const table = requireRollTable(id);
    const draw = await table.draw(displayChat === undefined ? {} : { displayChat });
    return {
      roll: { formula: draw.roll.formula, total: draw.roll.total },
      results: draw.results.map((result) => result.toObject()),
    };
  },
);
