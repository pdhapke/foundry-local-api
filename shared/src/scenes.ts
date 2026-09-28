// Phase 11 — Scenes. Command names and payload/result shapes for the two
// scene-specific extras layered on top of the Phase 8 generic document CRUD
// (Scene CRUD itself reuses DOCUMENT_COMMANDS with documentType: "Scene",
// identical to Actor/Item), shared between the server's scene endpoints
// (server/src/endpoints/scenes.ts) and the module's scene command handlers
// (module/src/commands/scenes.ts).

// Phase 46 added fog-of-war reset (`RESET_FOG`), wrapping Foundry's own
// `Scene#resetFog()`. Foundry's implementation resolves purely off the
// target Scene document's own id (it clears that scene's FogExploration
// records, not anything tied to whichever scene is currently viewed), so
// this operates on any scene by id, same as `ACTIVATE`/`GET_DIMENSIONS`
// above — no "must be the active scene" restriction was needed.
export const SCENE_COMMANDS = {
  ACTIVATE: "sceneActivate",
  ALIGN_GRID: "sceneAlignGrid",
  GET_DIMENSIONS: "sceneGetDimensions",
  RESET_FOG: "sceneResetFog",
} as const;

export interface SceneGridState {
  grid: {
    type: number;
    size: number;
    distance: number;
    units: string;
    style: string;
    thickness: number;
    color: string;
    alpha: number;
  };
  shiftX: number;
  shiftY: number;
  modifiedTime: number;
}

export interface SceneGridAlignmentInput {
  id: string;
  expectedModifiedTime: number;
  size: number;
  distance: number;
  shiftX: number;
  shiftY: number;
  dryRun?: boolean | undefined;
}

export interface SceneGridAlignmentResult {
  id: string;
  persisted: boolean;
  before: SceneGridState;
  after: SceneGridState;
  rollback: SceneGridAlignmentInput;
  spatialDocumentCounts: {
    tokens: number;
    walls: number;
    regions: number;
    tiles: number;
    notes: number;
    lights: number;
    sounds: number;
  };
  unrelatedSceneFieldsUnchanged: true;
  embeddedDocumentsUnchanged: true;
}

export interface SceneIdInput {
  id: string;
}

/** `Scene#resetFog()` itself resolves with no meaningful data (it's a fire-and-forget socket request); this just confirms which scene was targeted. */
export interface SceneResetFogResult {
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
