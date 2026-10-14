import { z } from "zod";
import {
  SCENE_RENDER_COMMANDS,
  SCENE_RENDER_LIMITS,
  type SceneRenderInput,
  type SceneRenderResult,
  type SceneVisibilityResult,
} from "@foundry-local-api/shared";
import { FoundryBridgeError } from "../bridge/errors.js";
import {
  sceneRenderOutputSchema,
  sceneVisibilityOutputSchema,
} from "./requirement-output-schemas.js";
import type { AnyEndpointDescriptor, EndpointContext } from "./types.js";

const id = z.string().min(1).max(128);
export const sceneRenderSchema = z
  .object({
    sceneId: id,
    effectiveUserId: id,
    clientId: id.optional(),
    tokenId: id,
    includeImage: z.boolean().optional(),
    maxImageBytes: z.number().int().min(1024).max(2_000_000).optional(),
    queryPoints: z
      .array(z.object({ id, x: z.number().finite(), y: z.number().finite(), elevation: z.number().finite().optional() }).strict())
      .max(SCENE_RENDER_LIMITS.maxQueryPoints)
      .optional(),
  })
  .strict();

type Request = SceneRenderInput & { clientId?: string };

function route(input: Request, ctx: EndpointContext) {
  const clients = ctx.foundryClient.getCapabilityReport().clients;
  const requester = clients
    .filter((client) => client.lane === "gm" && client.isGM && client.optedIn)
    .sort((a, b) => a.connectedAt - b.connectedAt)[0];
  if (!requester)
    throw new FoundryBridgeError("NOT_CONNECTED", "No opted-in GM command lane is connected.", {
      retryable: true,
    });
  const target = clients
    .filter(
      (client) =>
        client.userId === input.effectiveUserId &&
        (!input.clientId || client.clientId === input.clientId) &&
        client.lane === "player" &&
        !client.isGM &&
        client.optedIn,
    )
    .sort((a, b) => b.connectedAt - a.connectedAt)[0];
  if (!target)
    throw new FoundryBridgeError(
      "NOT_CONNECTED",
      "The selected user's opted-in rendering client is disconnected.",
      { retryable: true },
    );
  return { requester, target };
}

function payload(input: Request): SceneRenderInput {
  const { clientId: _clientId, ...commandInput } = input;
  return commandInput;
}
async function observe<T extends SceneVisibilityResult>(input: Request, ctx: EndpointContext, command: string): Promise<T> {
  const routed = route(input, ctx);
  // Capability reports may expose mutable records; preserve the dispatch binding across awaits.
  const requester = { ...routed.requester };
  const target = { ...routed.target };
  const result = await ctx.foundryClient.call<SceneRenderInput, T>(command, payload(input), {
    clientId: target.clientId, userId: target.userId, requestingUserId: requester.userId,
  });
  const observation = result?.observation;
  if (!observation || observation.version !== 1 || result.sceneId !== input.sceneId || result.effectiveUserId !== input.effectiveUserId || result.tokenId !== input.tokenId
    || observation.sceneId !== input.sceneId || observation.userId !== input.effectiveUserId || observation.tokenId !== input.tokenId
    || observation.isGM !== false || observation.optedIn !== true || typeof observation.worldId !== "string") throw new FoundryBridgeError("INVALID_PAYLOAD", "Player observation acknowledgement mismatch.", { retryable: false });
  observation.clientId = target.clientId;
  const clients = ctx.foundryClient.getCapabilityReport().clients;
  const stillBound = clients.some(value => value.clientId === target.clientId && value.connectedAt === target.connectedAt && value.userId === target.userId && value.lane === "player" && !value.isGM && value.optedIn)
    && clients.some(value => value.clientId === requester.clientId && value.connectedAt === requester.connectedAt && value.userId === requester.userId && value.lane === "gm" && value.isGM && value.optedIn);
  if (!stillBound) {
    observation.readiness = "stale"; result.status = "incomplete";
    result.visible = { tokens: [], notes: [], tiles: [] }; result.regions = []; result.visibleBarriers = []; result.coveragePolygons = [];
    result.queryPoints = (result.queryPoints ?? []).map(point => ({ ...point, visible: false, regions: [], blockerKeys: [], blockerAttribution: "unavailable" }));
    if ("image" in result) result.image = null;
  }
  return result;
}

export const sceneRenderEndpointDescriptors: AnyEndpointDescriptor[] = [
  {
    name: "foundry_render_scene_snapshot",
    description:
      "Captures a bounded image and secrecy-safe visibility evidence from the selected user's exact opted-in client and owned Token. It never substitutes a GM render, persists state, exposes occluded identities, wall coordinates, secret doors, or exit destinations. Typed status and issues distinguish complete, incomplete, asset, and unsupported results; bridge failures retain NOT_CONNECTED or TIMEOUT codes.",
    method: "post",
    path: "/scenes/render-snapshot",
    inputSchema: sceneRenderSchema,
    outputSchema: sceneRenderOutputSchema,
    handler: (input: Request, ctx): Promise<SceneRenderResult> => {
      return observe(input, ctx, SCENE_RENDER_COMMANDS.SNAPSHOT);
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: "foundry_get_token_visibility",
    description:
      "Returns bounded, coordinate-safe Region, visible-barrier, visible-placeable, query-point, fog, light, darkness, vision, and persistence evidence from the selected user's exact loaded canvas and owned Token. Occluded identities, secret doors, barrier coordinates, and destinations are always redacted, with no GM fallback.",
    method: "post",
    path: "/scenes/token-visibility",
    inputSchema: sceneRenderSchema,
    outputSchema: sceneVisibilityOutputSchema,
    handler: (input: Request, ctx): Promise<SceneVisibilityResult> => {
      return observe(input, ctx, SCENE_RENDER_COMMANDS.VISIBILITY);
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
];
