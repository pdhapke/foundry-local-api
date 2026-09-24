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
//
// Phase 44 added target read/write. Phase 25 explicitly scoped itself to
// canvas *selection* (`canvas.tokens.controlled`) and skipped *targeting*
// (`user.targets`) — but targeting is what most systems' attack/save rolls
// actually key off, so it gets its own pair of commands here rather than
// retrofitting the selection shape, mirroring `game.user.targets`'
// independence from `canvas.tokens.controlled` in Foundry's own API.
//
// Phase 50 added the active-GM lookup (`game.users.activeGM`) from the
// backlog: "for workflows which occur on all clients, but where only one
// user should take action" per Foundry's own doc comment — useful for an
// agent that needs to know which single connected client should be treated
// as authoritative for GM-only side effects.

export const USER_COMMANDS = {
  GET: "userGet",
  CREATE: "userCreate",
  UPDATE: "userUpdate",
  DELETE: "userDelete",
  GET_STATUS: "userGetStatus",
  GET_CANVAS_SELECTION: "userGetCanvasSelection",
  GET_TARGETS: "userGetTargets",
  SET_TARGETS: "userSetTargets",
  GET_ACTIVE_GM: "userGetActiveGm",
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

export interface CanvasTargetsResult {
  /** The currently-viewed scene's id, or `null` if the connected client has none active (should not happen when a target exists). */
  sceneId: string | null;
  /** Ids of the TokenDocuments currently targeted by the connected user (`game.user.targets`). */
  tokenIds: string[];
}

export interface SetCanvasTargetsInput {
  /** TokenDocument ids to target on the currently-viewed scene. */
  tokenIds: string[];
  /** When true, adds to the existing target set instead of replacing it. Defaults to false (replace). */
  additive?: boolean | undefined;
}

export interface ActiveGmResult {
  /** The active GM's user id, or `null` if no GM is currently connected (`game.users.activeGM`). */
  userId: string | null;
}
