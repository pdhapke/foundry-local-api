import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  EFFECTIVE_USER_COMMANDS,
  type EffectiveUserCommandInput,
  type EffectiveUserCommandResult,
  type EffectiveUserExecuteInput,
  type EffectiveUserExecutionResult,
} from "@foundry-local-api/shared";

import { FoundryBridgeError } from "../bridge/errors.js";
import type { AnyEndpointDescriptor } from "./types.js";

const id = z.string().min(1).max(128);

const operationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("inspectActorControl"),
      actorId: id,
    })
    .strict(),
  z
    .object({
      kind: z.literal("applyActorOwnerProbe"),
      actorId: id,
      testRunId: z
        .string()
        .regex(/^test-[A-Za-z0-9][A-Za-z0-9._-]+$/)
        .max(128),
      probeValue: z.string().max(128).nullable(),
      expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal("readJournalContent"),
      journalEntryId: id,
      pageId: id.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("inspectSceneToken"),
      sceneId: id,
      tokenId: id,
    })
    .strict(),
  z
    .object({
      kind: z.literal("inspectNoteAccess"),
      sceneId: id,
      noteId: id,
    })
    .strict(),
]);

export const effectiveUserExecuteSchema = z
  .object({
    effectiveUserId: id,
    operation: operationSchema,
  })
  .strict();

const operationDataSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("actorControl"),
    actorId: id,
    name: z.string().nullable(),
    canObserve: z.literal(true),
    canControl: z.literal(true),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({
    kind: z.literal("actorOwnerProbe"),
    actorId: id,
    testRunId: z
      .string()
      .regex(/^test-[A-Za-z0-9][A-Za-z0-9._-]+$/)
      .max(128),
    beforeValue: z.string().max(128).nullable(),
    afterValue: z.string().max(128).nullable(),
    beforeRevision: z.string().regex(/^[a-f0-9]{64}$/),
    afterRevision: z.string().regex(/^[a-f0-9]{64}$/),
    readbackVerified: z.literal(true),
  }),
  z.object({
    kind: z.literal("journalContent"),
    journalEntryId: id,
    name: z.string().nullable(),
    pages: z
      .array(
        z.object({
          pageId: id,
          name: z.string().nullable(),
          type: z.string().nullable(),
          textFormat: z.number().int().nullable(),
          content: z.string().max(32_768),
          truncated: z.boolean(),
        }),
      )
      .max(100),
  }),
  z.object({
    kind: z.literal("sceneToken"),
    sceneId: id,
    tokenId: id,
    name: z.string().nullable(),
    actorId: id.nullable(),
    canObserve: z.literal(true),
    canControl: z.boolean(),
    hidden: z.literal(false),
    position: z.object({ x: z.number(), y: z.number(), elevation: z.number() }),
    vision: z.object({
      enabled: z.boolean(),
      range: z.number().nullable(),
      angle: z.number().nullable(),
      mode: z.string().nullable(),
    }),
  }),
  z.object({
    kind: z.literal("noteAccess"),
    sceneId: id,
    noteId: id,
    journalEntryId: id.nullable(),
    pageId: id.nullable(),
    canObserve: z.literal(true),
    hidden: z.literal(false),
    position: z.object({ x: z.number(), y: z.number() }),
  }),
]);

const commandResultSchema = z.object({
  effectiveUserId: id,
  operation: z.enum([
    "inspectActorControl",
    "applyActorOwnerProbe",
    "readJournalContent",
    "inspectSceneToken",
    "inspectNoteAccess",
  ]),
  permissionDecision: z.object({
    allowed: z.literal(true),
    requiredPermission: z.enum(["OBSERVER", "OWNER"]),
  }),
  mutationIds: z.array(id).max(1),
  data: operationDataSchema,
});

export const effectiveUserEndpointDescriptors: AnyEndpointDescriptor[] = [
  {
    name: "foundry_execute_as_user",
    description:
      "Executes one audited, allowlisted operation on the explicitly opted-in non-GM player client for the named user. Supports read-only permission inspection plus a revision-guarded, fixture-only Actor owner probe with independent readback; it never accepts arbitrary commands or JavaScript.",
    method: "post",
    path: "/effective-users/execute",
    inputSchema: effectiveUserExecuteSchema,
    handler: async (
      input: EffectiveUserExecuteInput,
      { foundryClient },
    ): Promise<EffectiveUserExecutionResult> => {
      const auditCorrelationId = randomUUID();
      let executingClientId: string | null = null;
      let authenticatedRequestingUserId: string | null = null;
      try {
        const negotiatedClients = foundryClient.getCapabilityReport().clients;
        const requestingClient = negotiatedClients
          .filter((client) => client.lane === "gm" && client.isGM && client.optedIn)
          .sort(
            (left, right) =>
              left.connectedAt - right.connectedAt || left.clientId.localeCompare(right.clientId),
          )[0];
        if (!requestingClient) {
          throw new FoundryBridgeError(
            "NOT_CONNECTED",
            "No opted-in GM command lane is connected to authenticate the requester.",
            { retryable: true },
          );
        }
        authenticatedRequestingUserId = requestingClient.userId;
        const clients = negotiatedClients.filter(
          (client) => client.userId === input.effectiveUserId,
        );
        if (clients.length === 0) {
          throw new FoundryBridgeError(
            "NOT_CONNECTED",
            "No Foundry client is connected for the requested effective user.",
            { retryable: true, details: { effectiveUserId: input.effectiveUserId } },
          );
        }
        if (clients.some((client) => client.isGM)) {
          throw new FoundryBridgeError(
            "PERMISSION_DENIED",
            "GM escalation is not permitted through effective-user execution.",
          );
        }
        const playerClients = clients.filter((client) => client.lane === "player");
        if (playerClients.length === 0) {
          throw new FoundryBridgeError(
            "PERMISSION_DENIED",
            "The requested effective user has no connected player-lane client.",
          );
        }
        const optedInClients = playerClients.filter((client) => client.optedIn);
        if (optedInClients.length === 0) {
          throw new FoundryBridgeError(
            "PERMISSION_DENIED",
            "The requested player client has not opted in to bounded remote control.",
          );
        }
        const executingClient = [...optedInClients].sort(
          (left, right) =>
            right.connectedAt - left.connectedAt || left.clientId.localeCompare(right.clientId),
        )[0];
        if (!executingClient) {
          throw new FoundryBridgeError("NOT_CONNECTED", "No opted-in player client is available.", {
            retryable: true,
          });
        }
        executingClientId = executingClient.clientId;
        if (!executingClient.capabilities.includes(EFFECTIVE_USER_COMMANDS.EXECUTE)) {
          throw new FoundryBridgeError(
            "UNSUPPORTED_TYPE",
            "The selected player client does not advertise bounded effective-user execution.",
            { retryable: false },
          );
        }

        const routedInput: EffectiveUserCommandInput = {
          ...input,
          requestingUserId: requestingClient.userId,
        };
        const rawResult = await foundryClient.call<
          EffectiveUserCommandInput,
          EffectiveUserCommandResult
        >(EFFECTIVE_USER_COMMANDS.EXECUTE, routedInput, {
          clientId: executingClient.clientId,
          userId: input.effectiveUserId,
          lane: "player",
          requestingUserId: requestingClient.userId,
          correlationId: auditCorrelationId,
          requireDurableAudit: true,
          suppressCompletionAudit: true,
          auditOperation: input.operation.kind,
        });
        const parsed = commandResultSchema.safeParse(rawResult);
        if (
          !parsed.success ||
          parsed.data.effectiveUserId !== input.effectiveUserId ||
          parsed.data.operation !== input.operation.kind ||
          parsed.data.permissionDecision.requiredPermission !==
            (input.operation.kind === "inspectActorControl" ||
            input.operation.kind === "applyActorOwnerProbe"
              ? "OWNER"
              : "OBSERVER")
        ) {
          throw new FoundryBridgeError(
            "INCOMPLETE_RESULT",
            "The player client returned an invalid or mismatched effective-user result.",
            { retryable: false, correlationId: auditCorrelationId },
          );
        }

        const result: EffectiveUserExecutionResult = {
          effectiveUserId: parsed.data.effectiveUserId,
          operation: parsed.data.operation,
          permissionDecision: parsed.data.permissionDecision,
          mutationIds: parsed.data.mutationIds,
          data: parsed.data.data,
          requestingUserId: requestingClient.userId,
          executingClient: {
            clientId: executingClient.clientId,
            lane: "player",
            foundryVersion: executingClient.foundryVersion,
            systemId: executingClient.systemId,
            systemVersion: executingClient.systemVersion,
            moduleVersion: executingClient.moduleVersion,
          },
          auditCorrelationId,
        };
        await foundryClient.recordAudit({
          timestamp: new Date().toISOString(),
          correlationId: auditCorrelationId,
          command: EFFECTIVE_USER_COMMANDS.EXECUTE,
          requestingUserId: requestingClient.userId,
          effectiveUserId: input.effectiveUserId,
          executingClientId: executingClient.clientId,
          outcome: "succeeded",
          operation: input.operation.kind,
          permissionDecision: parsed.data.permissionDecision,
          mutationIds: parsed.data.mutationIds,
        });
        return result;
      } catch (error) {
        const bridgeError =
          error instanceof FoundryBridgeError
            ? new FoundryBridgeError(error.code, error.message, {
                retryable: error.retryable,
                fieldPath: error.fieldPath,
                correlationId: auditCorrelationId,
                details: error.details,
              })
            : new FoundryBridgeError(
                "HANDLER_ERROR",
                "Effective-user execution failed unexpectedly.",
                { correlationId: auditCorrelationId },
              );
        await foundryClient.recordAudit({
          timestamp: new Date().toISOString(),
          correlationId: auditCorrelationId,
          command: EFFECTIVE_USER_COMMANDS.EXECUTE,
          requestingUserId: authenticatedRequestingUserId,
          effectiveUserId: input.effectiveUserId,
          executingClientId,
          outcome: "failed",
          operation: input.operation.kind,
          permissionDecision: {
            allowed: false,
            requiredPermission:
              input.operation.kind === "inspectActorControl" ||
              input.operation.kind === "applyActorOwnerProbe"
                ? "OWNER"
                : "OBSERVER",
            reason: bridgeError.code,
          },
          mutationIds: [],
          errorCode: bridgeError.code,
        });
        throw bridgeError;
      }
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
];
