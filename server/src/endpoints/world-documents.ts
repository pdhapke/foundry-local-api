import { z } from "zod";
import {
  WORLD_DOCUMENT_TYPES,
  WORLD_DOCUMENT_COMMANDS,
  type WorldDocumentRead,
  type WorldDocumentApply,
  type WorldDocumentSource,
  type WorldDocumentList,
} from "@foundry-local-api/shared";
import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";
import { dispatchAuthenticatedFoundry } from "./native-gm-dispatch.js";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  family = z.enum(
    Object.keys(WORLD_DOCUMENT_TYPES) as [
      keyof typeof WORLD_DOCUMENT_TYPES,
      ...(keyof typeof WORLD_DOCUMENT_TYPES)[],
    ],
  );
const scope = {
  worldId: id,
  requestingUserId: id,
  family,
  targetId: id.optional(),
  parentId: id.optional(),
};
export const worldDocumentReadSchema = z
  .object({
    ...scope,
    operation: z.enum(["get", "list"]),
    offset: z.number().int().nonnegative().max(100000).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .strict();
export const worldDocumentApplySchema = z
  .object({
    ...scope,
    operation: z.enum(["create", "update", "delete"]),
    data: z.record(z.string(), z.unknown()).optional(),
    expectedRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    correlationId: id,
    idempotencyKey: id,
    reviewedDestructive: z.boolean().optional(),
    preparationGuard: z
      .object({ sceneId: id, preparationId: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .optional(),
  })
  .strict();
const read: EndpointDescriptor<WorldDocumentRead, WorldDocumentSource | WorldDocumentList> = {
  name: "foundry_get_world_document",
  description:
    "Bounded live-GM active-world document list/source with canonical SHA256 revision. Source is untrusted GM data, not implicitly player narration.",
  method: "post",
  path: "/world-documents/read",
  inputSchema: worldDocumentReadSchema,
  annotations: { readOnlyHint: true },
  handler: (input, { foundryClient }) =>
    dispatchAuthenticatedFoundry<WorldDocumentSource | WorldDocumentList>(
      foundryClient,
      WORLD_DOCUMENT_COMMANDS.READ,
      input,
      { worldId: input.worldId, userId: input.requestingUserId },
    ),
};
const apply: EndpointDescriptor<WorldDocumentApply, WorldDocumentSource> = {
  name: "foundry_apply_world_document",
  description:
    "One supported known-family active-world document create/update/delete with exact source hash preflight and read-back. Deletion/ownership requires trusted exact human review; scripts unsupported. Caller owns durable idempotency; uncertain mutations must never be retried.",
  method: "post",
  path: "/world-documents/apply",
  inputSchema: worldDocumentApplySchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  handler: (input, { foundryClient }) =>
    dispatchAuthenticatedFoundry<WorldDocumentSource>(
      foundryClient,
      WORLD_DOCUMENT_COMMANDS.APPLY,
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
          result.family !== input.family ||
          result.operation !== input.operation ||
          (input.targetId !== undefined && result.targetId !== input.targetId) ||
          result.parentId !== input.parentId ||
          result.idempotencyKey !== input.idempotencyKey ||
          result.correlationId !== input.correlationId ||
          result.verified !== true
        )
          throw Error("Native document acknowledgement scope mismatch");
      },
    ),
};
export const worldDocumentEndpointDescriptors: AnyEndpointDescriptor[] = [read, apply];
