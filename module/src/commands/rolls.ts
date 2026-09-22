// Phase 14 — Dice Rolling command handler. Registered against the same
// command dispatcher registry Phase 2 set up (module/src/command-registry.ts)
// and imported for side effects from module/src/index.ts.
//
// Foundry's `Roll` class only exists in the client renderer, so evaluation
// happens entirely here — the server-side descriptor
// (server/src/endpoints/rolls.ts) is a thin pass-through to this one command.
import {
  ROLL_COMMANDS,
  type RollEvaluateInput,
  type RollEvaluateResult,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";

registerCommand(
  ROLL_COMMANDS.EVALUATE,
  async ({ formula, data }: RollEvaluateInput): Promise<RollEvaluateResult> => {
    const roll = new Roll(formula, data);
    await roll.evaluate();
    return {
      formula: roll.formula,
      total: roll.total,
      result: roll.result,
      dice: roll.dice.map((die) => ({
        faces: die.faces,
        results: die.results.map((r) => r.result),
      })),
    };
  },
);
