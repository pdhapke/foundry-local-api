// Phase 25 — Users & Client State. Command names and payload/result shapes
// shared between the server's user/canvas-selection endpoints
// (server/src/endpoints/users.ts) and the module's command handlers
// (module/src/commands/users.ts).
//
// User CRUD is hand-rolled, not run through the Phase 8
// `makeDocumentEndpoints()` factory: a User isn't part of `game.collections`
// (it lives on its own `game.users` map), the same "no generic collection"
// reasoning Phase 20 (packs, `game.packs`) and Phase 23 (`game.users`
// role-only) already established. List already exists as
// `foundry_list_users`/`GET /api/users` (Phase 6, read-only enumeration), so
// this phase only adds get-by-id/create/update/delete plus the two extras
// PLAN.md's Phase 25 text calls for: active/idle status and the currently
// controlled canvas selection.
//
// Create/update/delete are GM-only per PLAN.md's own wording, enforced
// module-side (module/src/commands/users.ts) — same convention as Phase 7's
// world-scope settings write: the server has no concept of which Foundry
// user issued a request beyond the single static API key (Phase 4), whereas
// the connected module always knows `game.user.isGM`.
//
// Canvas selection reuses `DocumentData`/`DocumentDeleteResult` (shared/src/
// documents.ts) for user document shapes, since a User is a regular Foundry
// Document once loaded.

export const USER_COMMANDS = {
  GET: "userGet",
  CREATE: "userCreate",
  UPDATE: "userUpdate",
  DELETE: "userDelete",
  GET_STATUS: "userGetStatus",
  GET_CANVAS_SELECTION: "userGetCanvasSelection",
} as const;

export interface UserIdInput {
  userId: string;
}

export interface UserCreateInput {
  data: Record<string, unknown>;
}

export interface UserUpdateInput extends UserIdInput {
  changes: Record<string, unknown>;
}

export interface UserStatusResult {
  userId: string;
  /** Whether this user currently has an active connection to the world. */
  active: boolean;
}

export interface CanvasSelectionResult {
  /** The currently-viewed scene's id, or `null` if the connected client has none active (should not happen when a selection exists). */
  sceneId: string | null;
  /** Ids of the TokenDocuments currently controlled/selected on the canvas (`canvas.tokens.controlled`). */
  tokenIds: string[];
}
