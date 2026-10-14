import { z } from "zod";
import {
  GM_CHARACTER_COMMANDS,
  validateGmCharacterAction,
  type NativeGmInput,
  type NativeGmApplyInput,
  type NativeGmReceipt,
} from "@foundry-local-api/shared";
import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";
import { dispatchNativeGm } from "./native-gm-dispatch.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const gmCharacterActionSchema = z
  .record(z.string(), z.unknown())
  .superRefine((action, ctx) => {
    try {
      validateGmCharacterAction(action);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid bounded native character action",
      });
    }
  });
export const gmCharacterReadSchema = z
  .object({
    schemaVersion: z.literal("gm-actions-v1"),
    worldId: id,
    userId: id,
    sceneId: id,
    action: gmCharacterActionSchema,
  })
  .strict();
export const gmCharacterApplySchema = gmCharacterReadSchema
  .extend({
    expectedState: z.record(z.string(), z.unknown()),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
    correlationId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
  })
  .strict()
  .superRefine((input, ctx) => {
    try {
      validateGmCharacterAction(input.action, true);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Read-only character action cannot be applied",
      });
    }
  });
const read: EndpointDescriptor<NativeGmInput, Record<string, unknown>> = {
  name: "foundry_gm_character_state",
  method: "post",
  path: "/gm/character/state",
  inputSchema: gmCharacterReadSchema,
  description:
    "Read exact native scene actor health/effects/passives/resources/inventory and Foundry user/character/ownership party roster. GM only. Lookup recipes before applying character actions.",
  annotations: { readOnlyHint: true },
  handler: (input, { foundryClient }) =>
    dispatchNativeGm(foundryClient, GM_CHARACTER_COMMANDS.READ, input),
};
const apply: EndpointDescriptor<NativeGmApplyInput, NativeGmReceipt> = {
  name: "foundry_gm_character_apply",
  method: "post",
  path: "/gm/character/apply",
  inputSchema: gmCharacterApplySchema,
  description:
    "Apply bounded native typed damage/healing/tempHP, checks/death/concentration, stable/unconscious effects, conditions/exhaustion, rests/hit dice, inventory/copies/removal/attunement, currency/XP/maxHP and effect durations. Exact active GM+scene, expected state, durable dedup receipts. Lookup recipe; human rulings required for stabilization/eligibility/group/contested/traps/grapple/shove; transfer is separate receipted copy and source-removal steps. Never replay uncertain rolls/spends.",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  handler: (input, { foundryClient }) =>
    dispatchNativeGm(foundryClient, GM_CHARACTER_COMMANDS.APPLY, input, true),
};
export const gmCharacterEndpointDescriptors: AnyEndpointDescriptor[] = [read, apply];
