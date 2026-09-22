// Stdio transport glue (Phase 5). Connects the shared McpServer to the
// process's own stdin/stdout — see server/src/index.ts for the `MCP_STDIO`
// gate and the stdout-hygiene constraints that come with turning this on.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { FoundryClient } from "../bridge/foundry-client.js";
import { createMcpServer } from "./create-mcp-server.js";

/** Builds the MCP server, connects it over stdio, and returns it (for logging/shutdown by the caller). */
export async function connectMcpStdio(foundryClient: FoundryClient): Promise<McpServer> {
  const mcpServer = createMcpServer(foundryClient);
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  return mcpServer;
}
