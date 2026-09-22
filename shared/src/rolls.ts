// Phase 14 — Dice Rolling. Foundry's `Roll` class (the dice-rolling engine)
// only exists in the client renderer, not the standalone Node server, so
// formula evaluation is a single hand-rolled command run module-side. This
// isn't document CRUD — there's no persisted "Roll" document type — so it
// doesn't reuse the Phase 8 generic factory. Shared between the server's
// roll endpoint (server/src/endpoints/rolls.ts) and the module's roll
// command handler (module/src/commands/rolls.ts).

export const ROLL_COMMANDS = {
  EVALUATE: "rollEvaluate",
} as const;

export interface RollEvaluateInput {
  formula: string;
  /** Roll data to resolve formula references against (e.g. an actor's `getRollData()` output). */
  data?: Record<string, unknown> | undefined;
}

/** One die term's individual results, e.g. a `2d6` roll's two dice. */
export interface RollDieResult {
  faces: number;
  results: number[];
}

export interface RollEvaluateResult {
  formula: string;
  total: number;
  /** The resolved expression with each die replaced by its rolled value, e.g. "(4 + 2)". */
  result: string;
  dice: RollDieResult[];
}
