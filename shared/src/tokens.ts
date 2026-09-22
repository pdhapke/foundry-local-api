// Phase 12 — Tokens (scene-embedded). Unlike Actor/Item, there is no
// top-level "Token" entry in `game.collections` for the Phase 8 generic
// `makeDocumentEndpoints()` factory to key off — a Token only ever exists
// embedded on a Scene — so this phase hand-rolls all of list/get/create/
// update/delete, plus the two extras PLAN.md's Phase 12 calls for (move,
// visibility toggle), following the same `<parent>Id`/`<child>Id`-shaped
// embedded-id pattern Phase 10 established for embedded items
// (shared/src/items.ts). Shared between the server's token endpoints
// (server/src/endpoints/tokens.ts) and the module's token command handlers
// (module/src/commands/tokens.ts).

export const TOKEN_COMMANDS = {
  LIST: "sceneListTokens",
  GET: "sceneGetToken",
  CREATE: "sceneCreateToken",
  UPDATE: "sceneUpdateToken",
  DELETE: "sceneDeleteToken",
  MOVE: "sceneMoveToken",
  SET_VISIBILITY: "sceneSetTokenVisibility",
} as const;

export interface SceneTokenListInput {
  sceneId: string;
}

export interface SceneTokenIdInput {
  sceneId: string;
  tokenId: string;
}

export interface SceneTokenCreateInput {
  sceneId: string;
  data: Record<string, unknown>;
}

export interface SceneTokenUpdateInput {
  sceneId: string;
  tokenId: string;
  changes: Record<string, unknown>;
}

export interface SceneTokenMoveInput {
  sceneId: string;
  tokenId: string;
  x: number;
  y: number;
}

export interface SceneTokenVisibilityInput {
  sceneId: string;
  tokenId: string;
  hidden: boolean;
}
