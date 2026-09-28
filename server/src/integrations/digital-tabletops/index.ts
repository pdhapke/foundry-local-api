// Phase 52 — Digital TableTops Integration (Battlemap Control).
//
// Second `kind: "module"` integration (dnd5e, Phases 34-35, is
// `kind: "system"`) — the first real exercise of that half of the Phase 32
// framework. Target: the third-party `digital-tabletops` module, detected
// purely by module id/active state (no `minVersion`/`maxVersion` — this
// integration is implemented against the one shipped version, 1.0.6, read
// directly from `dtt.js`, same no-version-pin precedent as dnd5e).
import type { Integration } from "../types.js";
import { dttEndpointDescriptors } from "./endpoints.js";

export const dttIntegration: Integration = {
  id: "digital-tabletops",
  toolPrefix: "dtt_",
  kind: "module",
  detect: (_activeSystemId, activeModuleIds) => activeModuleIds.includes("digital-tabletops"),
  endpoints: dttEndpointDescriptors,
};
