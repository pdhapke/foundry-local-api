// Phase 47 — the module-scoped `game.socket` event name every client-to-
// client broadcast in this project rides on (Foundry's own always-on
// multiplayer socket, distinct from the bridge WebSocket set up in Phase 3).
// One event name is reused for every broadcast kind rather than registering
// a new `game.socket` event per phase; each message's own `type` field
// discriminates which broadcast it is (see module/src/socket.ts's listener).
// Originally lived inline in shared/src/placeables.ts as
// `CANVAS_PUSH_VIEW_SOCKET_EVENT`; pulled out to its own file once Phase 42
// became this channel's second message kind alongside Phase 47's own
// `CanvasPushViewMessage` (shared/src/placeables.ts) — a domain-neutral name
// no longer implies it's placeable/canvas-specific.
export const MODULE_SOCKET_EVENT = "module.foundry-local-api";
