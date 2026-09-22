// Shared endpoint descriptor (Phase 5, relocated out of mcp/ in Phase 6).
// `foundry_status` has no REST wiring — see its comment in types.ts for why
// — it only ever becomes an MCP tool.
import { readPackageVersion } from "../version.js";
import type { EndpointDescriptor } from "./types.js";

export const healthEndpointDescriptor: EndpointDescriptor<
  void,
  { status: "ok"; uptime: number; version: string }
> = {
  name: "foundry_status",
  description:
    "Foundry Local API server status (mirrors GET /health): liveness, uptime, and server version.",
  handler: () => ({
    status: "ok",
    uptime: process.uptime(),
    version: readPackageVersion(),
  }),
};
