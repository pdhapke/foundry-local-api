// Phase 47 — Broadcast Camera View to All Players (receive side), extended
// by Phase 42 to also dispatch UI-notification broadcasts.
//
// Deliberately NOT under module/src/commands/, same reasoning as
// module/src/hooks.ts: everything in commands/ reacts to an inbound
// BridgeRequest via the command dispatcher. This instead reacts to
// Foundry's own always-on multiplayer socket (`game.socket`, distinct from
// the bridge WebSocket Phase 3 set up) — a broadcast that every client with
// this module enabled receives, including players, who may never open a
// bridge connection at all. `game.socket.emit()` on one client is relayed by
// Foundry's server to every *other* connected client but not back to the
// sender itself, which is why each send side (module/src/commands/
// placeables.ts's `canvasPushView`, module/src/commands/notifications.ts's
// `notify`) also applies its effect directly on its own client rather than
// relying on this listener to round-trip back to it.
//
// One `game.socket` event (`MODULE_SOCKET_EVENT`) is shared across every
// broadcast kind rather than registering a new event per phase; each
// message's own `type` field discriminates which one it is.
import {
  MODULE_SOCKET_EVENT,
  type CanvasPushViewMessage,
  type NotifyBroadcastMessage,
} from "@foundry-local-api/shared";

function isCanvasPushViewMessage(value: unknown): value is CanvasPushViewMessage {
  return (
    typeof value === "object" && value !== null && (value as { type?: unknown }).type === "pushView"
  );
}

function isNotifyBroadcastMessage(value: unknown): value is NotifyBroadcastMessage {
  return (
    typeof value === "object" && value !== null && (value as { type?: unknown }).type === "notify"
  );
}

/**
 * Registers the `game.socket` listener for every module-scoped broadcast
 * (Phase 47's view-broadcast, Phase 42's notification broadcast). Called
 * unconditionally from module/src/index.ts's `ready` hook — it must run on
 * every client regardless of whether that client's own bridge WS connection
 * is ever established.
 */
export function registerModuleSocketListener(): void {
  game.socket.on(MODULE_SOCKET_EVENT, (payload: unknown) => {
    if (isCanvasPushViewMessage(payload)) {
      if (canvas) {
        void canvas.animatePan(payload.view);
      }
      return;
    }
    if (isNotifyBroadcastMessage(payload)) {
      ui.notifications.notify(payload.message, payload.notificationType);
    }
  });
}
