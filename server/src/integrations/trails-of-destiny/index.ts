import type { Integration } from "../types.js";
import { trailsEndpointDescriptors } from "./endpoints.js";

/** Optional Trails of Destiny system integration; registered in Phase 6. */
export const trailsOfDestinyIntegration: Integration = {
  id: "trails-of-destiny",
  toolPrefix: "trails_",
  kind: "system",
  detect: (activeSystemId) => activeSystemId === "trails-of-destiny",
  minVersion: "0.1.0",
  endpoints: trailsEndpointDescriptors,
};
