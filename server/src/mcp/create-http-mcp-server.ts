// HTTP-forwarding counterpart to create-mcp-server.ts. Builds the same tool
// catalog (from allEndpointDescriptors) but wires each tool to call an
// already-running instance's REST API over HTTP (http-tool-client.ts)
// instead of an in-process FoundryClient — see mcp-remote.ts for why.
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ModuleInfo, SystemInfo } from "@foundry-local-api/shared";

import { allEndpointDescriptors } from "../endpoints/index.js";
import { detectActiveIntegrations } from "../integrations/manager.js";
import { integrations as registeredIntegrations } from "../integrations/registry.js";
import type { Integration } from "../integrations/types.js";
import { readPackageVersion } from "../version.js";
import { registerHttpMcpTools, type HttpMcpClientOptions } from "./http-tool-client.js";

const API_KEY_HEADER = "x-api-key";
const DEFAULT_INTEGRATION_POLL_INTERVAL_MS = 5_000;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;

export interface HttpIntegrationSyncOptions extends HttpMcpClientOptions {
  /** Overrideable for focused tests; false disables automatic polling. */
  pollIntervalMs?: number | false;
  discoveryTimeoutMs?: number;
  integrations?: Integration[];
  onRefreshError?: (error: unknown) => void;
}

export interface HttpIntegrationBinding {
  /** Performs one refresh. False means it was disposed before completion. */
  refresh(): Promise<boolean>;
  dispose(): void;
}

export function createHttpMcpServer(options: HttpMcpClientOptions): McpServer {
  const mcpServer = new McpServer({
    name: "foundry-local-api",
    version: readPackageVersion(),
  });

  registerHttpMcpTools(mcpServer, allEndpointDescriptors, options);

  return mcpServer;
}

async function fetchJson<T>(
  path: string,
  options: HttpMcpClientOptions,
  timeoutMs: number,
): Promise<T> {
  const response = await fetch(`${options.baseUrl}${path}`, {
    headers: { [API_KEY_HEADER]: options.apiKey },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await response.json()) as unknown;
  if (!response.ok) {
    throw new Error(`Integration discovery ${path} failed with HTTP ${response.status}`);
  }
  return body as T;
}

/**
 * Adds/removes HTTP-forwarded optional tools from one remote stdio server.
 * Discovery is authenticated and polling is serialized: the next timer is
 * scheduled only after the current refresh settles. Failed refreshes leave
 * the last known-good catalog untouched.
 */
export async function bindHttpIntegrationTools(
  mcpServer: McpServer,
  options: HttpIntegrationSyncOptions,
): Promise<HttpIntegrationBinding> {
  const catalog = options.integrations ?? registeredIntegrations;
  const tracked = new Map<string, RegisteredTool[]>();
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_INTEGRATION_POLL_INTERVAL_MS;
  const discoveryTimeoutMs = options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  let initialized = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<boolean> | undefined;

  const reportRefreshError = (error: unknown): void => {
    try {
      options.onRefreshError?.(error);
    } catch {
      // Reporting is advisory; a logger failure must not break the poll loop.
    }
  };

  const apply = (active: Integration[]): void => {
    const activeIds = new Set(active.map((integration) => integration.id));
    let changed = false;

    for (const [id, tools] of tracked) {
      if (!activeIds.has(id)) {
        for (const tool of tools) tool.remove();
        tracked.delete(id);
        changed = true;
      }
    }

    for (const integration of active) {
      if (!tracked.has(integration.id)) {
        tracked.set(
          integration.id,
          registerHttpMcpTools(mcpServer, integration.endpoints, options, "/api/integrations"),
        );
        changed = true;
      }
    }

    if (initialized && changed) mcpServer.sendToolListChanged();
    initialized = true;
  };

  const refreshOnce = async (): Promise<boolean> => {
    const [system, modules] = await Promise.all([
      fetchJson<SystemInfo>("/api/system", options, discoveryTimeoutMs),
      fetchJson<ModuleInfo[]>("/api/modules", options, discoveryTimeoutMs),
    ]);
    if (disposed) return false;
    apply(detectActiveIntegrations(system, modules, catalog));
    return true;
  };

  const refresh = (): Promise<boolean> => {
    if (disposed) return Promise.resolve(false);
    if (inFlight) return inFlight;
    inFlight = refreshOnce().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  const scheduleNext = (): void => {
    if (disposed || pollIntervalMs === false) return;
    timer = setTimeout(() => {
      void refresh().catch(reportRefreshError).finally(scheduleNext);
    }, pollIntervalMs);
    timer.unref?.();
  };

  try {
    await refresh();
  } catch (error) {
    // A remote can start before the main HTTP server/bridge is ready. Keep
    // the empty last-known catalog and let the bounded poll loop recover.
    reportRefreshError(error);
    initialized = true;
  }
  scheduleNext();

  return {
    refresh: async () => {
      return refresh();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      for (const tools of tracked.values()) {
        for (const tool of tools) tool.remove();
      }
      tracked.clear();
    },
  };
}
