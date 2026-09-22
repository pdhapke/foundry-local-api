// Phase 12 — Tokens (scene-embedded).
//
// Unlike Actor/Item/Scene, there is no top-level "Token" entry in
// `game.collections` for the Phase 8 `makeDocumentEndpoints()` factory to
// key off — a Token only exists embedded on a Scene — so every descriptor
// here is hand-rolled: list/get/create/update/delete under
// `/api/scenes/:sceneId/tokens[/:tokenId]`, plus the two extras PLAN.md's
// Phase 12 calls for (move, visibility toggle). See
// module/src/commands/tokens.ts for the matching module-side handlers.
import { z } from "zod";

import {
  TOKEN_COMMANDS,
  type DocumentData,
  type DocumentDeleteResult,
  type SceneTokenCreateInput,
  type SceneTokenIdInput,
  type SceneTokenListInput,
  type SceneTokenMoveInput,
  type SceneTokenUpdateInput,
  type SceneTokenVisibilityInput,
} from "@foundry-local-api/shared";

import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";

const documentDataSchema = z.record(z.string(), z.unknown());
const sceneIdSchema = z.object({ sceneId: z.string().min(1) });
const tokenIdSchema = z.object({ sceneId: z.string().min(1), tokenId: z.string().min(1) });
const createSchema = z.object({ sceneId: z.string().min(1), data: documentDataSchema });
const updateSchema = tokenIdSchema.extend({ changes: documentDataSchema });
const moveSchema = tokenIdSchema.extend({ x: z.number(), y: z.number() });
const visibilitySchema = tokenIdSchema.extend({ hidden: z.boolean() });

const listTokensDescriptor: EndpointDescriptor<SceneTokenListInput, DocumentData[]> = {
  name: "foundry_list_scene_tokens",
  description: "Lists a scene's embedded Token documents.",
  method: "get",
  path: "/scenes/:sceneId/tokens",
  inputSchema: sceneIdSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<SceneTokenListInput, DocumentData[]>(TOKEN_COMMANDS.LIST, input),
};

const getTokenDescriptor: EndpointDescriptor<SceneTokenIdInput, DocumentData> = {
  name: "foundry_get_scene_token",
  description: "Reads a single embedded Token document from a scene by id.",
  method: "get",
  path: "/scenes/:sceneId/tokens/:tokenId",
  inputSchema: tokenIdSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<SceneTokenIdInput, DocumentData>(TOKEN_COMMANDS.GET, input),
};

const createTokenDescriptor: EndpointDescriptor<SceneTokenCreateInput, DocumentData> = {
  name: "foundry_create_scene_token",
  description: "Creates a new embedded Token document on a scene.",
  method: "post",
  path: "/scenes/:sceneId/tokens",
  inputSchema: createSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<SceneTokenCreateInput, DocumentData>(TOKEN_COMMANDS.CREATE, input),
};

const updateTokenDescriptor: EndpointDescriptor<SceneTokenUpdateInput, DocumentData> = {
  name: "foundry_update_scene_token",
  description: "Updates fields on an existing embedded Token document on a scene.",
  method: "put",
  path: "/scenes/:sceneId/tokens/:tokenId",
  inputSchema: updateSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<SceneTokenUpdateInput, DocumentData>(TOKEN_COMMANDS.UPDATE, input),
};

const deleteTokenDescriptor: EndpointDescriptor<SceneTokenIdInput, DocumentDeleteResult> = {
  name: "foundry_delete_scene_token",
  description: "Deletes an embedded Token document from a scene by id.",
  method: "delete",
  path: "/scenes/:sceneId/tokens/:tokenId",
  inputSchema: tokenIdSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<SceneTokenIdInput, DocumentDeleteResult>(TOKEN_COMMANDS.DELETE, input),
};

const moveTokenDescriptor: EndpointDescriptor<SceneTokenMoveInput, DocumentData> = {
  name: "foundry_move_scene_token",
  description: "Moves a token to new x/y canvas coordinates.",
  method: "post",
  path: "/scenes/:sceneId/tokens/:tokenId/move",
  inputSchema: moveSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<SceneTokenMoveInput, DocumentData>(TOKEN_COMMANDS.MOVE, input),
};

const setTokenVisibilityDescriptor: EndpointDescriptor<SceneTokenVisibilityInput, DocumentData> = {
  name: "foundry_set_scene_token_visibility",
  description: "Sets whether a token is hidden from non-GM players.",
  method: "put",
  path: "/scenes/:sceneId/tokens/:tokenId/visibility",
  inputSchema: visibilitySchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<SceneTokenVisibilityInput, DocumentData>(
      TOKEN_COMMANDS.SET_VISIBILITY,
      input,
    ),
};

export const tokenEndpointDescriptors: AnyEndpointDescriptor[] = [
  listTokensDescriptor,
  getTokenDescriptor,
  createTokenDescriptor,
  updateTokenDescriptor,
  deleteTokenDescriptor,
  moveTokenDescriptor,
  setTokenVisibilityDescriptor,
];
