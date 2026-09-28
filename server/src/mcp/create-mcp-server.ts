// Builds the McpServer instance shared by every MCP transport (stdio now,
// SSE later — see PLAN.md Phase 5), wired to the same FoundryClient the REST
// side uses.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { FoundryClient } from "../bridge/foundry-client.js";
import { allEndpointDescriptors } from "../endpoints/index.js";
import { registerMcpTools } from "../endpoints/registry.js";
import type { FoundryEventBus } from "../events/event-bus.js";
import type { FoundationRuntime } from "../foundations/runtime.js";
import type { IntegrationManager } from "../integrations/manager.js";
import { bindActiveIntegrationTools } from "../integrations/mcp-tools.js";
import { readPackageVersion } from "../version.js";

const integrationDisposers = new WeakMap<McpServer, () => void>();

/**
 * Releases the optional-integration subscription owned by one in-process MCP
 * server. Exported for the narrow case where transport connection fails before
 * the SDK can deliver its normal close callback.
 */
export function disposeMcpServerIntegrations(mcpServer: McpServer): void {
  integrationDisposers.get(mcpServer)?.();
}

/**
 * `eventBus` is optional (Phase 26): the descriptor-based recent-events tool
 * (server/src/endpoints/events.ts) uses it via `EndpointContext`, but every
 * other tool doesn't, and callers that don't have one yet (there are none in
 * this codebase, but keeping the param optional avoids forcing one on any
 * future caller) still get a working server.
 */
export function createMcpServer(
  foundryClient: FoundryClient,
  integrationManager: IntegrationManager,
  eventBus?: FoundryEventBus,
  foundations?: FoundationRuntime,
): McpServer {
  const mcpServer = new McpServer({
    name: "foundry-local-api",
    version: readPackageVersion(),
  });

  registerMcpTools(mcpServer, allEndpointDescriptors, foundryClient, eventBus, foundations);

  // Apply the manager's already-active snapshot before the transport starts,
  // then keep this concrete server synchronized for its whole connection.
  // This is deliberately per McpServer: every Streamable HTTP session owns an
  // independent catalog and subscription.
  const unbind = bindActiveIntegrationTools(mcpServer, integrationManager, foundryClient, eventBus);
  let disposed = false;
  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    integrationDisposers.delete(mcpServer);
    unbind();
  };
  integrationDisposers.set(mcpServer, dispose);

  // McpServer delegates connection lifecycle to its underlying Server. Its
  // onclose callback runs for explicit close, HTTP DELETE, and peer disconnect.
  mcpServer.server.onclose = dispose;

  return mcpServer;
}
