import { z } from "zod";
import {
  CLIENT_READINESS_COMMANDS,
  type ClientPreloadInput,
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
];
