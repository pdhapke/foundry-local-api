import { z } from "zod";
import {
  DND5E_SIMULATION_COMMANDS,
  type Dnd5eSimulationInput,
  type Dnd5eSimulationResult,
} from "@foundry-local-api/shared";
import { FoundryBridgeError } from "../bridge/errors.js";
import type { AnyEndpointDescriptor } from "./types.js";
const action = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("attack"),
      itemId: z.string().min(1).optional(),
      activityId: z.string().min(1).optional(),
      modifier: z.number().finite().optional(),
      targetAC: z.number().finite().optional(),
      damage: z.string().max(32).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("save"),
      ability: z
        .string()
        .regex(/^[a-z]{3}$/)
        .optional(),
      skill: z
        .string()
        .regex(/^[a-z]{3,5}$/)
        .optional(),
      modifier: z.number().finite().optional(),
      dc: z.number().finite(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("damage"),
      itemId: z.string().min(1).optional(),
      activityId: z.string().min(1).optional(),
      amount: z.number().nonnegative().optional(),
      formula: z.string().max(32).optional(),
      damageType: z.string().min(1).max(32).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("effect"),
      effectId: z.string().min(1),
      active: z.boolean(),
      targetActorId: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("resource"),
      path: z
        .string()
        .regex(
          /^system\.(resources\.(primary|secondary|tertiary)\.value|attributes\.(hp|hd)\.value|spells\.(spell[1-9]|pact)\.value)$/,
        ),
      delta: z.number().finite(),
      min: z.number().finite().optional(),
      max: z.number().finite().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("rest"), restType: z.enum(["short", "long"]) }).strict(),
  z
    .object({
      kind: z.literal("combat"),
      transition: z.enum(["start", "next-turn", "next-round", "end"]),
    })
    .strict(),
]);
export const dnd5eSimulationEndpointDescriptors: AnyEndpointDescriptor[] = [
  {
    name: "foundry_simulate_dnd5e_action",
    description:
      "Deterministically projects one action or an ordered bounded dnd5e 6.0.3 action sequence using caller-verified live Actor/Item/Token/Combat revisions plus a seed or supplied rolls. It requires explicit no-persist mode, creates no chat, combat, effect, or document updates, stops at the first invalid step by default, and can isolate failed steps when continue-on-error is requested.",
    method: "post",
    path: "/dnd5e/simulate",
    inputSchema: z
      .object({
        effectiveUserId: z.string().min(1).max(128),
        actorId: z.string().min(1),
        targetActorId: z.string().min(1).optional(),
        tokenId: z.string().min(1).optional(),
        sceneId: z.string().min(1).optional(),
        combatId: z.string().min(1).optional(),
        action: action.optional(),
        actions: z.array(action).min(1).max(32).optional(),
        continueOnError: z.boolean().optional(),
        seed: z.number().int().min(0).max(0xffffffff).optional(),
        suppliedRolls: z.array(z.number().int().positive()).max(100).optional(),
        noPersist: z.literal(true),
        expectedRevisions: z
          .array(
            z
              .object({
                kind: z.enum(["actor", "target", "item", "token", "combat"]),
                id: z.string().min(1).max(128),
                revision: z.string().min(1).max(128),
              })
              .strict(),
          )
          .min(1)
          .max(100),
        expectedSystemVersion: z.literal("6.0.3"),
      })
      .strict()
      .superRefine((value, context) => {
        if (Boolean(value.action) === Boolean(value.actions)) {
          context.addIssue({
            code: "custom",
            path: ["actions"],
            message: "Provide exactly one of action or actions.",
          });
        }
        const revisionKeys = value.expectedRevisions.map((entry) => `${entry.kind}:${entry.id}`);
        if (new Set(revisionKeys).size !== revisionKeys.length) {
          context.addIssue({
            code: "custom",
            path: ["expectedRevisions"],
            message: "Expected revision identities must be unique.",
          });
        }
        const actions = value.action ? [value.action] : (value.actions ?? []);
        for (const [index, candidate] of actions.entries()) {
          if (
            "activityId" in candidate &&
            candidate.activityId !== undefined &&
            candidate.itemId === undefined
          )
            context.addIssue({
              code: "custom",
              path: value.action ? ["action", "activityId"] : ["actions", index, "activityId"],
              message: "activityId requires itemId.",
            });
        }
      }),
    handler: (input: Dnd5eSimulationInput, { foundryClient }) => {
      const clients = foundryClient.getCapabilityReport().clients;
      const requester = clients.find(
        (client) => client.lane === "gm" && client.isGM && client.optedIn,
      );
      if (!requester)
        throw new FoundryBridgeError("NOT_CONNECTED", "No opted-in GM command lane is connected.", {
          retryable: true,
        });
      const target = clients
        .filter(
          (client) =>
            client.userId === input.effectiveUserId &&
            client.optedIn &&
            client.capabilities.includes(DND5E_SIMULATION_COMMANDS.SIMULATE),
        )
        .sort((left, right) => right.connectedAt - left.connectedAt)[0];
      if (!target)
        throw new FoundryBridgeError(
          "NOT_CONNECTED",
          "The selected simulation user is not connected and opted in.",
          { retryable: true },
        );
      return foundryClient.call<Dnd5eSimulationInput, Dnd5eSimulationResult>(
        DND5E_SIMULATION_COMMANDS.SIMULATE,
        input,
        {
          clientId: target.clientId,
          userId: target.userId,
          requestingUserId: requester.userId,
        },
      );
    },
    annotations: { readOnlyHint: true },
  },
];
