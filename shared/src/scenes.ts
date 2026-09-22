// Phase 11 — Scenes. Command names and payload/result shapes for the two
// scene-specific extras layered on top of the Phase 8 generic document CRUD
// (Scene CRUD itself reuses DOCUMENT_COMMANDS with documentType: "Scene",
// identical to Actor/Item), shared between the server's scene endpoints
// (server/src/endpoints/scenes.ts) and the module's scene command handlers
// (module/src/commands/scenes.ts).

export const SCENE_COMMANDS = {
  ACTIVATE: "sceneActivate",
  GET_DIMENSIONS: "sceneGetDimensions",
} as const;

export interface SceneIdInput {
  id: string;
}

/** A scene's grid config plus its computed pixel dimensions. */
export interface SceneDimensions {
  /** Scene background width/height in pixels, as stored on the document. */
  width: number;
  height: number;
  /** Padding around the scene as a fraction of its size. */
  padding: number;
  /** Grid square size in pixels. */
  size: number;
  /** Grid type, per Foundry's `CONST.GRID_TYPES` (e.g. 1 = square). */
  gridType: number;
  /** Real-world distance one grid unit represents. */
  distance: number;
  /** Unit label for `distance` (e.g. "ft"). */
  units: string;
  /** Total scene canvas width/height in pixels, including padding. */
  sceneWidth: number;
  sceneHeight: number;
  /** Top-left offset of the padded scene rect. */
  sceneX: number;
  sceneY: number;
}
