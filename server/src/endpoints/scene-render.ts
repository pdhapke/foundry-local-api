import { z } from "zod";
import {
  SCENE_RENDER_COMMANDS,
  SCENE_RENDER_LIMITS,
  type SceneRenderInput,
  type SceneRenderResult,
  type SceneVisibilityResult,
} from "@foundry-local-api/shared";
import { FoundryBridgeError } from "../bridge/errors.js";
import type { AnyEndpointDescriptor, EndpointContext } from "./types.js";

const id = z.string().min(1).max(128);
export const sceneRenderSchema = z
  .object({
    sceneId: id,
    effectiveUserId: id,
    tokenId: id,
    includeImage: z.boolean().optional(),
    maxImageBytes: z.number().int().min(1024).max(2_000_000).optional(),
    queryPoints: z
      .array(z.object({ id, x: z.number().finite(), y: z.number().finite() }).strict())
      .max(SCENE_RENDER_LIMITS.maxQueryPoints)
      .optional(),
  })
  .strict();

type Request = SceneRenderInput;

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
    .filter((client) => client.userId === input.effectiveUserId && client.optedIn)
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
  return input;
}

export const sceneRenderEndpointDescriptors: AnyEndpointDescriptor[] = [
  {
    name: "foundry_render_scene_snapshot",
    description:
      "Captures a bounded image and secrecy-safe visibility evidence from the selected user's exact opted-in client and owned Token. It never substitutes a GM render, persists state, exposes occluded identities, wall coordinates, secret doors, or exit destinations. Typed status and issues distinguish complete, incomplete, asset, and unsupported results; bridge failures retain NOT_CONNECTED or TIMEOUT codes.",
    method: "post",
    path: "/scenes/render-snapshot",
    inputSchema: sceneRenderSchema,
    handler: (input: Request, ctx): Promise<SceneRenderResult> => {
      const { requester, target } = route(input, ctx);
      return ctx.foundryClient.call(SCENE_RENDER_COMMANDS.SNAPSHOT, payload(input), {
        clientId: target.clientId,
        userId: target.userId,
        requestingUserId: requester.userId,
      });
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
    handler: (input: Request, ctx): Promise<SceneVisibilityResult> => {
      const { requester, target } = route(input, ctx);
      return ctx.foundryClient.call(SCENE_RENDER_COMMANDS.VISIBILITY, payload(input), {
        clientId: target.clientId,
        userId: target.userId,
        requestingUserId: requester.userId,
      });
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
];
