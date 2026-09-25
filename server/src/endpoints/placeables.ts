// Phase 22 — Canvas & Scene Placeables.
//
// Seven placeable document types (Drawing, Note, AmbientLight, AmbientSound,
// Wall, MeasuredTemplate, Region) are all embedded on a Scene, the same
// parent Phase 12's Token uses — so this file defines one factory
// (`makeEmbeddedPlaceableEndpoints()`, mirroring Phase 21's
// `makeEmbeddedEffectEndpoints()`) and calls it once per placeable type
// rather than hand-rolling near-identical sets of descriptors per type.
// `documentType` is baked into each call's descriptors via closure; only
// `sceneId`/`placeableId` travel as REST path params. Also adds the
// scene-independent camera pan/zoom endpoint PLAN.md's Phase 22 text calls
// for. See module/src/commands/placeables.ts for the matching module-side
// handlers.
//
// Phase 41 added "Region" (`RegionDocument`, Foundry v11+ Scene Regions) as
// a seventh call to the same factory — no new server-side code otherwise.
// On a pre-v11 core, `Scene#getEmbeddedCollection("regions")` throws
// module-side (see requirePlaceable()/the collection lookup in
// module/src/commands/placeables.ts), which the registry's existing
// FoundryBridgeError handling already turns into a clear REST/MCP error
// rather than a crash — no extra version-guard code was needed.
//
// Phase 54 added `getViewportDescriptor` (`GET /canvas/viewport`, no input):
// a pure read of the same `CanvasPanResult` shape `canvasPanDescriptor`/
// `pushViewDescriptor` already return after moving the camera.
import { z } from "zod";

import {
  CANVAS_COMMANDS,
  EMBEDDED_PLACEABLE_COMMANDS,
  type CanvasPanInput,
  type CanvasPanResult,
  type DocumentData,
  type DocumentDeleteResult,
  type PlaceableCreateInput,
  type PlaceableDocumentType,
  type PlaceableIdInput,
  type PlaceableParentInput,
  type PlaceableUpdateInput,
} from "@foundry-local-api/shared";

import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";

export interface EmbeddedPlaceableEndpointConfig {
  /** The Foundry document type embedded on the scene, e.g. "Drawing". */
  documentType: PlaceableDocumentType;
  /** REST path segment for this placeable type, mounted under `/scenes/:sceneId`, e.g. "drawings". */
  routeBase: string;
  /** snake_case prefix used in the generated MCP tool names, e.g. "drawing" -> "foundry_list_scene_drawings". */
  toolPrefix: string;
}

const documentDataSchema = z.record(z.string(), z.unknown());
const sceneIdSchema = z.object({ sceneId: z.string().min(1) });
const placeableIdSchema = sceneIdSchema.extend({ placeableId: z.string().min(1) });
const createSchema = sceneIdSchema.extend({ data: documentDataSchema });
const updateSchema = placeableIdSchema.extend({ changes: documentDataSchema });
const canvasPanSchema = z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  scale: z.number().optional(),
});

/**
 * Builds the five embedded-placeable CRUD descriptors for one placeable
 * document type. REST: `GET/POST /scenes/:sceneId/<routeBase>`,
 * `GET/PUT/DELETE /scenes/:sceneId/<routeBase>/:placeableId`.
 */
export function makeEmbeddedPlaceableEndpoints(
  config: EmbeddedPlaceableEndpointConfig,
): AnyEndpointDescriptor[] {
  const { documentType, routeBase, toolPrefix } = config;

  const listDescriptor: EndpointDescriptor<{ sceneId: string }, DocumentData[]> = {
    name: `foundry_list_scene_${toolPrefix}s`,
    description: `Lists every embedded ${documentType} document on a scene.`,
    method: "get",
    path: `/scenes/:sceneId/${routeBase}`,
    inputSchema: sceneIdSchema,
    handler: ({ sceneId }, { foundryClient }) =>
      foundryClient.call<PlaceableParentInput, DocumentData[]>(EMBEDDED_PLACEABLE_COMMANDS.LIST, {
        documentType,
        sceneId,
      }),
  };

  const getDescriptor: EndpointDescriptor<{ sceneId: string; placeableId: string }, DocumentData> =
    {
      name: `foundry_get_scene_${toolPrefix}`,
      description: `Reads a single embedded ${documentType} document from a scene by id.`,
      method: "get",
      path: `/scenes/:sceneId/${routeBase}/:placeableId`,
      inputSchema: placeableIdSchema,
      handler: ({ sceneId, placeableId }, { foundryClient }) =>
        foundryClient.call<PlaceableIdInput, DocumentData>(EMBEDDED_PLACEABLE_COMMANDS.GET, {
          documentType,
          sceneId,
          placeableId,
        }),
    };

  const createDescriptor: EndpointDescriptor<
    { sceneId: string; data: Record<string, unknown> },
    DocumentData
  > = {
    name: `foundry_create_scene_${toolPrefix}`,
    description: `Creates a new embedded ${documentType} document on a scene.`,
    method: "post",
    path: `/scenes/:sceneId/${routeBase}`,
    inputSchema: createSchema,
    handler: ({ sceneId, data }, { foundryClient }) =>
      foundryClient.call<PlaceableCreateInput, DocumentData>(EMBEDDED_PLACEABLE_COMMANDS.CREATE, {
        documentType,
        sceneId,
        data,
      }),
  };

  const updateDescriptor: EndpointDescriptor<
    { sceneId: string; placeableId: string; changes: Record<string, unknown> },
    DocumentData
  > = {
    name: `foundry_update_scene_${toolPrefix}`,
    description: `Updates fields on an existing embedded ${documentType} document on a scene.`,
    method: "put",
    path: `/scenes/:sceneId/${routeBase}/:placeableId`,
    inputSchema: updateSchema,
    handler: ({ sceneId, placeableId, changes }, { foundryClient }) =>
      foundryClient.call<PlaceableUpdateInput, DocumentData>(EMBEDDED_PLACEABLE_COMMANDS.UPDATE, {
        documentType,
        sceneId,
        placeableId,
        changes,
      }),
  };

  const deleteDescriptor: EndpointDescriptor<
    { sceneId: string; placeableId: string },
    DocumentDeleteResult
  > = {
    name: `foundry_delete_scene_${toolPrefix}`,
    description: `Deletes an embedded ${documentType} document from a scene by id.`,
    method: "delete",
    path: `/scenes/:sceneId/${routeBase}/:placeableId`,
    inputSchema: placeableIdSchema,
    handler: ({ sceneId, placeableId }, { foundryClient }) =>
      foundryClient.call<PlaceableIdInput, DocumentDeleteResult>(
        EMBEDDED_PLACEABLE_COMMANDS.DELETE,
        { documentType, sceneId, placeableId },
      ),
  };

  return [listDescriptor, getDescriptor, createDescriptor, updateDescriptor, deleteDescriptor];
}

const canvasPanDescriptor: EndpointDescriptor<CanvasPanInput, CanvasPanResult> = {
  name: "foundry_pan_canvas",
  description:
    "Pans/zooms the currently-viewed canvas on the connected client. Omitted x/y/scale keep their current value.",
  method: "post",
  path: "/canvas/pan",
  inputSchema: canvasPanSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<CanvasPanInput, CanvasPanResult>(CANVAS_COMMANDS.PAN, input),
};

const pushViewDescriptor: EndpointDescriptor<CanvasPanInput, CanvasPanResult> = {
  name: "foundry_push_view_to_players",
  description:
    "Pans/zooms every connected client's canvas (GM and players alike) to the same view, via a " +
    "module-scoped socket broadcast — unlike foundry_pan_canvas, which only moves the connected " +
    "client's own camera. Omitted x/y/scale keep each client's current value.",
  method: "post",
  path: "/canvas/push-view",
  inputSchema: canvasPanSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<CanvasPanInput, CanvasPanResult>(CANVAS_COMMANDS.PUSH_VIEW, input),
};

const getViewportDescriptor: EndpointDescriptor<void, CanvasPanResult> = {
  name: "foundry_get_canvas_viewport",
  description:
    "Reads the currently-viewed canvas's camera position and zoom on the connected client, without moving it.",
  method: "get",
  path: "/canvas/viewport",
  handler: (_input, { foundryClient }) =>
    foundryClient.call<undefined, CanvasPanResult>(CANVAS_COMMANDS.GET_VIEWPORT),
};

export const placeableEndpointDescriptors: AnyEndpointDescriptor[] = [
  ...makeEmbeddedPlaceableEndpoints({
    documentType: "Drawing",
    routeBase: "drawings",
    toolPrefix: "drawing",
  }),
  ...makeEmbeddedPlaceableEndpoints({
    documentType: "Note",
    routeBase: "notes",
    toolPrefix: "note",
  }),
  ...makeEmbeddedPlaceableEndpoints({
    documentType: "AmbientLight",
    routeBase: "lights",
    toolPrefix: "light",
  }),
  ...makeEmbeddedPlaceableEndpoints({
    documentType: "AmbientSound",
    routeBase: "sounds",
    toolPrefix: "sound",
  }),
  ...makeEmbeddedPlaceableEndpoints({
    documentType: "Wall",
    routeBase: "walls",
    toolPrefix: "wall",
  }),
  ...makeEmbeddedPlaceableEndpoints({
    documentType: "MeasuredTemplate",
    routeBase: "templates",
    toolPrefix: "template",
  }),
  ...makeEmbeddedPlaceableEndpoints({
    documentType: "Region",
    routeBase: "regions",
    toolPrefix: "region",
  }),
  canvasPanDescriptor,
  pushViewDescriptor,
  getViewportDescriptor,
];
