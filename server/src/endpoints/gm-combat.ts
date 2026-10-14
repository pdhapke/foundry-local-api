import { z } from "zod";
import {
  GM_COMBAT_COMMANDS,
  validateGmCombatAction,
  type NativeGmInput,
  type NativeGmApplyInput,
  type NativeGmReceipt,
} from "@foundry-local-api/shared";
import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";
import { dispatchNativeGm } from "./native-gm-dispatch.js";

const action = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  try {
    validateGmCombatAction(value);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Invalid combat action",
    });
  }
});
export const gmCombatStateSchema = z
  .object({
    schemaVersion: z.literal("gm-actions-v1"),
    worldId: z.string().min(1).max(128),
    userId: z.string().min(1).max(128),
    sceneId: z.string().min(1).max(128),
    action,
  })
  .strict();
export const gmCombatApplySchema = gmCombatStateSchema.extend({
  expectedState: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().min(1).max(128),
  correlationId: z.string().min(1).max(128),
});
const state: EndpointDescriptor<NativeGmInput, Record<string, unknown>> = {
  name: "foundry_gm_combat_state",
  description:
    "GM-only exact scene combat state and private durable budgets/ready/interruption ledger. Use the complete result as expectedState. Native Foundry 14.368 / dnd5e 6.0.3; explicit rules choices; no historical capture or automatic opportunity detection.",
  method: "post",
  path: "/gm/combat/state",
  inputSchema: gmCombatStateSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  handler: (input, { foundryClient }) =>
    dispatchNativeGm(foundryClient, GM_COMBAT_COMMANDS.READ, input),
};
const apply: EndpointDescriptor<NativeGmApplyInput, NativeGmReceipt> = {
  name: "foundry_gm_combat_apply",
  description:
    "Authenticated native GM encounter creation from existing scene tokens, roster/initiative/start/next/end and durable explicit action/bonus/reaction/movement/ready/interruption decisions. End deletes the combat. Pending interruptions block progress. Legendary/lair/mythic rules require explicit GM ruling and native activity activation for resource use. Supply exact state, durable idempotencyKey and correlationId; uncertain receipts forbid replay.",
  method: "post",
  path: "/gm/combat/apply",
  inputSchema: gmCombatApplySchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: (input, { foundryClient }) =>
    dispatchNativeGm(foundryClient, GM_COMBAT_COMMANDS.APPLY, input, true),
};
export const gmCombatEndpointDescriptors: AnyEndpointDescriptor[] = [state, apply];
