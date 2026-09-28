import { z } from "zod";

import {
  SCHEMA_DISCOVERY_COMMANDS,
  type SchemaDiscoveryResult,
  type SchemaTargetInput,
  type SchemaValidationInput,
  type SchemaValidationBatchResult,
} from "@foundry-local-api/shared";

import type { AnyEndpointDescriptor } from "./types.js";

const targetShape = {
  documentType: z.string().min(1).max(64),
  parentDocumentType: z.string().min(1).max(64).optional(),
  parentDocumentId: z.string().min(1).max(128).optional(),
  subtype: z.string().min(1).max(128).optional(),
  expectedFoundryVersion: z.string().min(1).max(64),
  expectedSystemId: z.string().min(1).max(64),
  expectedSystemVersion: z.string().min(1).max(64),
};

const discoverySchema = z.object(targetShape).strict();
const validationSchema = z
  .object({
    ...targetShape,
    mode: z.enum(["create", "update"]),
    data: z.record(z.string(), z.unknown()).optional(),
    candidates: z.array(z.record(z.string(), z.unknown())).min(1).max(100).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const hasData = input.data !== undefined;
    const hasCandidates = input.candidates !== undefined;
    if (hasData === hasCandidates) {
      context.addIssue({
        code: "custom",
        path: [hasData ? "candidates" : "data"],
        message: "Provide exactly one of data or a non-empty candidates array.",
      });
    }
  });

/** REST and MCP descriptors for read-only Foundry DataModel introspection. */
export const schemaDiscoveryEndpointDescriptors: AnyEndpointDescriptor[] = [
  {
    name: "foundry_get_document_schema",
    description:
      "Discovers the active Foundry 14 document/DataModel schema, including subtype context, required fields, static defaults, and enums. This is read-only and does not instantiate or persist a document.",
    method: "get",
    path: "/schemas/discover",
    inputSchema: discoverySchema,
    handler: (input: SchemaTargetInput, { foundryClient }) =>
      foundryClient.call<SchemaTargetInput, SchemaDiscoveryResult>(
        SCHEMA_DISCOVERY_COMMANDS.DISCOVER,
        input,
      ),
    annotations: { readOnlyHint: true },
  },
  {
    name: "foundry_validate_document_data",
    description:
      "Validates and normalizes a proposed create or update payload against active Foundry 14 core and system DataModels. It returns field-path errors and unknown-field warnings and never persists the candidate.",
    method: "post",
    path: "/schemas/validate",
    inputSchema: validationSchema,
    handler: (input: SchemaValidationInput, { foundryClient }) =>
      foundryClient.call<SchemaValidationInput, SchemaValidationBatchResult>(
        SCHEMA_DISCOVERY_COMMANDS.VALIDATE,
        input,
      ),
    annotations: { readOnlyHint: true },
  },
];
