import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  GM_TV_COMMANDS,
  TV_CONTROL_VERSION,
  type TvControlInput,
  type TvControlCommandInput,
  type TvControlExecutionResult,
} from "@foundry-local-api/shared";
import { FoundryBridgeError } from "../bridge/errors.js";
import type { AnyEndpointDescriptor } from "./types.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const coordinate = z.number().finite().min(-1e7).max(1e7);
const zoom = z.number().finite().min(0.1).max(3);
const camera = z.object({ x: coordinate, y: coordinate, scale: zoom }).strict();
const cameraState = camera.extend({ sceneId: id }).strict();
const common = {
  version: z.literal(TV_CONTROL_VERSION),
  worldId: id,
  sceneId: id,
  tvUserId: id,
  tvClientId: id,
  requestingUserId: id,
};
const apply = {
  ...common,
  expectedState: cameraState,
  idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
};
const tvActionSchema = z
  .discriminatedUnion("action", [
    z.object({ ...common, action: z.literal("inspect") }).strict(),
    z.object({ ...apply, action: z.literal("unionVision") }).strict(),
    z.object({ ...apply, action: z.literal("camera"), camera }).strict(),
    z
      .object({
        ...apply,
        action: z.literal("calibrate"),
        calibration: z
          .object({
            measuredPixels: z.number().finite().min(1).max(10000),
            measuredInches: z.number().finite().min(0.01).max(200),
            gridInches: z.number().finite().min(0.1).max(10),
            rulerConfirmed: z.literal(true),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...apply,
        action: z.literal("perspective"),
        perspective: z.literal("native-top-down"),
      })
      .strict(),
  ])
  .refine(
    (input) => input.action === "inspect" || input.expectedState.sceneId === input.sceneId,
    "expectedState must be scoped to the requested scene",
  );
/** The registry requires a flat ZodObject; retain action-specific checks at the boundary. */
export const tvControlSchema = z
  .object({
    ...common,
    action: z.enum(["inspect", "unionVision", "camera", "calibrate", "perspective"]),
    camera: camera.optional(),
    calibration: z
      .object({
        measuredPixels: z.number().finite().min(1).max(10000),
        measuredInches: z.number().finite().min(0.01).max(200),
        gridInches: z.number().finite().min(0.1).max(10),
        rulerConfirmed: z.literal(true),
      })
      .strict()
      .optional(),
    perspective: z.literal("native-top-down").optional(),
    expectedState: cameraState.optional(),
    idempotencyKey: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/)
      .optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    const parsed = tvActionSchema.safeParse(input);
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
  });
export const tvCommandResultSchema = z
  .object({
    version: z.literal(TV_CONTROL_VERSION),
    worldId: id,
    tvUserId: id,
    tvClientId: id,
    action: z.enum(["inspect", "unionVision", "camera", "calibrate", "perspective"]),
    camera: cameraState,
    vision: z
      .object({
        mode: z.literal("native-pc-union"),
        status: z.enum(["verified", "blocked"]),
        blockedReason: z.string().min(1).max(1024).nullable(),
        sourceCount: z.number().int().min(0).max(1000),
        nativeWallsFogDetection: z.literal(true),
        permissionsChanged: z.literal(false),
      })
      .strict(),
    perspective: z.literal("native-top-down"),
    calibration: z
      .object({ physicalVerified: z.literal(false), rulerAcceptanceRequired: z.literal(true) })
      .strict(),
    replayed: z.boolean(),
  })
  .strict()
  .refine(
    (result) =>
      result.vision.status === "verified"
        ? result.vision.sourceCount > 0 && result.vision.blockedReason === null
        : result.vision.sourceCount === 0 && result.vision.blockedReason !== null,
    "Vision status must match native verification",
  );
export const tvControlExecutionResultSchema = tvCommandResultSchema.safeExtend({
  requestingUserId: id,
  auditCorrelationId: z.string().uuid(),
  executingClient: z.object({ clientId: id, userId: id, lane: z.literal("tv") }).strict(),
});

export const gmTvEndpointDescriptors: AnyEndpointDescriptor[] = [
  {
    name: "foundry_tv_control",
    description:
      "Inspects or applies native camera, zoom, top-down perspective, PC union vision or ruler-based physical calibration on one exact authenticated opted-in TV client. Never broadcasts, grants permissions or uses GM vision. Missing native OBSERVER sources block applies. Physical-inch proof remains a later human ruler acceptance.",
    method: "post",
    path: "/tv/control",
    inputSchema: tvControlSchema,
    outputSchema: tvControlExecutionResultSchema,
    handler: async (
      rawInput: TvControlInput,
      { foundryClient },
    ): Promise<TvControlExecutionResult> => {
      const parsedInput = tvControlSchema.safeParse(rawInput);
      if (!parsedInput.success)
        throw new FoundryBridgeError(
          "INVALID_PAYLOAD",
          "Invalid or unscoped TV control parameters.",
        );
      const input = parsedInput.data;
      const auditCorrelationId = randomUUID();
      const clients = foundryClient.getCapabilityReport().clients;
      const requesters = clients.filter(
        (c) => c.userId === input.requestingUserId && c.lane === "gm" && c.isGM && c.optedIn,
      );
      const requester = requesters.length === 1 ? requesters[0] : undefined;
      const tv = clients.find(
        (c) => c.clientId === input.tvClientId && c.userId === input.tvUserId,
      );
      const revalidateConnection = () => {
        const now = foundryClient.getCapabilityReport().clients;
        const liveRequester = now.find(
          (c) =>
            c.clientId === requester?.clientId &&
            c.userId === requester.userId &&
            c.connectedAt === requester.connectedAt &&
            c.lane === "gm" &&
            c.isGM &&
            c.optedIn,
        );
        const liveTv = now.find(
          (c) =>
            c.clientId === tv?.clientId &&
            c.userId === tv.userId &&
            c.connectedAt === tv.connectedAt &&
            c.lane === "tv" &&
            !c.isGM &&
            c.optedIn &&
            c.capabilities.includes(GM_TV_COMMANDS.EXECUTE),
        );
        if (!liveRequester || !liveTv)
          throw new FoundryBridgeError(
            "PERMISSION_DENIED",
            "The exact authenticated requester or TV connection changed during execution; inspect after reenrollment.",
          );
      };
      let dispatched = false;
      const nativeAuthority = async () => {
        if (
          !requester ||
          !requester.capabilities.includes("status") ||
          !requester.capabilities.includes("user")
        )
          throw new FoundryBridgeError(
            "PERMISSION_DENIED",
            "An exact native GM authority probe is unavailable.",
          );
        const options = {
          clientId: requester.clientId,
          userId: requester.userId,
          lane: "gm" as const,
          requestingUserId: requester.userId,
          correlationId: auditCorrelationId,
        };
        const [status, user] = await Promise.all([
          foundryClient.call<undefined, { worldId: string; userId: string }>(
            "status",
            undefined,
            options,
          ),
          foundryClient.call<undefined, { isGM: boolean; active: boolean }>(
            "user",
            undefined,
            options,
          ),
        ]);
        if (
          status?.worldId !== input.worldId ||
          status.userId !== input.requestingUserId ||
          user?.isGM !== true ||
          user.active !== true
        )
          throw new FoundryBridgeError(
            "PERMISSION_DENIED",
            "The exact current native GM requester/world is unavailable.",
          );
        revalidateConnection();
      };
      try {
        if (!requester)
          throw new FoundryBridgeError(
            "NOT_CONNECTED",
            "One exact authenticated opted-in GM requester is required; resolve duplicate GM tabs.",
          );
        if (!tv)
          throw new FoundryBridgeError(
            "NOT_CONNECTED",
            "The exact TV client is disconnected. No alternate client will receive this action.",
          );
        if (
          tv.lane !== "tv" ||
          tv.isGM ||
          !tv.optedIn ||
          !tv.capabilities.includes(GM_TV_COMMANDS.EXECUTE)
        )
          throw new FoundryBridgeError(
            "PERMISSION_DENIED",
            "The exact client is not an enrolled consenting TV command lane.",
          );
        const routed: TvControlCommandInput = { ...input, requestingUserId: requester.userId };
        await nativeAuthority();
        dispatched = true;
        const raw = await foundryClient.call(GM_TV_COMMANDS.EXECUTE, routed, {
          clientId: tv.clientId,
          userId: tv.userId,
          lane: "tv",
          requestingUserId: requester.userId,
          correlationId: auditCorrelationId,
          requireDurableAudit: true,
          suppressCompletionAudit: true,
          auditOperation: input.action,
        });
        const parsed = tvCommandResultSchema.safeParse(raw);
        if (
          !parsed.success ||
          parsed.data.worldId !== input.worldId ||
          parsed.data.tvClientId !== input.tvClientId ||
          parsed.data.tvUserId !== input.tvUserId ||
          parsed.data.action !== input.action ||
          parsed.data.camera.sceneId !== input.sceneId ||
          (input.action !== "inspect" && parsed.data.vision.status !== "verified") ||
          (input.action === "camera" &&
            (Math.abs(parsed.data.camera.x - input.camera!.x) > 0.001 ||
              Math.abs(parsed.data.camera.y - input.camera!.y) > 0.001 ||
              Math.abs(parsed.data.camera.scale - input.camera!.scale) > 0.000001))
        )
          throw new FoundryBridgeError(
            "INCOMPLETE_RESULT",
            "TV returned an invalid, mismatched or unverified receipt. Inspect this exact TV before retrying.",
          );
        await nativeAuthority();
        await foundryClient.recordAudit({
          timestamp: new Date().toISOString(),
          correlationId: auditCorrelationId,
          command: GM_TV_COMMANDS.EXECUTE,
          requestingUserId: requester.userId,
          effectiveUserId: tv.userId,
          executingClientId: tv.clientId,
          outcome: "succeeded",
          operation: input.action,
          mutationIds: [],
          permissionDecision: { allowed: true, requiredPermission: "TV_CLIENT_CONSENT" },
        });
        revalidateConnection();
        return {
          ...parsed.data,
          requestingUserId: requester.userId,
          auditCorrelationId,
          executingClient: { clientId: tv.clientId, userId: tv.userId, lane: "tv" },
        };
      } catch (error) {
        const e =
          error instanceof FoundryBridgeError
            ? error
            : new FoundryBridgeError("HANDLER_ERROR", "TV control failed unexpectedly.");
        await foundryClient.recordAudit({
          timestamp: new Date().toISOString(),
          correlationId: auditCorrelationId,
          command: GM_TV_COMMANDS.EXECUTE,
          requestingUserId: requester?.userId ?? null,
          effectiveUserId: input.tvUserId,
          executingClientId: dispatched ? input.tvClientId : null,
          outcome: "failed",
          operation: input.action,
          mutationIds: [],
          errorCode: e.code,
          permissionDecision: { allowed: false, reason: e.code },
        });
        throw new FoundryBridgeError(e.code, e.message, {
          correlationId: auditCorrelationId,
          retryable: false,
          details: {
            localViewMayHaveChanged: dispatched && input.action !== "inspect",
            recovery:
              "Inspect the exact TV client before retrying; never broadcast or choose another client.",
          },
        });
      }
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];
