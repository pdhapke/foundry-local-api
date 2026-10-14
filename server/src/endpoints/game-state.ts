import {
  enqueueRoutineMutation,
  markRoutineUncertain,
  isRoutineUncertain,
} from "./routine-mutation-lane.js";
// World-wide pause/unpause — wraps Foundry's own `game.paused`/
// `Game#togglePause()` (see shared/src/game-state.ts). Distinct from Phase
// 17's `foundry_pause_playlist_sound`, which pauses a single embedded
// PlaylistSound, not the game itself.
import { z } from "zod";
import {
  GAME_STATE_COMMANDS,
  type GamePausedResult,
  type SetGamePausedInput,
  type ConfirmedPauseInput,
  type ConfirmedPauseResult,
} from "@foundry-local-api/shared";

import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";

const setPausedSchema = z.object({ paused: z.boolean() });
const boundedId = z.string().min(1).max(128);
const confirmedPauseSchema = z
  .object({
    paused: z.boolean(),
    worldId: boundedId,
    userId: boundedId,
    requestId: boundedId,
    correlationId: boundedId,
    origin: z.literal("ai-dm"),
  })
  .strict();
const pauseLanes = new WeakMap<
  object,
  {
    tail: Promise<unknown>;
    uncertain?: boolean;
    receipts: Map<
      string,
      { fingerprint: string; connection: string; result: Promise<ConfirmedPauseResult> }
    >;
  }
>();
const confirmedPauseDescriptor: EndpointDescriptor<ConfirmedPauseInput, ConfirmedPauseResult> = {
  name: "foundry_set_game_paused_confirmed",
  description:
    "Set explicit world pause state for the exact authenticated live GM. Serialized, deduplicated and read back on the canonical GM; uncertain results must not be retried. Confirmation covers canonical GM state and broadcast dispatch, not receipt by every client.",
  method: "post",
  path: "/game/paused/confirmed",
  inputSchema: confirmedPauseSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  handler: (input, { foundryClient }) => {
    let lane = pauseLanes.get(foundryClient);
    if (!lane) {
      lane = { tail: Promise.resolve(), receipts: new Map() };
      pauseLanes.set(foundryClient, lane);
    }
    const key = `${input.worldId}:${input.userId}:${input.requestId}`;
    const fingerprint = JSON.stringify(input);
    const fail = (message: string): ConfirmedPauseResult => ({
      outcome: "failure",
      paused: null,
      worldId: input.worldId,
      correlationId: input.correlationId,
      mutated: false,
      message,
    });
    const previous = lane.receipts.get(key);
    const currentClient = foundryClient
      .getCapabilityReport()
      .clients.find((c) => c.userId === input.userId && c.lane === "gm" && c.optedIn && c.isGM);
    if (!currentClient) return fail("Exact authenticated GM bridge is not connected");
    const connection = `${currentClient.clientId}:${currentClient.connectedAt}`;
    if (previous && previous.connection !== connection)
      return fail(
        "Historical pause receipt belongs to a previous GM connection; inspect current world state",
      );
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        return fail("Request ID reused with changed arguments");
      // Replaying a receipt never re-dispatches the mutation. Read live identity
      // through the exact authenticated bridge before exposing historical state.
      return foundryClient
        .call<undefined, { worldId: string; userId: string }>("status", undefined, {
          clientId: currentClient.clientId,
          userId: input.userId,
          lane: "gm",
        })
        .then(async (identity) => {
          if (identity.worldId !== input.worldId || identity.userId !== input.userId)
            return fail("Historical receipt does not match current GM/world");
          const user = await foundryClient.call<undefined, { isGM: boolean; active: boolean }>(
            "user",
            undefined,
            { clientId: currentClient.clientId, userId: input.userId, lane: "gm" },
          );
          return user.isGM && user.active ? previous.result : fail("Current GM authority required");
        })
        .catch(() => fail("Current GM/world authority cannot be verified for receipt replay"));
    }
    if (lane.receipts.size >= 4096) return fail("Pause receipt capacity reached; restart required");
    const operation = enqueueRoutineMutation(
      foundryClient,
      async (): Promise<ConfirmedPauseResult> => {
        if (lane.uncertain || isRoutineUncertain(foundryClient))
          return fail(
            "Prior pause result uncertain; inspect world state and restart bridge before further pause mutations",
          );
        // Routing is bound to the existing authenticated opted-in GM bridge.
        const client = foundryClient
          .getCapabilityReport()
          .clients.find((c) => c.userId === input.userId && c.lane === "gm" && c.optedIn && c.isGM);
        if (!client) return fail("Exact authenticated GM bridge is not connected");
        try {
          const receipt = await foundryClient.call<ConfirmedPauseInput, ConfirmedPauseResult>(
            GAME_STATE_COMMANDS.SET_PAUSED_CONFIRMED,
            input,
            {
              clientId: client.clientId,
              userId: input.userId,
              lane: "gm",
              requestingUserId: input.userId,
              correlationId: input.correlationId,
            },
          );
          if (
            receipt.worldId !== input.worldId ||
            receipt.correlationId !== input.correlationId ||
            !["confirmed", "uncertain", "failure"].includes(receipt.outcome) ||
            (receipt.outcome === "confirmed" && receipt.paused !== input.paused)
          ) {
            lane.uncertain = true;
            markRoutineUncertain(foundryClient);
            return {
              ...fail("Pause acknowledgement mismatch; do not retry mutation"),
              outcome: "uncertain",
            };
          }
          if (receipt.outcome === "uncertain") {
            lane.uncertain = true;
            markRoutineUncertain(foundryClient);
          }
          return receipt;
        } catch {
          lane.uncertain = true;
          markRoutineUncertain(foundryClient);
          return {
            ...fail("Pause transport acknowledgement unavailable; do not retry mutation"),
            outcome: "uncertain",
          };
        }
      },
    );
    lane.receipts.set(key, { fingerprint, connection, result: operation });
    lane.tail = operation.catch(() => undefined);
    return operation;
  },
};

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
  confirmedPauseDescriptor,
];
