// Phase 15 — Macros command handler. Registered against the same command
// dispatcher registry Phase 2 set up (module/src/command-registry.ts) and
// imported for side effects from module/src/index.ts.
//
// Macro CRUD itself is NOT re-implemented here: it's already covered
// generically by Phase 8's documentList/Get/Create/Update/Delete commands
// with `documentType: "Macro"` (see server/src/endpoints/macros.ts, which
// calls the same `makeDocumentEndpoints()` factory JournalEntry/Actor/Item/
// Scene use). This file only adds the one macro-specific extra PLAN.md's
// Phase 15 calls for: execution.
import {
  MACRO_COMMANDS,
  type MacroExecuteResult,
  type MacroIdInput,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";

function requireMacro(id: string): FoundryMacro {
  const collection = game.collections.get("Macro") as Map<string, FoundryMacro> | undefined;
  const macro = collection?.get(id);
  if (!macro) {
    throw new Error(`Macro "${id}" not found`);
  }
  return macro;
}

registerCommand(
  MACRO_COMMANDS.EXECUTE,
  async ({ id }: MacroIdInput): Promise<MacroExecuteResult> => {
    const macro = requireMacro(id);
    await macro.execute();
    return { id, executed: true };
  },
);
