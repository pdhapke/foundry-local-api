// World-wide pause/unpause — wraps Foundry's own `game.paused` getter and
// `Game#togglePause()`. Distinct from `shared/src/playlists.ts`'s
// `PAUSE_SOUND` command, which pauses a single embedded PlaylistSound, not
// the game itself (the "GAME PAUSED" banner shown to every connected
// client). Shared between the server's game-state endpoints
// (server/src/endpoints/game-state.ts) and the module's command handlers
// (module/src/commands/game-state.ts).

export const GAME_STATE_COMMANDS = {
  GET_PAUSED: "gameGetPaused",
  SET_PAUSED: "gameSetPaused",
} as const;

export interface GamePausedResult {
  paused: boolean;
}

export interface SetGamePausedInput {
  paused: boolean;
}
