// Phase 25 — Users & Client State.
//
// A User has no `game.collections` entry of its own (it lives on its own
// `game.users` map), so User CRUD is hand-rolled here rather than run
// through the Phase 8 `makeDocumentEndpoints()` factory — the same "no
// generic collection" reasoning Phase 20 (packs) and Phase 23 (`game.users`
// role-only) already established. `GET /users` (list) already exists from
// Phase 6 (`foundry_list_users`), so this file only adds get-by-id/create/
// update/delete under `/users[/:userId]`, plus `/users/:userId/status`
// (active/idle) and the scene-independent `/canvas/selection` extra, a
// sibling of Phase 22's `/canvas/pan` (same "no active canvas" error
// precedent, hand-rolled the same way). See module/src/commands/users.ts for
// the matching module-side handlers.
import { z } from "zod";

import {
  USER_COMMANDS,
  type ActiveGmResult,
  type CanvasSelectionResult,
  type CanvasTargetsResult,
  type DocumentData,
  type DocumentDeleteResult,
  type SetCanvasTargetsInput,
  type UserCreateInput,
  type UserIdInput,
  type UserStatusResult,
  type UserUpdateInput,
} from "@foundry-local-api/shared";

import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";

const documentDataSchema = z.record(z.string(), z.unknown());
const userIdSchema = z.object({ userId: z.string().min(1) });
const createSchema = z.object({ data: documentDataSchema });
const updateSchema = userIdSchema.extend({ changes: documentDataSchema });
const setTargetsSchema = z.object({
  tokenIds: z.array(z.string().min(1)),
  additive: z.boolean().optional(),
});

const getActiveGmDescriptor: EndpointDescriptor<void, ActiveGmResult> = {
  name: "foundry_get_active_gm",
  description:
    "Looks up the world's currently active GM (game.users.activeGM) — one connected " +
    "Gamemaster (non-assistant if possible), or null if none is connected. Useful for " +
    "workflows that should happen once, on a single authoritative client, rather than once " +
    "per connected GM. Registered ahead of GET /users/:userId so the literal 'active-gm' " +
    "path segment isn't swallowed by that param route.",
  method: "get",
  path: "/users/active-gm",
  handler: (_input, { foundryClient }) =>
    foundryClient.call<undefined, ActiveGmResult>(USER_COMMANDS.GET_ACTIVE_GM),
};

const getUserDescriptor: EndpointDescriptor<UserIdInput, DocumentData> = {
  name: "foundry_get_user_by_id",
  description: "Reads a single User document's full data by id.",
  method: "get",
  path: "/users/:userId",
  inputSchema: userIdSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<UserIdInput, DocumentData>(USER_COMMANDS.GET, input),
};

const createUserDescriptor: EndpointDescriptor<UserCreateInput, DocumentData> = {
  name: "foundry_create_user",
  description: "Creates a new User document. GM only.",
  method: "post",
  path: "/users",
  inputSchema: createSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<UserCreateInput, DocumentData>(USER_COMMANDS.CREATE, input),
};

const updateUserDescriptor: EndpointDescriptor<UserUpdateInput, DocumentData> = {
  name: "foundry_update_user",
  description: "Updates fields on an existing User document. GM only.",
  method: "put",
  path: "/users/:userId",
  inputSchema: updateSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<UserUpdateInput, DocumentData>(USER_COMMANDS.UPDATE, input),
};

const deleteUserDescriptor: EndpointDescriptor<UserIdInput, DocumentDeleteResult> = {
  name: "foundry_delete_user",
  description: "Deletes a User document by id. GM only.",
  method: "delete",
  path: "/users/:userId",
  inputSchema: userIdSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<UserIdInput, DocumentDeleteResult>(USER_COMMANDS.DELETE, input),
};

const getUserStatusDescriptor: EndpointDescriptor<UserIdInput, UserStatusResult> = {
  name: "foundry_get_user_status",
  description: "Reads whether a user currently has an active connection to the world.",
  method: "get",
  path: "/users/:userId/status",
  inputSchema: userIdSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<UserIdInput, UserStatusResult>(USER_COMMANDS.GET_STATUS, input),
};

const getCanvasSelectionDescriptor: EndpointDescriptor<void, CanvasSelectionResult> = {
  name: "foundry_get_canvas_selection",
  description:
    "Reads the currently controlled/selected tokens on the connected client's canvas (canvas.tokens.controlled), plus the currently-viewed scene id.",
  method: "get",
  path: "/canvas/selection",
  handler: (_input, { foundryClient }) =>
    foundryClient.call<undefined, CanvasSelectionResult>(USER_COMMANDS.GET_CANVAS_SELECTION),
};

const getCanvasTargetsDescriptor: EndpointDescriptor<void, CanvasTargetsResult> = {
  name: "foundry_get_targets",
  description:
    "Reads the tokens currently targeted by the connected client's user (game.user.targets), plus the currently-viewed scene id.",
  method: "get",
  path: "/canvas/targets",
  handler: (_input, { foundryClient }) =>
    foundryClient.call<undefined, CanvasTargetsResult>(USER_COMMANDS.GET_TARGETS),
};

const setCanvasTargetsDescriptor: EndpointDescriptor<SetCanvasTargetsInput, CanvasTargetsResult> = {
  name: "foundry_set_targets",
  description:
    "Targets the given tokens for the connected client's user, replacing any existing targets unless `additive` is true.",
  method: "post",
  path: "/canvas/targets",
  inputSchema: setTargetsSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<SetCanvasTargetsInput, CanvasTargetsResult>(
      USER_COMMANDS.SET_TARGETS,
      input,
    ),
};

export const userEndpointDescriptors: AnyEndpointDescriptor[] = [
  getActiveGmDescriptor,
  getUserDescriptor,
  createUserDescriptor,
  updateUserDescriptor,
  deleteUserDescriptor,
  getUserStatusDescriptor,
  getCanvasSelectionDescriptor,
  getCanvasTargetsDescriptor,
  setCanvasTargetsDescriptor,
];
