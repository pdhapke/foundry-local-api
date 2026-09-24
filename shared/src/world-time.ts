// Phase 43 — World Time / Calendar. `game.time.worldTime` (and advancing it)
// was untouched by every earlier phase, despite being relevant to rest
// mechanics and any calendar-aware system. Command names and payload/result
// shapes shared between the server's world-time endpoints
// (server/src/endpoints/world-time.ts) and the module's command handlers
// (module/src/commands/world-time.ts).
//
// Deliberately scoped to just `worldTime`/`advance()` — the flat in-game-
// seconds counter every Foundry core version exposes — not a richer
// calendar API. No connected-world check turned up a distinct calendar
// surface beyond this; if a later Foundry version adds one, it's a
// follow-up phase, not a widening of this one.

export const WORLD_TIME_COMMANDS = {
  GET: "worldTimeGet",
  ADVANCE: "worldTimeAdvance",
} as const;

export interface WorldTimeResult {
  /** Seconds elapsed in the game world (`game.time.worldTime`). */
  worldTime: number;
}

export interface AdvanceWorldTimeInput {
  /** Seconds to advance the world time by; negative rewinds it. */
  seconds: number;
}
