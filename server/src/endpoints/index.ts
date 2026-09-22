// Full list of endpoint descriptors, REST+MCP shared infrastructure (moved
// out of mcp/ in Phase 6 — see registry.ts). Every later phase appends its
// own descriptor array here.
import { actorEndpointDescriptors } from "./actors.js";
import { journalEntryEndpointDescriptors } from "./documents.js";
import { healthEndpointDescriptor } from "./health.js";
import { metaEndpointDescriptors } from "./meta.js";
import { settingsEndpointDescriptors } from "./settings.js";
import type { AnyEndpointDescriptor } from "./types.js";

export const allEndpointDescriptors: AnyEndpointDescriptor[] = [
  healthEndpointDescriptor,
  ...metaEndpointDescriptors,
  ...settingsEndpointDescriptors,
  ...journalEntryEndpointDescriptors,
  ...actorEndpointDescriptors,
];

export { makeDocumentEndpoints } from "./documents.js";
export type { DocumentEndpointConfig } from "./documents.js";
export type { AnyEndpointDescriptor, EndpointContext, EndpointDescriptor } from "./types.js";
