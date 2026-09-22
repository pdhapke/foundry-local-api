// Builds the McpServer instance shared by every MCP transport (stdio now,
// SSE later — see PLAN.md Phase 5), wired to the same FoundryClient the REST
// side uses.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { FoundryClient } from "../bridge/foundry-client.js";
import { allEndpointDescriptors } from "../endpoints/index.js";
import { registerMcpTools } from "../endpoints/registry.js";
import type { FoundryEventBus } from "../events/event-bus.js";
import { readPackageVersion } from "../version.js";

/**
 * `eventBus` is optional (Phase 26): the descriptor-based recent-events tool
 * (server/src/endpoints/events.ts) uses it via `EndpointContext`, but every
 * other tool doesn't, and callers that don't have one yet (there are none in
 * this codebase, but keeping the param optional avoids forcing one on any
 * future caller) still get a working server.
 */
export function createMcpServer(
  foundryClient: FoundryClient,
  eventBus?: FoundryEventBus,
): McpServer {
  const mcpServer = new McpServer({
    name: "foundry-local-api",
    version: readPackageVersion(),
  });

  registerMcpTools(mcpServer, allEndpointDescriptors, foundryClient, eventBus);

  return mcpServer;
}
