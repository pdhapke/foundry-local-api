// Phase 11 — Scenes command handlers. Registered against the same command
// dispatcher registry Phase 2 set up (module/src/command-registry.ts) and
// imported for side effects from module/src/index.ts.
//
// Scene CRUD itself is NOT re-implemented here: it's already covered
// generically by Phase 8's documentList/Get/Create/Update/Delete commands
// with `documentType: "Scene"` (see server/src/endpoints/scenes.ts, which
// calls the same `makeDocumentEndpoints()` factory JournalEntry/Actor/Item
// use). This file only adds the two scene-specific extras PLAN.md's Phase 11
// calls for: activation and grid/dimension info.
import {
  SCENE_COMMANDS,
  type DocumentData,
  type SceneDimensions,
  type SceneIdInput,
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

registerCommand(SCENE_COMMANDS.ACTIVATE, async ({ id }: SceneIdInput): Promise<DocumentData> => {
  const scene = requireScene(id);
  await scene.activate();
  return scene.toObject();
});

registerCommand(SCENE_COMMANDS.GET_DIMENSIONS, ({ id }: SceneIdInput): SceneDimensions => {
  const scene = requireScene(id);
  return {
    width: scene.width,
    height: scene.height,
    padding: scene.padding,
    size: scene.grid.size,
    gridType: scene.grid.type,
    distance: scene.grid.distance,
    units: scene.grid.units,
    sceneWidth: scene.dimensions.sceneWidth,
    sceneHeight: scene.dimensions.sceneHeight,
    sceneX: scene.dimensions.sceneX,
    sceneY: scene.dimensions.sceneY,
  };
});
