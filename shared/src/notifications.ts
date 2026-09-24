// Phase 42 — UI Notifications. Wraps `ui.notifications.notify()`, Foundry's
// client-local toast/banner mechanism — distinct from Phase 14's chat log
// (persistent, shared) and Phase 38's world-pause banner (a single boolean
// state, not an arbitrary message). Useful for an agent that wants to surface
// a one-off status update without polluting the chat log.
//
// `ui.notifications.notify()` only ever affects the calling client's own
// screen — it does not propagate to other connected clients the way a
// document write does. `target: "all"` (default `"caller"`, matching that
// historical single-client behavior) relays the same message over the
// module-scoped `game.socket` broadcast channel Phase 47 built
// (shared/src/socket.ts), reusing its plumbing rather than inventing a
// second one, so the message can also reach players and not just the GM's
// own bridge-connected screen.
//
// PLAN.md's original Phase 42 text wrote the notification level as
// `'info'|'warn'|'error'`; corrected here to `NotificationType` below, since
// Foundry's actual, stable `Notifications#notify(message, type)` accepts
// `"info" | "warning" | "error"`, never `"warn"`.

export const NOTIFICATION_COMMANDS = {
  NOTIFY: "notify",
} as const;

export type NotificationType = "info" | "warning" | "error";

export interface NotifyInput {
  message: string;
  type?: NotificationType | undefined;
  /** `"caller"` (default): only the bridge-connected client shows it. `"all"`: every connected client does. */
  target?: "caller" | "all" | undefined;
}

/** Confirms which client(s) actually received the notification. */
export interface NotifyResult {
  delivered: "caller" | "all";
}

/** The `target: "all"` broadcast payload, carried over `MODULE_SOCKET_EVENT` (shared/src/socket.ts). */
export interface NotifyBroadcastMessage {
  type: "notify";
  message: string;
  notificationType: NotificationType;
}
