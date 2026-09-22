// Entrypoint for the Foundry module's client-side esmodule.
//
// Registers the bridge URL setting on `init`, then starts the WebSocket
// bridge client on `ready`, per PLAN.md Phase 2 (Foundry Module Bridge
// Client). Real Foundry API command handlers beyond the `ping` proof-of-life
// start Phase 6+.

import { BridgeClient, getConfiguredBridgeUrl, registerBridgeSettings } from "./bridge-client.js";
import "./command-registry.js";

Hooks.once("init", () => {
  registerBridgeSettings();
});

Hooks.once("ready", () => {
  const client = new BridgeClient(getConfiguredBridgeUrl);
  client.connect();
});
