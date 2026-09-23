// World-wide pause/unpause — wraps Foundry's own `game.paused`/
// `Game#togglePause()` (see shared/src/game-state.ts). Distinct from Phase
// 17's `foundry_pause_playlist_sound`, which pauses a single embedded
// PlaylistSound, not the game itself.
import { z } from "zod";
import {
  GAME_STATE_COMMANDS,
  type GamePausedResult,
  type SetGamePausedInput,
} from "@foundry-local-api/shared";

import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";

const setPausedSchema = z.object({ paused: z.boolean() });

const getPausedDescriptor: EndpointDescriptor<void, GamePausedResult> = {
  name: "foundry_get_game_paused",
  description:
    'Whether the game is currently paused (the "GAME PAUSED" banner) for every connected client.',
  method: "get",
  path: "/game/paused",
  handler: (_input, { foundryClient }) =>
    foundryClient.call<undefined, GamePausedResult>(GAME_STATE_COMMANDS.GET_PAUSED),
};

const setPausedDescriptor: EndpointDescriptor<SetGamePausedInput, GamePausedResult> = {
  name: "foundry_set_game_paused",
  description:
    'Pauses or unpauses the game for every connected client (the "GAME PAUSED" banner), ' +
    "broadcast from the connected GM user. Returns the resulting paused state.",
  method: "post",
  path: "/game/paused",
  inputSchema: setPausedSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<SetGamePausedInput, GamePausedResult>(GAME_STATE_COMMANDS.SET_PAUSED, input),
};

export const gameStateEndpointDescriptors: AnyEndpointDescriptor[] = [
  getPausedDescriptor,
  setPausedDescriptor,
];
