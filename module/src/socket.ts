// Phase 47 — Broadcast Camera View to All Players (receive side).
//
// Deliberately NOT under module/src/commands/, same reasoning as
// module/src/hooks.ts: everything in commands/ reacts to an inbound
// BridgeRequest via the command dispatcher. This instead reacts to
// Foundry's own always-on multiplayer socket (`game.socket`, distinct from
// the bridge WebSocket Phase 3 set up) — a broadcast that every client with
// this module enabled receives, including players, who may never open a
// bridge connection at all. `game.socket.emit()` on one client is relayed by
// Foundry's server to every *other* connected client but not back to the
// sender itself, which is why the send side
// (module/src/commands/placeables.ts's `canvasPushView` handler) also
// applies the pan directly on its own client rather than relying on this
// listener to round-trip back to it.
import {
  CANVAS_PUSH_VIEW_SOCKET_EVENT,
  type CanvasPushViewMessage,
} from "@foundry-local-api/shared";

function isCanvasPushViewMessage(value: unknown): value is CanvasPushViewMessage {
  return (
    typeof value === "object" && value !== null && (value as { type?: unknown }).type === "pushView"
  );
}

/**
 * Registers the `game.socket` listener for Phase 47's view-broadcast.
 * Called unconditionally from module/src/index.ts's `ready` hook — it must
 * run on every client regardless of whether that client's own bridge WS
 * connection is ever established.
 */
export function registerCanvasBroadcastListener(): void {
  game.socket.on(CANVAS_PUSH_VIEW_SOCKET_EVENT, (payload: unknown) => {
    if (!canvas || !isCanvasPushViewMessage(payload)) {
      return;
    }
    void canvas.animatePan(payload.view);
  });
}
