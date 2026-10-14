// World-wide pause/unpause command handlers, wrapping Foundry's own
// `game.paused`/`Game#togglePause()` (see shared/src/game-state.ts).
// Registered against the same command dispatcher registry Phase 2 set up
// (module/src/command-registry.ts) and imported for side effects from
// module/src/index.ts.
import {
  GAME_STATE_COMMANDS,
  type GamePausedResult,
  type SetGamePausedInput,
  type ConfirmedPauseInput,
  type ConfirmedPauseResult,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";
import { inWorldMutationLane } from "../world-mutation-lane.js";

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

// Foundry's pause API is synchronous: invocation, hook observation and local
// canonical GM read-back form one ordered critical section without await gaps.
const pauseReceipts = new Map<string, { fingerprint: string; result: ConfirmedPauseResult }>();
export function setGamePausedConfirmed(input: ConfirmedPauseInput): ConfirmedPauseResult {
  const result = (
    outcome: ConfirmedPauseResult["outcome"],
    mutated: boolean,
    message?: string,
  ): ConfirmedPauseResult => ({
    outcome,
    mutated,
    stateObservedAtMs: Date.now(),
    paused: typeof game.paused === "boolean" ? game.paused : null,
    worldId: game.world.id,
    correlationId: input?.correlationId ?? "",
    ...(message ? { message } : {}),
  });
  if (
    !input ||
    typeof input.paused !== "boolean" ||
    input.origin !== "ai-dm" ||
    ![input.worldId, input.userId, input.requestId, input.correlationId].every(
      (v) => typeof v === "string" && v.length > 0 && v.length <= 128,
    )
  )
    return result("failure", false, "Invalid pause arguments");
  if (
    input.worldId !== game.world.id ||
    !game.user.isGM ||
    !game.user.active ||
    input.userId !== game.user.id ||
    !game.users.get(input.userId)?.isGM ||
    !game.users.get(input.userId)?.active
  )
    return result("failure", false, "Current authenticated GM/world authority required");
  const key = `${input.worldId}:${input.userId}:${input.requestId}`;
  const fingerprint = JSON.stringify(input);
  const previous = pauseReceipts.get(key);
  if (previous)
    return previous.fingerprint === fingerprint
      ? previous.result
      : result("failure", false, "Request ID reused with changed arguments");
  if (pauseReceipts.size >= 4096)
    return result("failure", false, "Pause receipt capacity reached; reload required");
  // Reserve before calling the mutator; a reentrant or ambiguous invocation
  // must never cause the same request to be dispatched again.
  const pending = result("uncertain", false, "Pause execution started; do not retry mutation");
  pauseReceipts.set(key, { fingerprint, result: pending });
  const scope = globalThis as typeof globalThis & { foundryLocalApiPauseOrigin?: unknown };
  const priorOrigin = scope.foundryLocalApiPauseOrigin;
  let mutated = false;
  let receipt: ConfirmedPauseResult;
  try {
    if (game.paused !== input.paused) {
      scope.foundryLocalApiPauseOrigin = { source: "ai-dm", ...input };
      mutated = true;
      game.togglePause(input.paused, { broadcast: true });
    }
    receipt =
      game.paused === input.paused
        ? result("confirmed", mutated)
        : result("uncertain", mutated, "Canonical GM pause read-back mismatch");
  } catch {
    receipt = result(
      "uncertain",
      mutated,
      "Pause execution did not acknowledge; do not retry mutation",
    );
  } finally {
    if (priorOrigin === undefined) delete scope.foundryLocalApiPauseOrigin;
    else scope.foundryLocalApiPauseOrigin = priorOrigin;
  }
  pauseReceipts.set(key, { fingerprint, result: receipt });
  console.info("[foundry-local-api] pause-result", receipt);
  return receipt;
}
registerCommand(GAME_STATE_COMMANDS.SET_PAUSED_CONFIRMED, (input: ConfirmedPauseInput) => inWorldMutationLane(game, () => setGamePausedConfirmed(input)));
