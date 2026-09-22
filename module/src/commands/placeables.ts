// Phase 22 — Canvas & Scene Placeables command handlers. Registered against
// the same command dispatcher registry Phase 2 set up
// (module/src/command-registry.ts) and imported for side effects from
// module/src/index.ts.
//
// Six placeable document types (Drawing, Note, AmbientLight, AmbientSound,
// Wall, MeasuredTemplate) are all embedded on a Scene, so every CRUD handler
// below resolves its collection generically off `Scene#getEmbeddedCollection
// (documentType)` rather than naming six separate scene properties —
// mirroring how Phase 21's handlers resolve their parent generically off
// `game.collections.get(parentType)`.
import {
  CANVAS_COMMANDS,
  EMBEDDED_PLACEABLE_COMMANDS,
  type CanvasPanInput,
  type CanvasPanResult,
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
  async ({ documentType, sceneId, placeableId, changes }: PlaceableUpdateInput): Promise<DocumentData> => {
    const placeable = requirePlaceable(requireScene(sceneId), documentType, placeableId);
    await placeable.update(changes);
    return placeable.toObject();
  },
);

registerCommand(
  EMBEDDED_PLACEABLE_COMMANDS.DELETE,
  async ({ documentType, sceneId, placeableId }: PlaceableIdInput): Promise<DocumentDeleteResult> => {
    const placeable = requirePlaceable(requireScene(sceneId), documentType, placeableId);
    await placeable.delete();
    return { id: placeableId };
  },
);

registerCommand(CANVAS_COMMANDS.PAN, async (input: CanvasPanInput): Promise<CanvasPanResult> => {
  if (!canvas) {
    throw new Error("No active canvas — no scene is currently being viewed");
  }
  await canvas.animatePan(input);
  return { x: canvas.stage.pivot.x, y: canvas.stage.pivot.y, scale: canvas.scale };
});
