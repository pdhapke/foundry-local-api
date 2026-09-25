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
//
// Phase 41 added "Region" (`RegionDocument`, Foundry v11+ Scene Regions) as
// a seventh placeable type — it postdates when Phase 22 was originally
// scoped. It needed no new server-side code beyond one more factory call
// (server/src/endpoints/placeables.ts): `Scene#getEmbeddedCollection()`
// already handles any embedded document type generically.
//
// Phase 47 added `PUSH_VIEW`: unlike every document write since Phase 8
// (which already propagates to every connected client for free via
// Foundry's own document-sync socket), `canvas.animatePan()` (`PAN` above)
// only ever moves the camera of whichever single client the bridge happens
// to be connected to — it cannot reach other players. `PUSH_VIEW` relays the
// same x/y/scale via a module-scoped `game.socket` broadcast instead (see
// module/src/socket.ts), so every client with this module enabled — GM and
// players alike — pans together. Same input shape as `PAN` (`CanvasPanInput`
// is reused, not duplicated) since "what to pan/zoom to" is identical; only
// the delivery mechanism differs. The broadcast's socket-event name itself
// now lives in shared/src/socket.ts (`MODULE_SOCKET_EVENT`) — pulled out
// once Phase 42 became a second consumer of the same channel.
//
// Phase 54 added `GET_VIEWPORT`: a pure read of the connected client's
// current camera position/scale, no side effect (unlike `PAN`/`PUSH_VIEW`,
// neither of which the caller can use to find out where the camera
// currently is without also moving it). Reuses `CanvasPanResult` as-is —
// the same `{x, y, scale}` shape `PAN`/`PUSH_VIEW` already return after
// panning, just read without calling `animatePan()` first.

export const EMBEDDED_PLACEABLE_COMMANDS = {
  LIST: "placeableList",
  GET: "placeableGet",
  CREATE: "placeableCreate",
  UPDATE: "placeableUpdate",
  DELETE: "placeableDelete",
} as const;

export const CANVAS_COMMANDS = {
  PAN: "canvasPan",
  PUSH_VIEW: "canvasPushView",
  GET_VIEWPORT: "canvasGetViewport",
} as const;

/** One broadcast socket message's shape, carried as the `game.socket` event payload (see shared/src/socket.ts). */
export interface CanvasPushViewMessage {
  type: "pushView";
  view: CanvasPanInput;
}

/** The seven placeable document types embedded on a Scene that this phase covers. */
export type PlaceableDocumentType =
  "Drawing" | "Note" | "AmbientLight" | "AmbientSound" | "Wall" | "MeasuredTemplate" | "Region";

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
