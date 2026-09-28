import { z } from "zod";
import { EMBEDDED_CHILD_COMMANDS, ProtocolError } from "@foundry-local-api/shared";
import { FoundryBridgeError } from "../bridge/errors.js";
import {
  embeddedListOutputSchema,
  embeddedMutationOutputSchema,
  embeddedReadOutputSchema,
} from "./requirement-output-schemas.js";
import type { AnyEndpointDescriptor } from "./types.js";

const family = z.enum(["Tile", "RegionBehavior", "PlaylistSound", "TableResult", "Card"]);
const parent = {
  family,
  parentId: z.string().min(1).max(128),
  sceneId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe("Required when family is RegionBehavior; omit for other embedded families."),
};
const identifier = { ...parent, childId: z.string().min(1).max(128) };
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const key = z.string().min(8).max(200);
function requireRegionSceneId<T extends z.ZodType>(schema: T): T {
  return schema.superRefine((input, context) => {
    const value = input as { family?: unknown; sceneId?: unknown };
    if (value.family === "RegionBehavior" && typeof value.sceneId !== "string") {
      context.addIssue({
        code: "custom",
        path: ["sceneId"],
        message: "RegionBehavior operations require sceneId.",
      });
    }
  }) as T;
}

const schemas = {
  list: requireRegionSceneId(z.object(parent).strict()),
  get: requireRegionSceneId(z.object(identifier).strict()),
  create: requireRegionSceneId(
    z
      .object({
        ...parent,
        expectedParentRevision: revision,
        idempotencyKey: key,
        dryRun: z.boolean().optional(),
        data: z.record(z.string(), z.unknown()).and(z.object({ _id: z.string().min(1).max(128) })),
      })
      .strict(),
  ),
  update: requireRegionSceneId(
    z
      .object({
        ...identifier,
        expectedParentRevision: revision,
        expectedChildRevision: revision,
        idempotencyKey: key,
        dryRun: z.boolean().optional(),
        changes: z.record(z.string(), z.unknown()),
      })
      .strict(),
  ),
  delete: requireRegionSceneId(
    z
      .object({
        ...identifier,
        expectedParentRevision: revision,
        expectedChildRevision: revision,
        idempotencyKey: key,
        dryRun: z.boolean().optional(),
      })
      .strict(),
  ),
};
const operations = [
  ["list", EMBEDDED_CHILD_COMMANDS.LIST, true],
  ["get", EMBEDDED_CHILD_COMMANDS.GET, true],
  ["create", EMBEDDED_CHILD_COMMANDS.CREATE, false],
  ["update", EMBEDDED_CHILD_COMMANDS.UPDATE, false],
  ["delete", EMBEDDED_CHILD_COMMANDS.DELETE, false],
] as const;
const DEFINITELY_PRECOMMIT_CODES = new Set([
  "INVALID_PAYLOAD",
  "PERMISSION_DENIED",
  "NOT_FOUND",
  "STALE_REVISION",
  "UNSUPPORTED_VERSION",
  "UNSUPPORTED_TYPE",
  "IDEMPOTENCY_CONFLICT",
]);
export const embeddedChildrenEndpointDescriptors: AnyEndpointDescriptor[] = operations.map(
  ([operation, command, readOnly]) => ({
    name: `foundry_${operation}_embedded_child`,
    description: `${operation} one Tile, RegionBehavior, PlaylistSound, TableResult, or Card using its Foundry embedded-document API. Mutations use parent/child semantic revisions and preserve unrelated siblings.`,
    method:
      operation === "get" || operation === "list"
        ? "get"
        : operation === "delete"
          ? "delete"
          : "post",
    path: `/embedded-children/${operation}`,
    inputSchema: schemas[operation],
    outputSchema:
      operation === "list"
        ? embeddedListOutputSchema
        : operation === "get"
          ? embeddedReadOutputSchema
          : embeddedMutationOutputSchema,
    handler: async (input, { foundryClient, foundations }) => {
      const execute = () =>
        foundryClient.call(command, input, {
          ...(readOnly
            ? {}
            : {
                correlationId: input.idempotencyKey,
                requireDurableAudit: true,
                auditOperation: `embedded-${operation}`,
              }),
        });
      if (readOnly || input.dryRun === true || !foundations) return execute();
      const storeKey = `embedded:${operation}:${input.idempotencyKey}`;
      let stored;
      try {
        stored = await foundations.idempotency.execute(storeKey, input, execute);
      } catch (error) {
        if (error instanceof FoundryBridgeError) {
          const verifiedRolledBack =
            error.details?.["compensationVerified"] === true &&
            error.details["persistentPartialSuccess"] === false;
          if (verifiedRolledBack || DEFINITELY_PRECOMMIT_CODES.has(error.code)) {
            try {
              foundations.idempotency.resolvePendingAsRolledBack(storeKey, input);
            } catch (rollbackResolutionError) {
              // A store-level idempotency conflict means the durable marker
              // belongs to a different input. Preserve it and surface the
              // original operation error rather than clearing another call's state.
              if (
                !(rollbackResolutionError instanceof ProtocolError) ||
                rollbackResolutionError.code !== "IDEMPOTENCY_CONFLICT"
              ) {
                throw rollbackResolutionError;
              }
            }
          }
        }
        throw error;
      }
      return {
        ...(stored.result as Record<string, unknown>),
        replayed:
          stored.replayed ||
          (stored.result as { replayed?: boolean | undefined }).replayed === true,
      };
    },
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: operation === "delete",
      idempotentHint: true,
    },
  }),
);
