// Entrypoint for the Foundry module's client-side esmodule.
//
// Registers the bounded player/TV opt-in on `init`, then starts the WebSocket
// bridge client automatically on `ready`, per PLAN.md Phase 2 (Foundry Module Bridge
// Client). Real Foundry API command handlers beyond the `ping` proof-of-life
// start with Phase 6's core meta/introspection handlers (./commands/meta.ts).

import {
  BridgeClient,
  getBridgeUrlForCurrentPage,
  registerBridgeSettings,
} from "./bridge-client.js";
import { registerBridgeEnrollmentQuery } from "./bridge-enrollment.js";
import { registerHookForwarding } from "./hooks.js";
import { registerModuleSocketListener } from "./socket.js";
import { registerMovementEventHooks } from "./movement-event-hooks.js";
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
import "./commands/adventures.js";
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
import "./commands/trails-of-destiny.js";
import "./commands/schema-discovery.js";
import "./commands/effective-user.js";
import "./commands/transactions.js";
import "./commands/fog-exploration.js";
import "./commands/scene-render.js";
import "./commands/client-readiness.js";
import "./commands/client-identity.js";
import "./commands/embedded-children.js";
import "./commands/asset-lifecycle.js";
import "./commands/reference-audit.js";
import "./commands/collision-topology.js";
import "./commands/dnd5e-simulation.js";
import "./commands/movement-events.js";

// Set once `ready` constructs the client; `registerBridgeSettings()` is
// called from `init` (before the client exists), but a GM can't reach the
// settings form until the game has actually loaded, so it's always
// populated by the time `onSettingChanged` could fire in practice. The
// optional chaining below is just defensive.
let client: BridgeClient | undefined;

Hooks.once("init", () => {
  registerBridgeSettings(() => client?.handleSettingsChanged());
  registerBridgeEnrollmentQuery(() => client);
});

Hooks.once("ready", () => {
  registerModuleSocketListener();
  try {
    const bridgeUrl = getBridgeUrlForCurrentPage();
    client = new BridgeClient(() => bridgeUrl);
    const installedModule = game.modules.get("foundry-local-api") as unknown as
      { api?: Record<string, unknown> } | undefined;
    const bridge = client.extensionApi();
    if (installedModule) installedModule.api = { ...installedModule.api, bridge };
    (Hooks as typeof Hooks & { callAll(hook: string, value: unknown): void }).callAll(
      "foundry-local-api.bridgeReady",
      bridge,
    );
    // Both ready callbacks finish before negotiation captures command capabilities.
    const readyClient = client;
    queueMicrotask(() => readyClient.connect());
    registerHookForwarding(client);
    registerMovementEventHooks(client);
  } catch {
    console.error("[foundry-local-api] failed to initialize the bridge client");
  }
});
import "./commands/session-actions.js";
import "./commands/attack-actions.js";
import "./commands/attack-sequences.js";
import "./commands/world-documents.js";
import "./commands/gm-combat.js";
import "./commands/gm-activities.js";
import "./commands/gm-character.js";
import "./commands/gm-tv.js";
import "./commands/gm-receipts.js";
import "./commands/gm-scene.js";
