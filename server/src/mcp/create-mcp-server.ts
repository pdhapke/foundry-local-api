// Builds the McpServer instance shared by every MCP transport (stdio now,
// SSE later — see PLAN.md Phase 5), wired to the same FoundryClient the REST
// side uses.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { FoundryClient } from "../bridge/foundry-client.js";
import { allEndpointDescriptors } from "../endpoints/index.js";
import { registerMcpTools } from "../endpoints/registry.js";
import { readPackageVersion } from "../version.js";

export function createMcpServer(foundryClient: FoundryClient): McpServer {
  const mcpServer = new McpServer({
    name: "foundry-local-api",
    version: readPackageVersion(),
  });

  registerMcpTools(mcpServer, allEndpointDescriptors, foundryClient);

  return mcpServer;
}
