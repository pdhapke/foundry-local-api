// Stdio transport glue (Phase 5). Connects the shared McpServer to the
// process's own stdin/stdout — see server/src/index.ts for the `MCP_STDIO`
// gate and the stdout-hygiene constraints that come with turning this on.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { FoundryClient } from "../bridge/foundry-client.js";
import type { FoundryEventBus } from "../events/event-bus.js";
import type { FoundationRuntime } from "../foundations/runtime.js";
import type { IntegrationManager } from "../integrations/manager.js";
import { createMcpServer, disposeMcpServerIntegrations } from "./create-mcp-server.js";

/** Builds the MCP server, connects it over stdio, and returns it (for logging/shutdown by the caller). */
export async function connectMcpStdio(
  foundryClient: FoundryClient,
  integrationManager: IntegrationManager,
  eventBus?: FoundryEventBus,
  foundations?: FoundationRuntime,
): Promise<McpServer> {
  const mcpServer = createMcpServer(foundryClient, integrationManager, eventBus, foundations);
  const transport = new StdioServerTransport();
  try {
    await mcpServer.connect(transport);
    return mcpServer;
  } catch (error) {
    // A failed connect never reaches the SDK's normal onclose callback.
    disposeMcpServerIntegrations(mcpServer);
    throw error;
  }
}
