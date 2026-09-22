// Full list of endpoint descriptors, REST+MCP shared infrastructure (moved
// out of mcp/ in Phase 6 — see registry.ts). Every later phase appends its
// own descriptor array here.
import { healthEndpointDescriptor } from "./health.js";
import { metaEndpointDescriptors } from "./meta.js";
import { settingsEndpointDescriptors } from "./settings.js";
import type { AnyEndpointDescriptor } from "./types.js";

export const allEndpointDescriptors: AnyEndpointDescriptor[] = [
  healthEndpointDescriptor,
  ...metaEndpointDescriptors,
  ...settingsEndpointDescriptors,
];

export type { AnyEndpointDescriptor, EndpointContext, EndpointDescriptor } from "./types.js";
