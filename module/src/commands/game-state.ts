// World-wide pause/unpause command handlers, wrapping Foundry's own
// `game.paused`/`Game#togglePause()` (see shared/src/game-state.ts).
// Registered against the same command dispatcher registry Phase 2 set up
// (module/src/command-registry.ts) and imported for side effects from
// module/src/index.ts.
import {
  GAME_STATE_COMMANDS,
  type GamePausedResult,
  type SetGamePausedInput,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";

registerCommand(GAME_STATE_COMMANDS.GET_PAUSED, (): GamePausedResult => ({
  paused: game.paused,
}));

registerCommand(
  GAME_STATE_COMMANDS.SET_PAUSED,
  ({ paused }: SetGamePausedInput): GamePausedResult => ({
    // `broadcast: true` pushes the new state to every other connected
    // client — the same behavior as toggling it from the in-client UI —
    // and requires a GM user, which the bridge always connects as.
    paused: game.togglePause(paused, { broadcast: true }),
  }),
);
