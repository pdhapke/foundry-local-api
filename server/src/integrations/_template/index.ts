// TEMPLATE — see README.md in this directory. Deliberately NOT imported by
// server/src/integrations/registry.ts.
import { templateEndpointDescriptors } from "./endpoints.js";
import type { Integration } from "../types.js";

export const templateIntegration: Integration = {
  id: "_template", // TODO: your integration's exact package id and REST namespace, e.g. "pf2e".
  // toolPrefix: "example_", // Optional: defaults to `${id}_`; set when MCP names need a different portable namespace.
  kind: "system", // TODO: "system" (a game system like dnd5e/pf2e) or "module" (a companion module).
  detect: (activeSystemId) => activeSystemId === "_template", // TODO: real detection — for kind:"module" check activeModuleIds.includes("your-module-id") instead.
  endpoints: templateEndpointDescriptors,
};
