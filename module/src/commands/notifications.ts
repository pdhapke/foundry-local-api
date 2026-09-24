// Phase 42 — UI Notifications command handler. Registered against the same
// command dispatcher registry Phase 2 set up (module/src/command-registry.ts)
// and imported for side effects from module/src/index.ts.
//
// `ui.notifications.notify()` only ever affects the calling (bridge-
// connected) client's own screen. `target: "all"` also broadcasts the same
// message over the module-scoped `game.socket` channel Phase 47 built
// (module/src/socket.ts's `registerModuleSocketListener()`), reusing that
// plumbing rather than inventing a second one — mirroring `canvasPushView`'s
// apply-locally-then-broadcast pattern (`game.socket.emit()` is never
// delivered back to the emitting client, so the local call here still has to
// run regardless of `target`).
import {
  MODULE_SOCKET_EVENT,
  NOTIFICATION_COMMANDS,
  type NotifyBroadcastMessage,
  type NotifyInput,
  type NotifyResult,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";

registerCommand(
  NOTIFICATION_COMMANDS.NOTIFY,
  ({ message, type = "info", target = "caller" }: NotifyInput): NotifyResult => {
    ui.notifications.notify(message, type);
    if (target === "all") {
      const broadcast: NotifyBroadcastMessage = { type: "notify", message, notificationType: type };
      game.socket.emit(MODULE_SOCKET_EVENT, broadcast);
    }
    return { delivered: target };
  },
);
