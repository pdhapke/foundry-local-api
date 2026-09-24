// Phase 11 — Scenes.
//
// Base CRUD reuses the Phase 8 `makeDocumentEndpoints()` factory with
// `documentType: "Scene"`, same as JournalEntry/Actor/Item. The extras
// PLAN.md's Phase 11 calls for (activate scene, grid/dimension info) are
// hand-rolled here since they're scene-specific, not generic document
// behavior — see module/src/commands/scenes.ts for the matching module-side
// handlers.
//
// Phase 46 added fog-of-war reset the same way.
import { z } from "zod";

import {
  SCENE_COMMANDS,
  type DocumentData,
  type SceneDimensions,
  type SceneIdInput,
  type SceneResetFogResult,
} from "@foundry-local-api/shared";

import { makeDocumentEndpoints } from "./documents.js";
import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";

const idSchema = z.object({ id: z.string().min(1) });

const activateDescriptor: EndpointDescriptor<SceneIdInput, DocumentData> = {
  name: "foundry_activate_scene",
  description: "Activates a scene, making it the world's current active/viewed scene.",
  method: "post",
  path: "/scenes/:id/activate",
  inputSchema: idSchema,
  handler: ({ id }, { foundryClient }) =>
    foundryClient.call<SceneIdInput, DocumentData>(SCENE_COMMANDS.ACTIVATE, { id }),
};

const getDimensionsDescriptor: EndpointDescriptor<SceneIdInput, SceneDimensions> = {
  name: "foundry_get_scene_dimensions",
  description:
    "Reads a scene's grid config and computed pixel dimensions (size, distance, units, width/height).",
  method: "get",
  path: "/scenes/:id/dimensions",
  inputSchema: idSchema,
  handler: ({ id }, { foundryClient }) =>
    foundryClient.call<SceneIdInput, SceneDimensions>(SCENE_COMMANDS.GET_DIMENSIONS, { id }),
};

const resetFogDescriptor: EndpointDescriptor<SceneIdInput, SceneResetFogResult> = {
  name: "foundry_reset_scene_fog",
  description: "Clears a scene's explored fog-of-war for every connected client.",
  method: "post",
  path: "/scenes/:id/reset-fog",
  inputSchema: idSchema,
  handler: ({ id }, { foundryClient }) =>
    foundryClient.call<SceneIdInput, SceneResetFogResult>(SCENE_COMMANDS.RESET_FOG, { id }),
};

export const sceneEndpointDescriptors: AnyEndpointDescriptor[] = [
  ...makeDocumentEndpoints({
    documentType: "Scene",
    routeBase: "scenes",
    toolSingular: "scene",
    toolPlural: "scenes",
  }),
  activateDescriptor,
  getDimensionsDescriptor,
  resetFogDescriptor,
];
