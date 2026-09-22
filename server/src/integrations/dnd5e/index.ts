// Phase 34 — dnd5e Integration: Detection & Read-Only Data.
//
// First real entry in the Phase 32 integration framework. `detect` matches
// purely on the active system id (PLAN.md's Phase 34 text: `game.system.id
// === 'dnd5e'`) — no `minVersion`/`maxVersion` yet, since this phase's
// read-only endpoints are implemented defensively against the fields it
// reads (see module/src/commands/dnd5e.ts's header comment) rather than
// against one specific dnd5e release.
import type { Integration } from "../types.js";
import { dnd5eEndpointDescriptors } from "./endpoints.js";

export const dnd5eIntegration: Integration = {
  id: "dnd5e",
  kind: "system",
  detect: (activeSystemId) => activeSystemId === "dnd5e",
  endpoints: dnd5eEndpointDescriptors,
};
