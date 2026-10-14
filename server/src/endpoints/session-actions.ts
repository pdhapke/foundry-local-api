import {
  enqueueRoutineMutation,
  markRoutineUncertain,
  isRoutineUncertain,
} from "./routine-mutation-lane.js";
import { z } from "zod";
import {
  SESSION_ACTION_COMMANDS,
  type SessionActionInput,
  type SessionActionApplyInput,
  type SessionActionState,
  type SessionActionReceipt,
} from "@foundry-local-api/shared";
import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";
import { dispatchAuthenticatedFoundry } from "./native-gm-dispatch.js";
const id = z.string().min(1).max(128);
const target = { sceneId: id, targetId: id };
const lightRadius = z
  .number()
  .finite()
  .min(0)
  .max(10000)
  .refine(
    (value) => value === Number(value.toFixed(2)),
    "Native light radii require 0.01 scene-unit precision",
  );
export const tokenLightSchema = z
  .object({
    bright: lightRadius.optional(),
    dim: lightRadius.optional(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .toLowerCase()
      .nullable()
      .optional(),
    alpha: z.number().finite().min(0).max(1).optional(),
  })
  .strict()
  .refine(
    (light) => Object.values(light).some((value) => value !== undefined),
    "Supply at least one light field",
  );
export const sessionActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("token.light"), ...target, light: tokenLightSchema }).strict(),
  z
    .object({ kind: z.literal("actor.condition"), ...target, conditionId: id, active: z.boolean() })
    .strict(),
  z
    .object({
      kind: z.literal("playlist.sound"),
      targetId: id,
      soundId: id,
      state: z.enum(["playing", "paused", "stopped"]),
    })
    .strict(),
  z
    .object({ kind: z.literal("actor.hp"), ...target, value: z.number().int().min(0).max(100000) })
    .strict(),
  z
    .object({
      kind: z.literal("door.state"),
      ...target,
      value: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("token.position"),
      ...target,
      x: z.number().min(0).max(100000),
      y: z.number().min(0).max(100000),
      mode: z.enum(["walk", "teleport"]).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("combat.next"), ...target }).strict(),
  z
    .object({
      kind: z.literal("combat.initiative"),
      ...target,
      combatantId: id,
      value: z.number().min(-10000).max(10000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("chat.post"),
      messageId: id.optional(),
      text: z
        .string()
        .min(1)
        .max(4000)
        .refine((s) => !/[<>]/.test(s), "Plain text only"),
    })
    .strict(),
]);
const base = z.object({ worldId: id, requestingUserId: id, action: sessionActionSchema }).strict();
export const sessionActionApplySchema = base
  .extend({
    expectedState: z.record(z.string(), z.unknown()),
    correlationId: id,
    idempotencyKey: id,
  })
  .strict();
const read: EndpointDescriptor<SessionActionInput, SessionActionState> = {
  name: "foundry_get_session_action_state",
  description:
    "Read bounded authoritative preflight state for a narrow GM session action on the current scene.",
  method: "post",
  path: "/session-actions/state",
  inputSchema: base,
  annotations: { readOnlyHint: true },
  handler: (input, { foundryClient }) =>
    dispatchAuthenticatedFoundry<SessionActionState>(
      foundryClient,
      SESSION_ACTION_COMMANDS.READ,
      input,
      { worldId: input.worldId, userId: input.requestingUserId },
    ),
};
const apply: EndpointDescriptor<SessionActionApplyInput, SessionActionReceipt> = {
  name: "foundry_apply_session_action",
  description:
    "Apply one narrow current-scene session action for a live authorized GM, checking expectedState immediately before dispatch and reading back state. Supports dnd5e HP, door state, token position, combat next turn/initiative and plain chat. Caller must durably deduplicate; never retry uncertain results.",
  method: "post",
  path: "/session-actions/apply",
  inputSchema: sessionActionApplySchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  handler: (input, { foundryClient }) =>
    dispatchAuthenticatedFoundry<SessionActionReceipt>(
      foundryClient,
      SESSION_ACTION_COMMANDS.APPLY,
      input,
      {
        worldId: input.worldId,
        userId: input.requestingUserId,
        correlationId: input.correlationId,
      },
      true,
      (result) => {
        if (
          result.worldId !== input.worldId ||
          result.idempotencyKey !== input.idempotencyKey ||
          result.correlationId !== input.correlationId ||
          result.verified !== true ||
          JSON.stringify(result.action) !== JSON.stringify(input.action)
        )
          throw Error("Native session acknowledgement scope mismatch");
      },
    ),
};
export const sessionActionEndpointDescriptors: AnyEndpointDescriptor[] = [read, apply];

import {
  CORE_ACTION_COMMAND,
  type CoreActionInput,
  type CoreActionResult,
} from "@foundry-local-api/shared";
const coreSchema = z
  .object({
    worldId: id,
    userId: id,
    requestId: id,
    correlationId: id,
    origin: z.literal("ai-dm"),
    schemaVersion: z.literal("core-actions-v1"),
    action: z.union([
      z
        .object({
          kind: z.literal("system.roll"),
          sceneId: id,
          targetId: id,
          rollType: z.enum(["ability", "save", "skill"]),
          key: z.string().min(1).max(32),
        })
        .strict(),
      sessionActionSchema.refine(
        (a) => a.kind !== "playlist.sound" && a.kind !== "chat.post",
        "Unsupported core family",
      ),
      z
        .object({
          kind: z.literal("dice.roll"),
          formula: z
            .string()
            .regex(/^(?:[1-9]|[1-9][0-9])d(?:4|6|8|10|12|20|100)(?:[+-](?:0|[1-9][0-9]{0,3}))?$/),
        })
        .strict(),
    ]),
  })
  .strict();
const coreLanes = new WeakMap<
  object,
  {
    tail: Promise<unknown>;
    uncertain: boolean;
    receipts: Map<
      string,
      { fingerprint: string; connection: string; result: Promise<CoreActionResult> }
    >;
  }
>();
function confirmedStateMatches(input: CoreActionInput, receipt: CoreActionResult): boolean {
  const s = receipt.state,
    a = input.action;
  if (!s || typeof receipt.mutated !== "boolean") return false;
  switch (a.kind) {
    case "actor.hp":
      return s["value"] === a.value;
    case "actor.condition":
      return s["active"] === a.active;
    case "door.state":
      return s["ds"] === a.value;
    case "token.position":
      return s["x"] === a.x && s["y"] === a.y;
    case "token.light": {
      const light = s["light"];
      return Boolean(
        light &&
        typeof light === "object" &&
        !Array.isArray(light) &&
        Object.entries(a.light).every(
          ([key, value]) => (light as Record<string, unknown>)[key] === value,
        ),
      );
    }
    case "combat.initiative":
      return s["initiative"] === a.value;
    case "combat.next":
      return (
        Number.isInteger(s["round"]) &&
        Number(s["round"]) >= 1 &&
        Number.isInteger(s["turn"]) &&
        Number(s["turn"]) >= 0 &&
        Number.isInteger(s["turnCount"]) &&
        Number(s["turn"]) < Number(s["turnCount"])
      );
    case "dice.roll":
      return (
        typeof s["total"] === "number" &&
        Number.isFinite(s["total"]) &&
        typeof s["formula"] === "string"
      );
    case "system.roll":
      return (
        s["systemId"] === "dnd5e" &&
        s["rollType"] === a.rollType &&
        s["key"] === a.key &&
        Array.isArray(s["rolls"]) &&
        s["rolls"].length > 0 &&
        s["rolls"].every(
          (r) =>
            r &&
            typeof r.total === "number" &&
            Number.isFinite(r.total) &&
            typeof r.formula === "string",
        )
      );
  }
}
const core: EndpointDescriptor<CoreActionInput, CoreActionResult> = {
  name: "foundry_core_action_confirmed",
  description:
    "Execute a bounded typed routine GM action with exact current-world authorization, serialization, deduplication and authoritative read-back. Never retry uncertain outcomes.",
  method: "post",
  path: "/session-actions/core/confirmed",
  inputSchema: coreSchema as unknown as z.ZodType<CoreActionInput>,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  handler: (input, { foundryClient }) => {
    const failure = (message: string): CoreActionResult => ({
      outcome: "failure",
      worldId: input.worldId,
      correlationId: input.correlationId,
      schemaVersion: "core-actions-v1",
      action: input.action,
      state: null,
      mutated: false,
      message,
    });
    const client = foundryClient
      .getCapabilityReport()
      .clients.find((c) => c.userId === input.userId && c.lane === "gm" && c.isGM && c.optedIn);
    if (!client) return failure("Exact authenticated GM bridge disconnected");
    const connection = `${client.clientId}:${client.connectedAt}`;
    let lane = coreLanes.get(foundryClient);
    if (!lane) {
      lane = { tail: Promise.resolve(), uncertain: false, receipts: new Map() };
      coreLanes.set(foundryClient, lane);
    }
    const key = `${input.worldId}:${input.userId}:${input.requestId}`,
      fingerprint = JSON.stringify(input),
      previous = lane.receipts.get(key);
    const options = {
      clientId: client.clientId,
      userId: input.userId,
      lane: "gm" as const,
      requestingUserId: input.userId,
      correlationId: input.correlationId,
    };
    const authorize = async () => {
      const identity = await foundryClient.call<undefined, { worldId: string; userId: string }>(
        "status",
        undefined,
        options,
      );
      const user = await foundryClient.call<undefined, { isGM: boolean; active: boolean }>(
        "user",
        undefined,
        options,
      );
      return (
        identity.worldId === input.worldId &&
        identity.userId === input.userId &&
        user.isGM &&
        user.active
      );
    };
    if (previous) {
      if (previous.fingerprint !== fingerprint || previous.connection !== connection)
        return failure("Historical or changed request cannot replay");
      return authorize()
        .then((ok) => (ok ? previous.result : failure("Current GM/world mismatch")))
        .catch(() => failure("Current authority unavailable"));
    }
    if (lane.receipts.size >= 4096) return failure("Receipt capacity exhausted");
    const result = enqueueRoutineMutation(foundryClient, async (): Promise<CoreActionResult> => {
      if (lane.uncertain || isRoutineUncertain(foundryClient))
        return failure(
          "Prior mutation uncertain; inspect state and restart bridge before further mutations",
        );
      let dispatched = false;
      try {
        if (!(await authorize())) return failure("Current exact GM/world required");
        const current = foundryClient
          .getCapabilityReport()
          .clients.find(
            (c) =>
              c.clientId === client.clientId && c.userId === input.userId && c.isGM && c.optedIn,
          );
        if (!current || `${current.clientId}:${current.connectedAt}` !== connection)
          return failure("GM connection changed while queued");
        dispatched = true;
        const receipt = await foundryClient.call<CoreActionInput, CoreActionResult>(
          CORE_ACTION_COMMAND,
          input,
          options,
        );
        const acceptingClient = foundryClient
          .getCapabilityReport()
          .clients.find(
            (c) =>
              c.clientId === client.clientId &&
              c.userId === input.userId &&
              c.lane === "gm" &&
              c.isGM &&
              c.optedIn,
          );
        if (
          !acceptingClient ||
          `${acceptingClient.clientId}:${acceptingClient.connectedAt}` !== connection
        ) {
          lane.uncertain = true;
          markRoutineUncertain(foundryClient);
          return {
            ...failure(
              "GM connection or consent changed before acknowledgement acceptance; do not retry",
            ),
            outcome: "uncertain",
          };
        }
        if (
          receipt.worldId !== input.worldId ||
          receipt.correlationId !== input.correlationId ||
          receipt.schemaVersion !== input.schemaVersion ||
          JSON.stringify(receipt.action) !== JSON.stringify(input.action) ||
          !["confirmed", "failure", "uncertain"].includes(receipt.outcome) ||
          (receipt.outcome === "confirmed" && !confirmedStateMatches(input, receipt))
        ) {
          lane.uncertain = true;
          markRoutineUncertain(foundryClient);
          return { ...failure("Acknowledgement mismatch; do not retry"), outcome: "uncertain" };
        }
        if (receipt.outcome === "uncertain") {
          lane.uncertain = true;
          markRoutineUncertain(foundryClient);
        }
        return receipt;
      } catch {
        if (dispatched) {
          lane.uncertain = true;
          markRoutineUncertain(foundryClient);
        }
        return {
          ...failure(
            dispatched
              ? "Transport acknowledgement unavailable; do not retry"
              : "Authority unavailable",
          ),
          outcome: dispatched ? "uncertain" : "failure",
        };
      }
    });
    lane.receipts.set(key, { fingerprint, connection, result });
    lane.tail = result.catch(() => undefined);
    return result;
  },
};
sessionActionEndpointDescriptors.push(core);

const tokenLightInputSchema = z
  .object({
    worldId: id,
    userId: id,
    requestId: id,
    correlationId: id,
    sceneId: id,
    tokenId: id,
    light: tokenLightSchema,
  })
  .strict();
const tokenLight: EndpointDescriptor<z.infer<typeof tokenLightInputSchema>, CoreActionResult> = {
  name: "foundry_set_token_light",
  description:
    "Patch one placed token's bright/dim light radius in scene distance units (0.01 precision), optional hex color (normalized lowercase) and alpha, preserving omitted fields; clear emission with bright=dim=0. Uses exact current-world GM authorization and the confirmed core action lane. Light follows the token natively; vision, fog and walls still govern what is revealed. Deduplicated by requestId; never retry uncertain outcomes.",
  method: "post",
  path: "/session-actions/token/light",
  inputSchema: tokenLightInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  handler: (input, context) =>
    core.handler(
      {
        worldId: input.worldId,
        userId: input.userId,
        requestId: input.requestId,
        correlationId: input.correlationId,
        origin: "ai-dm",
        schemaVersion: "core-actions-v1",
        action: {
          kind: "token.light",
          sceneId: input.sceneId,
          targetId: input.tokenId,
          light: {
            ...(input.light.bright !== undefined ? { bright: input.light.bright } : {}),
            ...(input.light.dim !== undefined ? { dim: input.light.dim } : {}),
            ...(input.light.color !== undefined ? { color: input.light.color } : {}),
            ...(input.light.alpha !== undefined ? { alpha: input.light.alpha } : {}),
          },
        },
      },
      context,
    ),
};
sessionActionEndpointDescriptors.push(tokenLight);

const coreState: EndpointDescriptor<
  { worldId: string; userId: string; schemaVersion: "core-actions-v1" },
  Record<string, unknown>
> = {
  name: "foundry_core_state",
  description:
    "Read bounded current-scene token, door, combat and configured condition identifiers on the exact authorized GM bridge.",
  method: "post",
  path: "/session-actions/core/state",
  inputSchema: z
    .object({ worldId: id, userId: id, schemaVersion: z.literal("core-actions-v1") })
    .strict(),
  annotations: { readOnlyHint: true },
  handler: (input, { foundryClient }) => {
    const client = foundryClient
      .getCapabilityReport()
      .clients.find((c) => c.userId === input.userId && c.lane === "gm" && c.isGM && c.optedIn);
    if (!client) throw Error("Exact authenticated GM bridge disconnected");
    return foundryClient.call("coreState", input, {
      clientId: client.clientId,
      userId: input.userId,
      lane: "gm",
      requestingUserId: input.userId,
    });
  },
};
sessionActionEndpointDescriptors.push(coreState);

const tokenLightReadSchema = z
  .object({ worldId: id, userId: id, sceneId: id, tokenId: id })
  .strict();
const tokenLightRead: EndpointDescriptor<
  z.infer<typeof tokenLightReadSchema>,
  Record<string, unknown>
> = {
  name: "foundry_get_token_light",
  description:
    "Read bounded native emission for one exact placed token in the active scene, including scene distance units. Requires exact current-world GM. Token emission is distinct from vision/darkvision, ambient lights and actor prototype tokens.",
  method: "post",
  path: "/session-actions/token/light/state",
  inputSchema: tokenLightReadSchema,
  annotations: { readOnlyHint: true },
  handler: async (input, { foundryClient }) => {
    const client = foundryClient
      .getCapabilityReport()
      .clients.find((c) => c.userId === input.userId && c.lane === "gm" && c.isGM && c.optedIn);
    if (!client)
      throw Error("Exact authenticated GM bridge disconnected; token light read unavailable");
    const generation = client.connectedAt;
    const result = await foundryClient.call<typeof input, Record<string, unknown>>(
      "tokenLightRead",
      input,
      {
        clientId: client.clientId,
        userId: input.userId,
        lane: "gm",
        requestingUserId: input.userId,
      },
    );
    const current = foundryClient
      .getCapabilityReport()
      .clients.find((c) => c.clientId === client.clientId);
    if (
      !current ||
      current.connectedAt !== generation ||
      current.userId !== input.userId ||
      current.lane !== "gm" ||
      !current.isGM ||
      !current.optedIn
    )
      throw Error("Token light read authority changed; read again after reconnect");
    if (
      result["worldId"] !== input.worldId ||
      result["sceneId"] !== input.sceneId ||
      result["tokenId"] !== input.tokenId ||
      result["scope"] !== "placed-token" ||
      !result["light"] ||
      typeof result["light"] !== "object" ||
      Array.isArray(result["light"]) ||
      Buffer.byteLength(JSON.stringify(result), "utf8") > 9000
    )
      throw Error("Invalid bounded native token light readback");
    return result;
  },
};
sessionActionEndpointDescriptors.push(tokenLightRead);
