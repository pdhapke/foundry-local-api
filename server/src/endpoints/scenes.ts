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
  type SceneGridAlignmentInput,
  type SceneGridAlignmentResult,
  type SceneDimensions,
  type SceneIdInput,
  type SceneResetFogResult,
} from "@foundry-local-api/shared";

import { makeDocumentEndpoints } from "./documents.js";
import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";

const idSchema = z.object({ id: z.string().min(1) });

const alignGridSchema = z.object({
  id: z.string().min(1),
  expectedModifiedTime: z.number().int().nonnegative(),
  size: z.number().int().min(50),
  distance: z.number().positive(),
  shiftX: z.number().int(),
  shiftY: z.number().int(),
  dryRun: z.boolean().optional(),
});

const gridStateSchema = z.object({
  grid: z.object({
    type: z.number(),
    size: z.number(),
    distance: z.number(),
    units: z.string(),
    style: z.string(),
    thickness: z.number(),
    color: z.string(),
    alpha: z.number(),
  }),
  shiftX: z.number(),
  shiftY: z.number(),
  modifiedTime: z.number(),
});

const alignGridResultSchema = z.object({
  id: z.string(),
  persisted: z.boolean(),
  before: gridStateSchema,
  after: gridStateSchema,
  rollback: alignGridSchema.omit({ dryRun: true }),
  spatialDocumentCounts: z.object({
    tokens: z.number().int().nonnegative(),
    walls: z.number().int().nonnegative(),
    regions: z.number().int().nonnegative(),
    tiles: z.number().int().nonnegative(),
    notes: z.number().int().nonnegative(),
    lights: z.number().int().nonnegative(),
    sounds: z.number().int().nonnegative(),
  }),
  unrelatedSceneFieldsUnchanged: z.literal(true),
  embeddedDocumentsUnchanged: z.literal(true),
});

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

const alignGridDescriptor: EndpointDescriptor<SceneGridAlignmentInput, SceneGridAlignmentResult> = {
  name: "foundry_align_scene_grid",
  description:
    "Revision-checks and updates only one Scene's grid size, distance, and offsets through the GM lane. It independently verifies that unrelated Scene fields and embedded documents remain unchanged and returns an exact rollback payload.",
  method: "put",
  path: "/scenes/:id/grid-alignment",
  inputSchema: alignGridSchema,
  outputSchema: alignGridResultSchema,
  annotations: { destructiveHint: true, idempotentHint: false },
  handler: (input, { foundryClient }) =>
    foundryClient.call<SceneGridAlignmentInput, SceneGridAlignmentResult>(
      SCENE_COMMANDS.ALIGN_GRID,
      input,
    ),
};

const resetFogDescriptor: EndpointDescriptor<SceneIdInput, SceneResetFogResult> = {
  name: "foundry_reset_scene_fog",
  description:
    "Clears a scene's explored fog-of-war for every user and Level through Foundry's own resetFog flow, then verifies no FogExploration documents remain. Requires a GM client.",
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
  alignGridDescriptor,
  getDimensionsDescriptor,
  resetFogDescriptor,
];
