import { z } from "zod";
import {
  GM_ACTIVITIES_COMMANDS,
  type GmActivityInput,
  type GmActivityApplyInput,
} from "@foundry-local-api/shared";
import type { AnyEndpointDescriptor } from "./types.js";
import { dispatchNativeGm } from "./native-gm-dispatch.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const gmActivityActionSchema = z
  .object({
    mode: z.literal("use"),
    tokenId: id,
    actorId: id,
    itemId: id,
    activityId: id,
    targetTokenIds: z.array(id).max(16),
    rulesDecisions: z
      .array(
        z
          .object({
            targetTokenId: id,
            decisionId: id,
            edition: z.enum(["2014", "2024"]),
            range: z.enum(["in-range", "long-range", "out-of-range"]),
            reach: z.enum(["in-reach", "not-applicable", "out-of-reach"]),
            lineOfEffect: z.boolean(),
            cover: z.enum(["none", "half", "three-quarters", "total"]),
            reason: z.string().min(1).max(1000),
          })
          .strict(),
      )
      .max(16),
    advantage: z.enum(["normal", "advantage", "disadvantage"]),
    rollMode: z.enum(["publicroll", "gmroll", "blindroll", "selfroll"]),
    damage: z.boolean().optional(),
    phase: z.enum(["ready", "release"]).optional(),
    ready: z
      .object({
        choiceId: id,
        trigger: z.string().min(1).max(2000),
        ruling: z.string().min(1).max(2000),
      })
      .strict()
      .optional(),
    release: z.object({ readyId: id, castReceipt: id }).strict().optional(),
    template: z
      .object({
        placements: z
          .array(
            z
              .object({
                x: z.number().finite(),
                y: z.number().finite(),
                direction: z.number().min(0).max(360),
              })
              .strict(),
          )
          .min(1)
          .max(16),
        ruling: z.string().min(1).max(2000),
      })
      .strict()
      .optional(),
    summon: z
      .object({
        profileId: id,
        actorId: id,
        creatureSize: id.optional(),
        creatureType: id.optional(),
        placements: z
          .array(
            z
              .object({
                x: z.number().finite(),
                y: z.number().finite(),
                elevation: z.number().min(-10000).max(10000),
                rotation: z.number().min(0).max(360),
              })
              .strict(),
          )
          .min(1)
          .max(16),
        ruling: z.string().min(1).max(2000),
      })
      .strict()
      .optional(),
    spellSlot: z
      .string()
      .regex(/^(spell[1-9]|pact)$/)
      .optional(),
    scaling: z.number().int().min(0).max(9).optional(),
    concentration: z
      .object({ begin: z.literal(true), endEffectId: id.optional() })
      .strict()
      .optional(),
    attack: z
      .object({
        abilityId: id,
        ammunitionId: id.optional(),
        attackMode: id.optional(),
        mastery: id.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((a, context) => {
    if (
      (a.phase === "ready") !== (a.ready !== undefined) ||
      (a.phase === "release") !== (a.release !== undefined)
    )
      context.addIssue({ code: "custom", message: "Exact held spell phase/choice required" });
    if (
      a.phase === "ready" &&
      (a.targetTokenIds.length || a.attack || a.damage || a.template || a.summon)
    )
      context.addIssue({ code: "custom", message: "Held cast has no release outcomes yet" });
    if (a.phase === "release" && a.concentration)
      context.addIssue({
        code: "custom",
        message: "Release concentration bound to original held cast",
      });
  });
const scope = {
  schemaVersion: z.literal("gm-actions-v1"),
  worldId: id,
  userId: id,
  sceneId: id,
  action: gmActivityActionSchema,
};
export const gmActivityReadSchema = z.object(scope).strict();
export const gmActivityApplySchema = z
  .object({
    ...scope,
    expectedState: z.record(z.string(), z.unknown()),
    idempotencyKey: id,
    correlationId: id,
  })
  .strict();

export const gmActivitiesEndpointDescriptors: AnyEndpointDescriptor[] = [
  {
    name: "foundry_gm_activity_state",
    method: "post",
    path: "/gm/activities/state",
    description:
      "Read exact GM-scoped native dnd5e activity, resources, target revisions and unresolved choices. Read before use; GM state must not be narrated to players without knowledge filtering.",
    inputSchema: gmActivityReadSchema,
    annotations: { readOnlyHint: true },
    handler: (input: GmActivityInput, { foundryClient }) => {
      gmActivityReadSchema.parse(input);
      return dispatchNativeGm(foundryClient, GM_ACTIVITIES_COMMANDS.READ, input, false);
    },
  },
  {
    name: "foundry_gm_activity_apply",
    method: "post",
    path: "/gm/activities/apply",
    description:
      "Activate native dnd5e activity with native slots/upcasting/charges/uses/concentration, explicit targets and awaited native attack. Optional damage:true awaits native typed damage/healing linked to original critical/ability/mode/ammunition; typed application and saves require separate explicit decisions. Durable exact-state reservation and turn budgets prevent duplicate spends. Range/reach/cover need per-target human rulings. Explicit template placements persist native geometry; exact owned unlinked world Actor summon profiles use native modifiers/count, with optional native CR/type filters. Held phase ready casts now under native concentration and action budget; phase release binds original confirmed cast and consumes only reaction. Modern attached Regions, compendium imports and linked activities require human native UI. Reconcile uncertain/cancelled results; never retry under a new key.",
    inputSchema: gmActivityApplySchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: (input: GmActivityApplyInput, { foundryClient }) => {
      gmActivityApplySchema.parse(input);
      return dispatchNativeGm(foundryClient, GM_ACTIVITIES_COMMANDS.APPLY, input, true);
    },
  },
];
