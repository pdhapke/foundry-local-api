// Builds the McpServer instance shared by every MCP transport (stdio now,
// SSE later — see PLAN.md Phase 5), wired to the same FoundryClient the REST
// side uses.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Router } from "express";

import type { FoundryClient } from "../bridge/foundry-client.js";
import { readPackageVersion } from "../version.js";
import { endpointDescriptors } from "./endpoints.js";
import { registerEndpoint } from "./registry.js";

export function createMcpServer(foundryClient: FoundryClient): McpServer {
  const mcpServer = new McpServer({
    name: "foundry-local-api",
    version: readPackageVersion(),
  });

  // No descriptor has REST wiring yet (Phase 5's only entry, `foundry_status`,
  // deliberately doesn't — see types.ts), so nothing mounts this anywhere
  // real yet. Created unconditionally anyway: it's harmless, and every
  // descriptor from Phase 6 onward needs somewhere to register its route.
  const router = Router();

  for (const descriptor of endpointDescriptors) {
    registerEndpoint(descriptor, { router, mcpServer, foundryClient });
  }

  return mcpServer;
}
