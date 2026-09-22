// Phase 23 — Permissions & Ownership.
//
// Document ownership is generic across document type (like Phase 19's
// folder-move), so it's hand-rolled under a new `/documents/:documentType/
// :documentId/ownership` route rather than run through the Phase 8
// `makeDocumentEndpoints()` factory, which mounts CRUD per-type under its own
// `routeBase` and has no notion of a cross-type route. World permission
// level per user is narrower than full User CRUD (left to a later phase),
// mounted under `/users/:userId/role`. See
// module/src/commands/permissions.ts for the matching module-side handlers.
import { z } from "zod";

import {
  PERMISSION_COMMANDS,
  type DocumentOwnershipInput,
  type DocumentOwnershipResult,
  type DocumentSetOwnershipInput,
  type UserRoleInput,
  type UserRoleResult,
  type UserSetRoleInput,
} from "@foundry-local-api/shared";

import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";

const ownershipIdSchema = z.object({
  documentType: z.string().min(1),
  documentId: z.string().min(1),
});
const setOwnershipSchema = ownershipIdSchema.extend({
  ownership: z.record(z.string(), z.number()),
});
const userIdSchema = z.object({ userId: z.string().min(1) });
const setUserRoleSchema = userIdSchema.extend({ role: z.number().int() });

const getOwnershipDescriptor: EndpointDescriptor<DocumentOwnershipInput, DocumentOwnershipResult> = {
  name: "foundry_get_document_ownership",
  description: "Reads a document's ownership map (default level plus any per-user overrides).",
  method: "get",
  path: "/documents/:documentType/:documentId/ownership",
  inputSchema: ownershipIdSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<DocumentOwnershipInput, DocumentOwnershipResult>(
      PERMISSION_COMMANDS.GET_OWNERSHIP,
      input,
    ),
};

const setOwnershipDescriptor: EndpointDescriptor<DocumentSetOwnershipInput, DocumentOwnershipResult> = {
  name: "foundry_set_document_ownership",
  description:
    "Sets a document's ownership map. Pass a full replacement map (e.g. " +
    '{ "default": 0, "<userId>": 3 }) using CONST.DOCUMENT_OWNERSHIP_LEVELS values.',
  method: "put",
  path: "/documents/:documentType/:documentId/ownership",
  inputSchema: setOwnershipSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<DocumentSetOwnershipInput, DocumentOwnershipResult>(
      PERMISSION_COMMANDS.SET_OWNERSHIP,
      input,
    ),
};

const getUserRoleDescriptor: EndpointDescriptor<UserRoleInput, UserRoleResult> = {
  name: "foundry_get_user_role",
  description: "Reads a user's world permission level (CONST.USER_ROLES value).",
  method: "get",
  path: "/users/:userId/role",
  inputSchema: userIdSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<UserRoleInput, UserRoleResult>(PERMISSION_COMMANDS.GET_USER_ROLE, input),
};

const setUserRoleDescriptor: EndpointDescriptor<UserSetRoleInput, UserRoleResult> = {
  name: "foundry_set_user_role",
  description: "Sets a user's world permission level (CONST.USER_ROLES value). GM only.",
  method: "put",
  path: "/users/:userId/role",
  inputSchema: setUserRoleSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<UserSetRoleInput, UserRoleResult>(PERMISSION_COMMANDS.SET_USER_ROLE, input),
};

export const permissionEndpointDescriptors: AnyEndpointDescriptor[] = [
  getOwnershipDescriptor,
  setOwnershipDescriptor,
  getUserRoleDescriptor,
  setUserRoleDescriptor,
];
