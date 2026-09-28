// Phase 32 — MCP-side apply/remove for the dynamic integration set.
//
// Mirrors router.ts's job on the REST side, but MCP tools can't be
// rebuilt-from-scratch the way an Express router can: the MCP SDK's
// `McpServer.registerTool()` returns a `RegisteredTool` handle with its own
// `.remove()` (see node_modules/@modelcontextprotocol/sdk/dist/esm/server/
// mcp.d.ts), so tools are added/removed incrementally instead, tracked per
// integration id for each McpServer independently.
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { FoundryClient } from "../bridge/foundry-client.js";
import { registerMcpTools } from "../endpoints/registry.js";
import type { FoundryEventBus } from "../events/event-bus.js";
import type { IntegrationManager } from "./manager.js";
import type { Integration } from "./types.js";

interface TrackedServerTools {
  /** Integration id -> the RegisteredTool handles registered on this server. */
  integrations: Map<string, RegisteredTool[]>;
  initialized: boolean;
}

/**
 * Dynamic tool state belongs to the concrete MCP server that owns the
 * registrations. Weak keys also ensure an abandoned server cannot be kept
 * alive solely by this module.
 */
const trackedTools = new WeakMap<McpServer, TrackedServerTools>();

function getTrackedServerTools(mcpServer: McpServer): TrackedServerTools {
  let tracked = trackedTools.get(mcpServer);
  if (!tracked) {
    tracked = { integrations: new Map(), initialized: false };
    trackedTools.set(mcpServer, tracked);
  }
  return tracked;
}

/**
 * Applies the given `active` integration set to `mcpServer`'s tool set:
 * removes tools for any previously-tracked integration no longer in
 * `active`, registers tools for any newly-active integration not yet
 * tracked, and — only if the active set actually changed — sends a single
 * `notifications/tools/list_changed` (via `mcpServer.sendToolListChanged()`)
 * so a connected MCP client refreshes its tool list without reconnecting.
 */
export function applyActiveIntegrationTools(
  mcpServer: McpServer,
  active: Integration[],
  foundryClient: FoundryClient,
  eventBus?: FoundryEventBus,
): void {
  const tracked = getTrackedServerTools(mcpServer);
  const activeIds = new Set(active.map((i) => i.id));
  let changed = false;

  for (const [id, tools] of tracked.integrations) {
    if (!activeIds.has(id)) {
      for (const tool of tools) {
        tool.remove();
      }
      tracked.integrations.delete(id);
      changed = true;
    }
  }

  for (const integration of active) {
    if (tracked.integrations.has(integration.id)) {
      continue;
    }
    const tools = registerMcpTools(mcpServer, integration.endpoints, foundryClient, eventBus);
    tracked.integrations.set(integration.id, tools);
    changed = true;
  }

  // A server receives its initial catalog before it begins serving requests,
  // so there is no connected client to refresh. Only real changes after that
  // initialization need a list-changed notification.
  if (tracked.initialized && changed) {
    mcpServer.sendToolListChanged();
  }
  tracked.initialized = true;
}

/** Removes every dynamic integration tool owned by one MCP server. */
export function cleanupActiveIntegrationTools(mcpServer: McpServer): void {
  const tracked = trackedTools.get(mcpServer);
  if (!tracked) {
    return;
  }

  for (const tools of tracked.integrations.values()) {
    for (const tool of tools) {
      tool.remove();
    }
  }
  trackedTools.delete(mcpServer);
}

/**
 * Initializes one MCP server from the manager's current snapshot and keeps it
 * synchronized until the returned disposer is called.
 */
export function bindActiveIntegrationTools(
  mcpServer: McpServer,
  integrationManager: IntegrationManager,
  foundryClient: FoundryClient,
  eventBus?: FoundryEventBus,
): () => void {
  applyActiveIntegrationTools(mcpServer, integrationManager.getActive(), foundryClient, eventBus);
  const unsubscribe = integrationManager.onChange((active) => {
    applyActiveIntegrationTools(mcpServer, active, foundryClient, eventBus);
  });

  return () => {
    unsubscribe();
    cleanupActiveIntegrationTools(mcpServer);
  };
}
