// Phase 43 — World Time / Calendar command handlers. Registered against the
// same command dispatcher registry Phase 2 set up
// (module/src/command-registry.ts) and imported for side effects from
// module/src/index.ts.
//
// GM-only gating for advancing time lives here, not on the server — same
// convention as Phase 7's world-scope settings write and Phase 25's User
// CRUD (module/src/commands/settings.ts, users.ts): the server has no
// concept of which Foundry user issued a request beyond the single static
// API key (Phase 4), whereas the connected module always knows
// `game.user.isGM`.
import {
  WORLD_TIME_COMMANDS,
  type AdvanceWorldTimeInput,
  type WorldTimeResult,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";

function requireGM(action: string): void {
  if (!game.user.isGM) {
    throw new Error(`Only a GM may ${action}.`);
  }
}

registerCommand(WORLD_TIME_COMMANDS.GET, (): WorldTimeResult => ({
  worldTime: game.time.worldTime,
}));

registerCommand(
  WORLD_TIME_COMMANDS.ADVANCE,
  async ({ seconds }: AdvanceWorldTimeInput): Promise<WorldTimeResult> => {
    requireGM("advance the world time");
    const worldTime = await game.time.advance(seconds);
    return { worldTime };
  },
);
