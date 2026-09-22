// Phase 32 — MCP-side apply/remove for the dynamic integration set.
//
// Mirrors router.ts's job on the REST side, but MCP tools can't be
// rebuilt-from-scratch the way an Express router can: the MCP SDK's
// `McpServer.registerTool()` returns a `RegisteredTool` handle with its own
// `.remove()` (see node_modules/@modelcontextprotocol/sdk/dist/esm/server/
// mcp.d.ts), so tools are added/removed incrementally instead, tracked per
// integration id in a module-level map.
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { FoundryClient } from "../bridge/foundry-client.js";
import { registerMcpTools } from "../endpoints/registry.js";
import type { FoundryEventBus } from "../events/event-bus.js";
import type { Integration } from "./types.js";

/** Integration id -> the RegisteredTool handles currently registered for it. */
const trackedTools = new Map<string, RegisteredTool[]>();

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
  const activeIds = new Set(active.map((i) => i.id));
  let changed = false;

  for (const [id, tools] of trackedTools) {
    if (!activeIds.has(id)) {
      for (const tool of tools) {
        tool.remove();
      }
      trackedTools.delete(id);
      changed = true;
    }
  }

  for (const integration of active) {
    if (trackedTools.has(integration.id)) {
      continue;
    }
    const tools = registerMcpTools(mcpServer, integration.endpoints, foundryClient, eventBus);
    trackedTools.set(integration.id, tools);
    changed = true;
  }

  if (changed) {
    mcpServer.sendToolListChanged();
  }
}
