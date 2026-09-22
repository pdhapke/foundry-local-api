// Phase 22 — Canvas & Scene Placeables. Command names and payload/result
// shapes for embedded placeable-document CRUD (Drawing, Note, AmbientLight,
// AmbientSound, Wall, MeasuredTemplate), shared between the server's
// placeable endpoint factory (server/src/endpoints/placeables.ts) and the
// module's embedded-placeable command handlers
// (module/src/commands/placeables.ts), plus a camera pan/zoom command.
//
// Every placeable type here is embedded on a Scene the same way Token is
// (Phase 12), but unlike ActiveEffect (Phase 21 — one embedded type, two
// possible parents), this phase has one fixed parent (Scene) and six
// possible embedded types. So the axis of genericity flips: every payload
// carries `documentType` alongside `sceneId`, and the server's factory (one
// call per placeable type) bakes `documentType` in via closure, mirroring
// how Phase 21's factory bakes in `parentType`.

export const EMBEDDED_PLACEABLE_COMMANDS = {
  LIST: "placeableList",
  GET: "placeableGet",
  CREATE: "placeableCreate",
  UPDATE: "placeableUpdate",
  DELETE: "placeableDelete",
} as const;

export const CANVAS_COMMANDS = {
  PAN: "canvasPan",
} as const;

/** The six placeable document types embedded on a Scene that this phase covers. */
export type PlaceableDocumentType =
  | "Drawing"
  | "Note"
  | "AmbientLight"
  | "AmbientSound"
  | "Wall"
  | "MeasuredTemplate";

export interface PlaceableParentInput {
  documentType: PlaceableDocumentType;
  sceneId: string;
}

export interface PlaceableIdInput extends PlaceableParentInput {
  placeableId: string;
}

export interface PlaceableCreateInput extends PlaceableParentInput {
  data: Record<string, unknown>;
}

export interface PlaceableUpdateInput extends PlaceableIdInput {
  changes: Record<string, unknown>;
}

/** Pans/zooms the currently-viewed canvas. Every field is optional — omitted fields keep their current value. */
export interface CanvasPanInput {
  x?: number | undefined;
  y?: number | undefined;
  scale?: number | undefined;
}

export interface CanvasPanResult {
  x: number;
  y: number;
  scale: number;
}
