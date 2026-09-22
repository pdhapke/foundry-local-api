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

Hooks.once("init", () => {
  registerBridgeSettings();
});

Hooks.once("ready", () => {
  const client = new BridgeClient(getConfiguredBridgeUrl, getConfiguredApiKey);
  client.connect();
});
