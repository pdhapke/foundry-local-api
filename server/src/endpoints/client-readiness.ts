import { z } from "zod";
import {
  CLIENT_READINESS_COMMANDS,
  type ClientPreloadInput,
  type ClientIdentityAdoptionInput,
  type ClientIdentityAdoptionCommandInput,
  type ClientEnrolledIdentityAdoptionInput,
  type ClientEnrolledIdentityAdoptionCommandInput,
  type ClientIdentityAdoptionResult,
  type ClientReloadInput,
  type ClientReloadResult,
  type ClientReadinessInput,
  type ClientReadinessResult,
  type ClientViewportInput,
  type ConnectedBridgeClient,
} from "@foundry-local-api/shared";
import { FoundryBridgeError } from "../bridge/errors.js";
import type { AnyEndpointDescriptor, EndpointContext } from "./types.js";

const id = z.string().min(1).max(128);
const correlationId = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]+$/);
const target = { clientId: id.optional(), userId: id.optional() };
const base = z
  .object({
    ...target,
    correlationId,
    minimumModuleVersion: z.string().max(32).optional(),
  })
  .strict();
const preloadSchema = z
  .object({
    ...target,
    correlationId,
    minimumModuleVersion: z.string().max(32).optional(),
    sceneId: id,
    assetPaths: z.array(z.string().min(1).max(2048)).max(200),
    timeoutMs: z.number().int().min(100).max(60_000),
  })
  .strict();
const viewportSchema = z
  .object({
    ...target,
    correlationId,
    minimumModuleVersion: z.string().max(32).optional(),
    sceneId: id,
    viewScene: z.boolean().optional(),
    digitalTabletop: z.boolean().optional(),
    viewport: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        scale: z.number().positive().max(10),
      })
      .strict(),
    timeoutMs: z.number().int().min(100).max(60_000).optional(),
  })
  .strict();
const reloadSchema = z
  .object({
    ...target,
    correlationId,
    minimumModuleVersion: z.string().max(32).optional(),
    delayMs: z.number().int().min(500).max(5_000).default(1_000),
  })
  .strict();
const uuid = z.string().uuid();
const identityAdoptionSchema = z
  .object({
    correlationId,
    expectedClientId: uuid,
    desiredClientId: uuid,
    timeoutMs: z.number().int().min(250).max(10_000).default(5_000),
  })
  .strict()
  .refine((value) => value.expectedClientId !== value.desiredClientId, {
    message: "desiredClientId must differ from expectedClientId",
    path: ["desiredClientId"],
  });
const identityAdoptionOutputSchema = z
  .object({
    correlationId,
    acknowledged: z.literal(true),
    replayed: z.boolean(),
    acknowledgedAt: z.string().min(1).max(128),
    clientUserId: id,
    executingClientId: uuid,
    adoptedClientId: uuid,
    reloadRequired: z.literal(true),
  })
  .strict();
const enrolledIdentityAdoptionSchema = identityAdoptionSchema.safeExtend({
  expectedUserId: id,
  expectedLane: z.enum(["player", "tv"]),
});
const reloadAcknowledgementSchema = z
  .object({
    correlationId,
    acknowledged: z.literal(true),
    replayed: z.boolean(),
    acknowledgedAt: z.string().min(1).max(128),
    clientUserId: id,
    executingClientId: id,
    reloadScheduled: z.literal(true),
    reloadAfterMs: z.number().int().min(500).max(5_000),
  })
  .strict();
const acknowledgementSchema = z
  .object({
    correlationId,
    acknowledged: z.literal(true),
    replayed: z.boolean(),
    acknowledgedAt: z.string().min(1).max(128),
    clientUserId: id,
    executingClientId: id,
    expectedSceneId: id.nullable(),
    activeSceneId: id.nullable(),
    scenePreloaded: z.boolean(),
    activeSceneMatches: z.boolean(),
    sceneReady: z.boolean(),
    display: z.object({ cssWidth: z.number().int().min(0).max(16384), cssHeight: z.number().int().min(0).max(16384),
      devicePixelRatio: z.number().positive().max(8), canvasReady: z.boolean(), fullscreen: z.boolean().optional(),
      windowWidth: z.number().positive().max(16384).optional(), windowHeight: z.number().positive().max(16384).optional(),
      screenWidth: z.number().positive().max(16384).optional(), screenHeight: z.number().positive().max(16384).optional(), visualScale: z.number().positive().optional() }).strict().optional(),
    assets: z
      .array(
        z
          .object({
            path: z.string().min(1).max(2048),
            status: z.enum(["loaded", "failed"]),
            error: z.string().max(200).optional(),
          })
          .strict(),
      )
      .max(200),
    viewport: z
      .object({ x: z.number().finite(), y: z.number().finite(), scale: z.number().positive() })
      .strict()
      .nullable(),
    applied: z.object({ preload: z.boolean(), viewport: z.boolean() }).strict(),
    warnings: z.array(z.string().max(500)).max(100),
    incomplete: z.boolean(),
  })
  .strict();

type TargetRequest = {
  clientId?: string;
  userId?: string;
  minimumModuleVersion?: string;
};
type Envelope = ClientReadinessResult & {
  client: Pick<
    ConnectedBridgeClient,
    | "clientId"
    | "userId"
    | "lane"
    | "isGM"
    | "foundryVersion"
    | "systemId"
    | "systemVersion"
    | "moduleVersion"
  >;
};

function versionAtLeast(actual: string, minimum: string): boolean {
  const a = actual.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = minimum.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

function route(input: TargetRequest, ctx: EndpointContext, requiredCommand: string) {
  const clients = ctx.foundryClient.getCapabilityReport().clients;
  const requester = clients
    .filter((client) => client.lane === "gm" && client.isGM && client.optedIn)
    .sort((a, b) => a.connectedAt - b.connectedAt)[0];
  if (!requester)
    throw new FoundryBridgeError("NOT_CONNECTED", "No opted-in GM command lane is connected.", {
      retryable: true,
    });
  if (!input.clientId && !input.userId)
    throw new FoundryBridgeError("INVALID_PAYLOAD", "clientId or userId is required.", {
      fieldPath: "clientId",
    });
  const matching = clients.filter(
    (client) =>
      (!input.clientId || client.clientId === input.clientId) &&
      (!input.userId || client.userId === input.userId),
  );
  if (matching.length > 0 && matching.every((client) => !client.optedIn))
    throw new FoundryBridgeError(
      "PERMISSION_DENIED",
      "The requested client has not opted into remote client commands.",
    );
  const selected = matching
    .filter((client) => client.optedIn)
    .sort((a, b) => b.connectedAt - a.connectedAt)[0];
  if (!selected)
    throw new FoundryBridgeError(
      "NOT_CONNECTED",
      "The requested client is disconnected or has not opted in.",
      { retryable: true },
    );
  if (
    input.minimumModuleVersion &&
    !versionAtLeast(selected.moduleVersion, input.minimumModuleVersion)
  )
    throw new FoundryBridgeError(
      "UNSUPPORTED_VERSION",
      "The selected client module version is below the requested minimum.",
    );
  if (!selected.capabilities.includes(requiredCommand))
    throw new FoundryBridgeError(
      "UNSUPPORTED_VERSION",
      `The selected client does not advertise ${requiredCommand}.`,
    );
  return { requester, selected };
}

function envelope(
  client: ConnectedBridgeClient,
  correlation: string,
  value: ClientReadinessResult,
): Envelope {
  const parsed = acknowledgementSchema.safeParse(value);
  if (!parsed.success)
    throw new FoundryBridgeError(
      "INCOMPLETE_RESULT",
      "The selected client returned an invalid readiness acknowledgement.",
      { details: { issues: parsed.error.issues.map(({ path, code }) => ({ path, code })) } },
    );
  if (
    parsed.data.correlationId !== correlation ||
    parsed.data.clientUserId !== client.userId ||
    parsed.data.executingClientId !== client.clientId
  )
    throw new FoundryBridgeError(
      "INCOMPLETE_RESULT",
      "The readiness acknowledgement identity or correlation did not match the selected client.",
    );
  if (parsed.data.sceneReady && !parsed.data.activeSceneMatches)
    throw new FoundryBridgeError(
      "INCOMPLETE_RESULT",
      "The client reported a Scene ready while a different Scene was active.",
    );
  return {
    ...parsed.data,
    client: {
      clientId: client.clientId,
      userId: client.userId,
      lane: client.lane,
      isGM: client.isGM,
      foundryVersion: client.foundryVersion,
      systemId: client.systemId,
      systemVersion: client.systemVersion,
      moduleVersion: client.moduleVersion,
    },
  };
}

function assertPreloadReadback(input: ClientPreloadInput, value: Envelope): void {
  const requested = [...input.assetPaths].sort();
  const observed = value.assets.map(({ path }) => path).sort();
  if (
    value.expectedSceneId !== input.sceneId ||
    !value.scenePreloaded ||
    !value.applied.preload ||
    requested.length !== observed.length ||
    requested.some((path, index) => path !== observed[index])
  )
    throw new FoundryBridgeError(
      "INCOMPLETE_RESULT",
      "The preload acknowledgement did not match the requested Scene and exact asset manifest.",
    );
}

function assertViewportReadback(input: ClientViewportInput, value: Envelope): void {
  const actual = value.viewport;
  if (
    value.expectedSceneId !== input.sceneId ||
    !value.activeSceneMatches ||
    !value.applied.viewport ||
    !actual ||
    Math.abs(actual.x - input.viewport.x) > 0.01 ||
    Math.abs(actual.y - input.viewport.y) > 0.01 ||
    Math.abs(actual.scale - input.viewport.scale) > 0.001
  )
    throw new FoundryBridgeError(
      "INCOMPLETE_RESULT",
      "The viewport acknowledgement did not match the requested Scene and applied values.",
    );
}

export const clientReadinessEndpointDescriptors: AnyEndpointDescriptor[] = [
  {
    name: "foundry_preload_scene",
    description:
      "Preloads an exact bounded asset manifest on one opted-in client and returns receiver acknowledgement with per-asset success/failure; dispatch without acknowledgement is never success.",
    method: "post",
    path: "/clients/preload-scene",
    inputSchema: preloadSchema,
    handler: async (input: TargetRequest & ClientPreloadInput, ctx): Promise<Envelope> => {
      const { requester, selected } = route(input, ctx, CLIENT_READINESS_COMMANDS.PRELOAD);
      const value = await ctx.foundryClient.call<ClientPreloadInput, ClientReadinessResult>(
        CLIENT_READINESS_COMMANDS.PRELOAD,
        {
          sceneId: input.sceneId,
          assetPaths: input.assetPaths,
          correlationId: input.correlationId,
          timeoutMs: input.timeoutMs,
        },
        {
          clientId: selected.clientId,
          requestingUserId: requester.userId,
          correlationId: input.correlationId,
          timeoutMs: input.timeoutMs + 500,
        },
      );
      const result = envelope(selected, input.correlationId, value);
      assertPreloadReadback(input, result);
      return result;
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "foundry_get_client_readiness",
    description:
      "Queries one opted-in receiver's active Scene, asset cache, viewport, and negotiated versions with an actual correlated acknowledgement.",
    method: "post",
    path: "/clients/readiness",
    inputSchema: base,
    handler: async (input: TargetRequest & ClientReadinessInput, ctx): Promise<Envelope> => {
      const { requester, selected } = route(input, ctx, CLIENT_READINESS_COMMANDS.GET);
      const value = await ctx.foundryClient.call<ClientReadinessInput, ClientReadinessResult>(
        CLIENT_READINESS_COMMANDS.GET,
        { correlationId: input.correlationId },
        {
          clientId: selected.clientId,
          requestingUserId: requester.userId,
          correlationId: input.correlationId,
        },
      );
      return envelope(selected, input.correlationId, value);
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: "foundry_apply_client_viewport",
    description:
      "Applies and reads back a viewport on one opted-in receiver. Correlation replay returns the original acknowledgement without applying the command twice.",
    method: "post",
    path: "/clients/apply-viewport",
    inputSchema: viewportSchema,
    handler: async (
      input: TargetRequest & ClientViewportInput & { timeoutMs?: number },
      ctx,
    ): Promise<Envelope> => {
      const { requester, selected } = route(input, ctx, CLIENT_READINESS_COMMANDS.APPLY_VIEWPORT);
      const payload: ClientViewportInput = {
        correlationId: input.correlationId,
        sceneId: input.sceneId,
        viewport: input.viewport,
        ...(input.viewScene !== undefined ? { viewScene: input.viewScene } : {}),
        ...(input.digitalTabletop !== undefined ? { digitalTabletop: input.digitalTabletop } : {}),
      };
      const value = await ctx.foundryClient.call<ClientViewportInput, ClientReadinessResult>(
        CLIENT_READINESS_COMMANDS.APPLY_VIEWPORT,
        payload,
        {
          clientId: selected.clientId,
          requestingUserId: requester.userId,
          correlationId: input.correlationId,
          timeoutMs: input.timeoutMs ?? 5_000,
        },
      );
      const result = envelope(selected, input.correlationId, value);
      assertViewportReadback(payload, result);
      return result;
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "foundry_reload_client",
    description:
      "Schedules a browser-page reload on one connected, opted-in Foundry client after returning an identity-bound acknowledgement. Success confirms scheduling only; callers must verify reconnection and re-enroll non-GM lanes.",
    method: "post",
    path: "/clients/reload",
    inputSchema: reloadSchema,
    handler: async (
      input: TargetRequest & ClientReloadInput,
      ctx,
    ): Promise<ClientReloadResult & { client: Envelope["client"] }> => {
      const { requester, selected } = route(input, ctx, CLIENT_READINESS_COMMANDS.RELOAD);
      const payload: ClientReloadInput = {
        correlationId: input.correlationId,
        delayMs: input.delayMs,
      };
      const value = await ctx.foundryClient.call<ClientReloadInput, ClientReloadResult>(
        CLIENT_READINESS_COMMANDS.RELOAD,
        payload,
        {
          clientId: selected.clientId,
          requestingUserId: requester.userId,
          correlationId: input.correlationId,
          timeoutMs: Math.max(250, input.delayMs - 100),
        },
      );
      const parsed = reloadAcknowledgementSchema.safeParse(value);
      if (
        !parsed.success ||
        parsed.data.correlationId !== input.correlationId ||
        parsed.data.clientUserId !== selected.userId ||
        parsed.data.executingClientId !== selected.clientId ||
        parsed.data.reloadAfterMs !== input.delayMs
      )
        throw new FoundryBridgeError(
          "INCOMPLETE_RESULT",
          "The reload acknowledgement identity, correlation, or delay did not match the selected client.",
        );
      return {
        ...parsed.data,
        client: {
          clientId: selected.clientId,
          userId: selected.userId,
          lane: selected.lane,
          isGM: selected.isGM,
          foundryVersion: selected.foundryVersion,
          systemId: selected.systemId,
          systemVersion: selected.systemVersion,
          moduleVersion: selected.moduleVersion,
        },
      };
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "foundry_adopt_gm_client_identity",
    description:
      "One-time recovery of an absent exact GM client UUID on the currently authenticated exact GM command lane. Refuses connected or reserved target identities, compare-and-set mismatches, changed correlation replay, and non-GM/TV lanes. Persists the identity but never exposes credentials; reload is required before it becomes the negotiated identity.",
    method: "post",
    path: "/clients/adopt-gm-identity",
    inputSchema: identityAdoptionSchema,
    outputSchema: identityAdoptionOutputSchema,
    handler: async (
      input: ClientIdentityAdoptionInput & { timeoutMs: number },
      ctx,
    ): Promise<ClientIdentityAdoptionResult> => {
      const clients = ctx.foundryClient.getCapabilityReport().clients;
      const selected = clients.find(
        (client) =>
          client.clientId === input.expectedClientId &&
          client.lane === "gm" &&
          client.isGM &&
          client.optedIn,
      );
      if (!selected) {
        throw new FoundryBridgeError(
          "NOT_CONNECTED",
          "The expected authenticated GM client is not connected.",
          { retryable: true },
        );
      }
      if (!selected.capabilities.includes(CLIENT_READINESS_COMMANDS.ADOPT_IDENTITY)) {
        throw new FoundryBridgeError(
          "UNSUPPORTED_VERSION",
          "The selected GM client does not advertise identity adoption.",
        );
      }
      if (clients.some((client) => client.clientId === input.desiredClientId)) {
        throw new FoundryBridgeError(
          "IDEMPOTENCY_CONFLICT",
          "The desired client identity is already connected.",
        );
      }
      const identityHandoffProof = ctx.foundryClient.reserveClientIdentity(
        input.desiredClientId,
        input.expectedClientId,
        {
          expectedUserId: selected.userId,
          expectedLane: "gm",
          ttlMs: Math.min(120_000, input.timeoutMs + 60_000),
        },
      );
      if (!identityHandoffProof) {
        throw new FoundryBridgeError(
          "IDEMPOTENCY_CONFLICT",
          "The desired client identity is connected or reserved by another recovery.",
        );
      }
      try {
        const payload: ClientIdentityAdoptionCommandInput = {
          correlationId: input.correlationId,
          expectedClientId: input.expectedClientId,
          desiredClientId: input.desiredClientId,
          identityHandoffProof,
        };
        const value = await ctx.foundryClient.call<
          ClientIdentityAdoptionCommandInput,
          ClientIdentityAdoptionResult
        >(CLIENT_READINESS_COMMANDS.ADOPT_IDENTITY, payload, {
          clientId: selected.clientId,
          userId: selected.userId,
          requestingUserId: selected.userId,
          correlationId: input.correlationId,
          timeoutMs: input.timeoutMs,
          auditPayloadSummary: {
            correlationId: input.correlationId,
            expectedClientId: input.expectedClientId,
            desiredClientId: input.desiredClientId,
          },
        });
        const parsed = identityAdoptionOutputSchema.safeParse(value);
        if (
          !parsed.success ||
          parsed.data.correlationId !== input.correlationId ||
          parsed.data.clientUserId !== selected.userId ||
          parsed.data.executingClientId !== input.expectedClientId ||
          parsed.data.adoptedClientId !== input.desiredClientId
        ) {
          throw new FoundryBridgeError(
            "INCOMPLETE_RESULT",
            "The identity-adoption acknowledgement did not match the selected GM client.",
          );
        }
        return parsed.data;
      } catch (error) {
        ctx.foundryClient.releaseClientIdentity(input.desiredClientId, input.expectedClientId);
        throw error;
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "foundry_adopt_enrolled_client_identity",
    description:
      "One-time recovery of an absent exact UUID for an already enrolled, consenting player or TV client, initiated only through the authenticated GM command lane. Binds the exact client, user, and lane; reserves the target through bounded reconnect; exposes no credentials.",
    method: "post",
    path: "/clients/adopt-enrolled-identity",
    inputSchema: enrolledIdentityAdoptionSchema,
    outputSchema: identityAdoptionOutputSchema,
    handler: async (
      input: ClientEnrolledIdentityAdoptionInput & { timeoutMs: number },
      ctx,
    ): Promise<ClientIdentityAdoptionResult> => {
      const clients = ctx.foundryClient.getCapabilityReport().clients;
      const requester = clients.find(
        (client) => client.lane === "gm" && client.isGM && client.optedIn,
      );
      if (!requester) {
        throw new FoundryBridgeError("NOT_CONNECTED", "No authenticated GM lane is connected.", {
          retryable: true,
        });
      }
      const selected = clients.find(
        (client) =>
          client.clientId === input.expectedClientId &&
          client.userId === input.expectedUserId &&
          client.lane === input.expectedLane &&
          !client.isGM &&
          client.optedIn,
      );
      if (!selected) {
        throw new FoundryBridgeError(
          "NOT_CONNECTED",
          "The exact enrolled player or TV client is not connected with the requested binding.",
          { retryable: true },
        );
      }
      if (!selected.capabilities.includes(CLIENT_READINESS_COMMANDS.ADOPT_ENROLLED_IDENTITY)) {
        throw new FoundryBridgeError(
          "UNSUPPORTED_VERSION",
          "The selected enrolled client does not advertise identity adoption.",
        );
      }
      if (clients.some((client) => client.clientId === input.desiredClientId)) {
        throw new FoundryBridgeError("IDEMPOTENCY_CONFLICT", "The desired identity is connected.");
      }
      const identityHandoffProof = ctx.foundryClient.reserveClientIdentity(
        input.desiredClientId,
        input.expectedClientId,
        {
          expectedUserId: input.expectedUserId,
          expectedLane: input.expectedLane,
          ttlMs: Math.min(120_000, input.timeoutMs + 60_000),
        },
      );
      if (!identityHandoffProof) {
        throw new FoundryBridgeError(
          "IDEMPOTENCY_CONFLICT",
          "The desired identity is connected or reserved.",
        );
      }
      try {
        const payload: ClientEnrolledIdentityAdoptionCommandInput = {
          correlationId: input.correlationId,
          expectedClientId: input.expectedClientId,
          desiredClientId: input.desiredClientId,
          expectedUserId: input.expectedUserId,
          expectedLane: input.expectedLane,
          identityHandoffProof,
        };
        const value = await ctx.foundryClient.call<
          ClientEnrolledIdentityAdoptionCommandInput,
          ClientIdentityAdoptionResult
        >(CLIENT_READINESS_COMMANDS.ADOPT_ENROLLED_IDENTITY, payload, {
          clientId: selected.clientId,
          userId: selected.userId,
          lane: selected.lane,
          requestingUserId: requester.userId,
          correlationId: input.correlationId,
          timeoutMs: input.timeoutMs,
          auditPayloadSummary: {
            correlationId: input.correlationId,
            expectedClientId: input.expectedClientId,
            desiredClientId: input.desiredClientId,
            expectedUserId: input.expectedUserId,
            expectedLane: input.expectedLane,
          },
        });
        const parsed = identityAdoptionOutputSchema.safeParse(value);
        if (
          !parsed.success ||
          parsed.data.correlationId !== input.correlationId ||
          parsed.data.clientUserId !== selected.userId ||
          parsed.data.executingClientId !== input.expectedClientId ||
          parsed.data.adoptedClientId !== input.desiredClientId
        ) {
          throw new FoundryBridgeError(
            "INCOMPLETE_RESULT",
            "The enrolled identity-adoption acknowledgement did not match the exact client binding.",
          );
        }
        return parsed.data;
      } catch (error) {
        ctx.foundryClient.releaseClientIdentity(input.desiredClientId, input.expectedClientId);
        throw error;
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
];
