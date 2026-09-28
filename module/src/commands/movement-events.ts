import {
  MOVEMENT_COMMANDS,
  ProtocolError,
  buildMovementEvent,
  type CompactMovementEvent,
  type MovementEventInput,
} from "@foundry-local-api/shared";
import { registerCommand } from "../command-registry.js";
export function buildLiveMovementEvent(input: MovementEventInput): CompactMovementEvent {
  const scene = game.collections.get("Scene")?.get(input.sceneId) as FoundryScene | undefined;
  if (!scene)
    throw new ProtocolError({
      code: "NOT_FOUND",
      message: `Scene "${input.sceneId}" not found.`,
      retryable: false,
      fieldPath: "sceneId",
    });
  if (!scene.getEmbeddedCollection("Token").has(input.tokenId))
    throw new ProtocolError({
      code: "NOT_FOUND",
      message: `Token "${input.tokenId}" not found.`,
      retryable: false,
      fieldPath: "tokenId",
    });
  if (game.users && !game.users.has(input.userId))
    throw new ProtocolError({
      code: "NOT_FOUND",
      message: `Initiating user "${input.userId}" not found.`,
      retryable: false,
      fieldPath: "userId",
    });
  return buildMovementEvent(input);
}
registerCommand(MOVEMENT_COMMANDS.BUILD_EVENT, buildLiveMovementEvent);
