import { z } from "zod";
import type { AnyEndpointDescriptor } from "./types.js";
import { dispatchNativeGm } from "./native-gm-dispatch.js";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const decision = z.string().trim().min(1).max(1000);
const base = z
  .object({
    schemaVersion: z.literal("gm-actions-v1"),
    worldId: id,
    userId: id,
    sceneId: id,
    action: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("recipe.reservation"),
          recipeId: id,
          requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
      z
        .object({
          kind: z.literal("world-time.advance"),
          seconds: z.number().int().min(0).max(31536000),
          decision,
        })
        .strict(),
      z
        .object({
          kind: z.literal("token.elevation"),
          tokenId: id,
          elevation: z.number().finite().min(-100000).max(100000),
          decision,
        })
        .strict(),
      z
        .object({
          kind: z.literal("token.move"),
          tokenId: id,
          x: z.number().finite().min(0).max(100000),
          y: z.number().finite().min(0).max(100000),
          mode: z.enum(["walk", "teleport"]),
          movementCost: z.number().finite().min(0).max(10000),
          ruling: decision,
        })
        .strict(),
    ]),
  })
  .strict();
export const gmSceneEndpointDescriptors: AnyEndpointDescriptor[] = [
  {
    name: "foundry_gm_scene_state",
    method: "post",
    path: "/gm/scene/state",
    description:
      "Read scoped native movement/time/elevation or a journal-only recipe reservation precondition. Human rules decisions remain explicit.",
    inputSchema: base,
    annotations: { readOnlyHint: true },
    handler: (input, { foundryClient }) => dispatchNativeGm(foundryClient, "gmSceneRead", input),
  },
  {
    name: "foundry_gm_scene_apply",
    method: "post",
    path: "/gm/scene/apply",
    description:
      "Apply native movement/time/elevation or persist a journal-only recipe invocation reservation after exact-state checks. Reservation markers change no gameplay state and fence recipe restart continuation.",
    inputSchema: base.extend({
      expectedState: z.record(z.string(), z.unknown()),
      idempotencyKey: id,
      correlationId: id,
    }),
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: (input, { foundryClient }) =>
      dispatchNativeGm(foundryClient, "gmSceneApply", input, true),
  },
];
