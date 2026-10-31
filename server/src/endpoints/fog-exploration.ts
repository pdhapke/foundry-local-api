import { z } from "zod";
import {
  FOG_EXPLORATION_COMMANDS,
  type FogExplorationGetInput,
  type FogExplorationSnapshot,
  type FogExplorationUpdateInput,
  type FogExplorationUpdateResult,
} from "@foundry-local-api/shared";
import { FoundryBridgeError } from "../bridge/errors.js";
import type { AnyEndpointDescriptor, EndpointContext } from "./types.js";

const id = z.string().min(1).max(128);
const position = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    radius: z.number().finite().positive().optional(),
  })
  .strict();
const state = z
  .object({
    explored: z.string().max(4_000_000).nullable().optional(),
    positions: z.record(z.string().min(1).max(128), position).optional(),
  })
  .strict();
const getSchema = z.object({ sceneId: id, userId: id, level: id.optional() }).strict();
const updateSchema = getSchema
  .extend({
    mode: z.enum(["replace", "merge"]),
    state,
    expectedRevision: z.string().min(1).max(128),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
    removeDocument: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === "merge" && Object.hasOwn(value.state, "explored")) {
      context.addIssue({
        code: "custom",
        path: ["state", "explored"],
        message: "Binary explored texture data cannot be safely union-merged; use replace mode.",
      });
    }
  });

function gmClient(ctx: EndpointContext) {
  const client = ctx.foundryClient
    .getCapabilityReport()
    .clients.filter((candidate) => candidate.lane === "gm" && candidate.isGM && candidate.optedIn)
    .sort((a, b) => a.connectedAt - b.connectedAt)[0];
  if (!client)
    throw new FoundryBridgeError("NOT_CONNECTED", "No opted-in GM command lane is connected.", {
      retryable: true,
    });
  return client;
}

export const fogExplorationEndpointDescriptors: AnyEndpointDescriptor[] = [
  {
    name: "foundry_get_scene_fog",
    description:
      "Reads the exact persisted FogExploration state and revision for one Scene, user, and (Foundry v14+) Scene Level through the connected GM lane. level defaults to the Scene's only Level, else the GM's viewed Level, else the initial Level.",
    method: "get",
    path: "/scenes/fog",
    inputSchema: getSchema,
    handler: (input: FogExplorationGetInput, ctx): Promise<FogExplorationSnapshot> => {
      const gm = gmClient(ctx);
      return ctx.foundryClient.call(FOG_EXPLORATION_COMMANDS.GET, input, {
        clientId: gm.clientId,
        requestingUserId: gm.userId,
      });
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: "foundry_update_scene_fog",
    description:
      "Revision-checked, idempotent replace or explicit merge of one user's FogExploration on one Scene Level (same level default as foundry_get_scene_fog). Merge preserves the explored texture unless supplied; removeDocument restores a previously absent record.",
    method: "post",
    path: "/scenes/fog",
    inputSchema: updateSchema,
    handler: async (input: FogExplorationUpdateInput, ctx): Promise<FogExplorationUpdateResult> => {
      const gm = gmClient(ctx);
      const execute = () =>
        ctx.foundryClient.call<FogExplorationUpdateInput, FogExplorationUpdateResult>(
          FOG_EXPLORATION_COMMANDS.UPDATE,
          input,
          {
            clientId: gm.clientId,
            requestingUserId: gm.userId,
            correlationId: input.idempotencyKey,
            requireDurableAudit: true,
            auditOperation: "fog-exploration-update",
          },
        );
      if (!ctx.foundations) return execute();
      const stored = await ctx.foundations.idempotency.execute(
        `fog:${input.idempotencyKey}`,
        input,
        execute,
      );
      return { ...stored.result, replayed: stored.replayed || stored.result.replayed };
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
];
