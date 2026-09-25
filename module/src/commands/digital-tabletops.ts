// Phase 52 — Digital TableTops Integration (Battlemap Control), module-side
// command handlers. Registered against the same command dispatcher registry
// Phase 2 set up (module/src/command-registry.ts) and imported for side
// effects from module/src/index.ts. Only ever invoked when the connected
// world has the third-party `digital-tabletops` module active
// (server/src/integrations/digital-tabletops/index.ts's `detect`).
//
// *** IMPORTANT — NOT live-verified against a real Foundry + digital-
// tabletops session with a real or simulated "TV" client. *** Unlike
// dnd5e (Phases 34-35), the exact payload shapes here were read directly out
// of the installed `digital-tabletops` module's own source
// (`Data/modules/digital-tabletops/dtt.js`, v1.0.6) rather than guessed from
// docs, so the socket action name/field names below are high-confidence —
// but no live TV client was available to confirm the emitted messages are
// actually received and applied as expected. Flag for a live smoke-test pass
// alongside the other not-yet-verified phases.
//
// `"module.digital-tabletops"` is a THIRD-PARTY socket channel name, owned by
// the `digital-tabletops` module itself — distinct from this project's own
// `MODULE_SOCKET_EVENT` (@foundry-local-api/shared's ./socket.ts, channel
// `"module.foundry-local-api"`). Kept as a local constant here rather than
// exported from shared/, since it's meaningless outside this one
// integration.
import {
  DTT_COMMANDS,
  type DttAckResult,
  type DttPanInput,
  type DttStatusResult,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";

const DTT_SOCKET_EVENT = "module.digital-tabletops";

registerCommand(
  DTT_COMMANDS.PAN,
  ({ x, y, targetWidth, targetHeight }: DttPanInput): DttAckResult => {
    // dtt.js's own listener (lines 90-104 of the installed copy): pans to
    // x/y, and additionally fits to targetWidth/targetHeight when both are
    // given. `game.socket.emit()` is never delivered back to this (sending)
    // client — only every *other* connected client, which is exactly the "TV"
    // user's browser this is meant to reach.
    game.socket.emit(DTT_SOCKET_EVENT, { action: "panCanvas", x, y, targetWidth, targetHeight });
    return { acknowledged: true };
  },
);

registerCommand(DTT_COMMANDS.SCALE_TO_PHYSICAL, (): DttAckResult => {
  // dtt.js's `scaleTV` scene-control button (lines 183-195 of the installed
  // copy): sets the TV client's zoom so 1 grid unit = 1 real-world
  // inch/mm, per its own `display-width` setting.
  game.socket.emit(DTT_SOCKET_EVENT, { action: "panCanvas", scale: "physical" });
  return { acknowledged: true };
});

registerCommand(DTT_COMMANDS.GET_STATUS, (): DttStatusResult => {
  let tvUser: DttStatusResult["tvUser"] = { found: false, active: false };
  for (const user of game.users.values()) {
    if (user.name.toLowerCase() === "tv") {
      tvUser = { found: true, active: user.active, name: user.name };
      break;
    }
  }

  return {
    // Trivially true — this command only ever runs while the
    // digital-tabletops integration is active (this file's own header
    // comment), but kept as an explicit field so a caller doesn't have to
    // infer that from context.
    moduleActive: true,
    tvUser,
    settings: {
      hideUI: game.settings.get<boolean>("digital-tabletops", "hideUI"),
      lockPan: game.settings.get<boolean>("digital-tabletops", "lockPan"),
      displayWidth: game.settings.get<number>("digital-tabletops", "display-width"),
      portNumber: game.settings.get<number>("digital-tabletops", "port-number"),
    },
  };
});
