// Entrypoint for the Foundry module's client-side esmodule.
//
// Registers the bridge URL setting on `init`, then starts the WebSocket
// bridge client on `ready`, per PLAN.md Phase 2 (Foundry Module Bridge
// Client). Real Foundry API command handlers beyond the `ping` proof-of-life
// start with Phase 6's core meta/introspection handlers (./commands/meta.ts).

import {
  BridgeClient,
  getConfiguredApiKey,
  getConfiguredBridgeUrl,
  registerBridgeSettings,
} from "./bridge-client.js";
import { registerHookForwarding } from "./hooks.js";
import { registerModuleSocketListener } from "./socket.js";
import "./command-registry.js";
import "./commands/meta.js";
import "./commands/settings.js";
import "./commands/documents.js";
import "./commands/actors.js";
import "./commands/items.js";
import "./commands/scenes.js";
import "./commands/tokens.js";
import "./commands/journal-pages.js";
import "./commands/rolls.js";
import "./commands/chat.js";
import "./commands/macros.js";
import "./commands/combats.js";
import "./commands/playlists.js";
import "./commands/roll-tables.js";
import "./commands/cards.js";
import "./commands/folders.js";
import "./commands/packs.js";
import "./commands/active-effects.js";
import "./commands/placeables.js";
import "./commands/permissions.js";
import "./commands/files.js";
import "./commands/users.js";
import "./commands/localization.js";
import "./commands/bulk.js";
import "./commands/game-state.js";
import "./commands/dnd5e.js";
import "./commands/digital-tabletops.js";
import "./commands/world-time.js";
import "./commands/notifications.js";

// Set once `ready` constructs the client; `registerBridgeSettings()` is
// called from `init` (before the client exists), but a GM can't reach the
// settings form until the game has actually loaded, so it's always
// populated by the time `onSettingChanged` could fire in practice. The
// optional chaining below is just defensive.
let client: BridgeClient | undefined;

Hooks.once("init", () => {
  registerBridgeSettings(() => client?.reconnect());
});

Hooks.once("ready", () => {
  client = new BridgeClient(getConfiguredBridgeUrl, getConfiguredApiKey);
  client.connect();
  registerHookForwarding(client);
  // Registered unconditionally — must fire on every client (including
  // players, who never open a bridge connection) per PLAN.md's Phase 47/42.
  registerModuleSocketListener();
});
