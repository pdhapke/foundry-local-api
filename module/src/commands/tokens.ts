// Phase 12 — Tokens command handlers. Registered against the same command
// dispatcher registry Phase 2 set up (module/src/command-registry.ts) and
// imported for side effects from module/src/index.ts.
//
// Unlike Actor/Item/Scene CRUD, there is no generic Phase 8 factory to reuse
// here: a Token only ever exists embedded on a Scene (no top-level "Token"
// entry in `game.collections`), so every command below is hand-rolled,
// mirroring the embedded-item pattern Phase 10 established
// (module/src/commands/items.ts) plus the two extras PLAN.md's Phase 12
// calls for (move, visibility toggle).
import {
  TOKEN_COMMANDS,
  type DocumentData,
  type DocumentDeleteResult,
  type SceneTokenCreateInput,
  type SceneTokenIdInput,
  type SceneTokenListInput,
  type SceneTokenMoveInput,
  type SceneTokenUpdateInput,
  type SceneTokenVisibilityInput,
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

function requireToken(scene: FoundryScene, tokenId: string): FoundryDocument {
  const token = scene.tokens.get(tokenId);
  if (!token) {
    throw new Error(`Token "${tokenId}" not found on scene "${scene.id}"`);
  }
  return token;
}

registerCommand(
  TOKEN_COMMANDS.LIST,
  ({ sceneId }: SceneTokenListInput): DocumentData[] =>
    Array.from(requireScene(sceneId).tokens.values()).map((token) => token.toObject()),
);

registerCommand(
  TOKEN_COMMANDS.GET,
  ({ sceneId, tokenId }: SceneTokenIdInput): DocumentData =>
    requireToken(requireScene(sceneId), tokenId).toObject(),
);

registerCommand(
  TOKEN_COMMANDS.CREATE,
  async ({ sceneId, data }: SceneTokenCreateInput): Promise<DocumentData> => {
    const [created] = await requireScene(sceneId).createEmbeddedDocuments("Token", [data]);
    if (!created) {
      throw new Error("Failed to create token");
    }
    return created.toObject();
  },
);

registerCommand(
  TOKEN_COMMANDS.UPDATE,
  async ({ sceneId, tokenId, changes }: SceneTokenUpdateInput): Promise<DocumentData> => {
    const token = requireToken(requireScene(sceneId), tokenId);
    await token.update(changes);
    return token.toObject();
  },
);

registerCommand(
  TOKEN_COMMANDS.DELETE,
  async ({ sceneId, tokenId }: SceneTokenIdInput): Promise<DocumentDeleteResult> => {
    const token = requireToken(requireScene(sceneId), tokenId);
    await token.delete();
    return { id: tokenId };
  },
);

registerCommand(
  TOKEN_COMMANDS.MOVE,
  async ({ sceneId, tokenId, x, y }: SceneTokenMoveInput): Promise<DocumentData> => {
    const token = requireToken(requireScene(sceneId), tokenId);
    await token.update({ x, y });
    return token.toObject();
  },
);

registerCommand(
  TOKEN_COMMANDS.SET_VISIBILITY,
  async ({ sceneId, tokenId, hidden }: SceneTokenVisibilityInput): Promise<DocumentData> => {
    const token = requireToken(requireScene(sceneId), tokenId);
    await token.update({ hidden });
    return token.toObject();
  },
);
