// Phase 22 — Canvas & Scene Placeables command handlers. Registered against
// the same command dispatcher registry Phase 2 set up
// (module/src/command-registry.ts) and imported for side effects from
// module/src/index.ts.
//
// Seven placeable document types (Drawing, Note, AmbientLight, AmbientSound,
// Wall, MeasuredTemplate, Region) are all embedded on a Scene, so every CRUD
// handler below resolves its collection generically off
// `Scene#getEmbeddedCollection(documentType)` rather than naming each scene
// property individually — mirroring how Phase 21's handlers resolve their
// parent generically off `game.collections.get(parentType)`.
//
// Phase 47 added `canvasPushView`, a sibling of `canvasPan` that also
// broadcasts the same x/y/scale to every other connected client via
// `game.socket` (see module/src/socket.ts for the matching receive-side
// listener, registered unconditionally at module load so it fires even on
// clients — players — that never open a bridge connection at all).
//
// Phase 54 added `canvasGetViewport`, a pure read of the same
// `{x, y, scale}` `canvasPan`/`canvasPushView` already return after moving
// the camera — this reads it without moving anything.
import {
  CANVAS_COMMANDS,
  EMBEDDED_PLACEABLE_COMMANDS,
  MODULE_SOCKET_EVENT,
  type CanvasPanInput,
  type CanvasPanResult,
  type CanvasPushViewMessage,
  type DocumentData,
  type DocumentDeleteResult,
  type PlaceableCreateInput,
  type PlaceableIdInput,
  type PlaceableParentInput,
  type PlaceableUpdateInput,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";

function requireScene(id: string): FoundryScene {
  const collection = game.collections.get("Scene") as Map<string, FoundryScene> | undefined;
  const scene = collection?.get(id);
  if (!scene) {
    throw new Error(`Scene "${id}" not found`);
  }
  return scene;
}

function requirePlaceable(
  scene: FoundryScene,
  documentType: string,
  placeableId: string,
): FoundryDocument {
  const placeable = scene.getEmbeddedCollection(documentType).get(placeableId);
  if (!placeable) {
    throw new Error(`${documentType} "${placeableId}" not found on scene "${scene.id}"`);
  }
  return placeable;
}

registerCommand(
  EMBEDDED_PLACEABLE_COMMANDS.LIST,
  ({ documentType, sceneId }: PlaceableParentInput): DocumentData[] =>
    Array.from(requireScene(sceneId).getEmbeddedCollection(documentType).values()).map(
      (placeable) => placeable.toObject(),
    ),
);

registerCommand(
  EMBEDDED_PLACEABLE_COMMANDS.GET,
  ({ documentType, sceneId, placeableId }: PlaceableIdInput): DocumentData =>
    requirePlaceable(requireScene(sceneId), documentType, placeableId).toObject(),
);

registerCommand(
  EMBEDDED_PLACEABLE_COMMANDS.CREATE,
  async ({ documentType, sceneId, data }: PlaceableCreateInput): Promise<DocumentData> => {
    const [created] = await requireScene(sceneId).createEmbeddedDocuments(documentType, [data]);
    if (!created) {
      throw new Error(`Failed to create ${documentType}`);
    }
    return created.toObject();
  },
);

registerCommand(
  EMBEDDED_PLACEABLE_COMMANDS.UPDATE,
  async ({
    documentType,
    sceneId,
    placeableId,
    changes,
  }: PlaceableUpdateInput): Promise<DocumentData> => {
    const placeable = requirePlaceable(requireScene(sceneId), documentType, placeableId);
    await placeable.update(changes);
    return placeable.toObject();
  },
);

registerCommand(
  EMBEDDED_PLACEABLE_COMMANDS.DELETE,
  async ({
    documentType,
    sceneId,
    placeableId,
  }: PlaceableIdInput): Promise<DocumentDeleteResult> => {
    const placeable = requirePlaceable(requireScene(sceneId), documentType, placeableId);
    await placeable.delete();
    return { id: placeableId };
  },
);

registerCommand(CANVAS_COMMANDS.PAN, async (input: CanvasPanInput): Promise<CanvasPanResult> => {
  if (!canvas) {
    throw new Error("No active canvas — no scene is currently being viewed");
  }
  canvas.pan(input);
  return { x: canvas.stage.pivot.x, y: canvas.stage.pivot.y, scale: canvas.stage.scale.x };
});

registerCommand(
  CANVAS_COMMANDS.PUSH_VIEW,
  async (input: CanvasPanInput): Promise<CanvasPanResult> => {
    if (!canvas) {
      throw new Error("No active canvas — no scene is currently being viewed");
    }
    // `game.socket.emit()` is not delivered back to the emitting client (see
    // module/src/socket.ts's header comment), so the connected (GM) client's
    // own camera is panned directly here, alongside the broadcast every
    // *other* client's listener picks up.
    const message: CanvasPushViewMessage = { type: "pushView", view: input };
    game.socket.emit(MODULE_SOCKET_EVENT, message);
    canvas.pan(input);
    return { x: canvas.stage.pivot.x, y: canvas.stage.pivot.y, scale: canvas.stage.scale.x };
  },
);

// Phase 54 — pure read, no `animatePan()` call: reports where the connected
// client's camera currently is without moving it.
registerCommand(CANVAS_COMMANDS.GET_VIEWPORT, (): CanvasPanResult => {
  if (!canvas) {
    throw new Error("No active canvas — no scene is currently being viewed");
  }
  return { x: canvas.stage.pivot.x, y: canvas.stage.pivot.y, scale: canvas.stage.scale.x };
});
