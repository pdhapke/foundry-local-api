// Shared endpoint descriptors (Phase 5). Only one entry so far —
// `foundry_status` — with no REST wiring (see its comment in types.ts for
// why). Phase 6 adds the first REST-wired descriptors here.
import { readPackageVersion } from "../version.js";
import type { EndpointDescriptor } from "./types.js";

const foundryStatus: EndpointDescriptor<void, { status: "ok"; uptime: number; version: string }> = {
  name: "foundry_status",
  description:
    "Foundry Local API server status (mirrors GET /health): liveness, uptime, and server version.",
  handler: () => ({
    status: "ok",
    uptime: process.uptime(),
    version: readPackageVersion(),
  }),
};

export const endpointDescriptors: EndpointDescriptor[] = [foundryStatus];
