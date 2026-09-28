// Standalone MCP stdio entry point that does NOT start its own HTTP
// server/bridge (contrast with index.ts's MCP_STDIO path, which runs the
// full app in-process). Instead it forwards every tool call over HTTP to
// whatever foundry-local-api instance is already listening on
// config.host:config.port — see mcp/http-tool-client.ts.
//
// This is what lets a second MCP client (e.g. a second Claude Code session)
// attach without fighting the first instance for the WebSocket/HTTP port:
// only one process ever binds it; every stdio client spawned after that is
// just an HTTP caller.
//
// Stdout is reserved exclusively for the MCP JSON-RPC stream, same
// constraint as index.ts's MCP_STDIO mode — everything here logs via
// console.error.
// Side-effect-only import, kept first: endpoints/events.ts imports
// `HttpError` from ./app.js, and ./app.js's own top-level code imports
// ./routes/api.js, which calls mountRestEndpoints(allEndpointDescriptors) at
// module-load time — a pre-existing circular reference back through
// endpoints/index.ts. index.ts (the main server entry) never trips this
// because it happens to import app.js before anything reaches
// endpoints/index.ts, so allEndpointDescriptors is already fully
// initialized by the time routes/api.ts's top-level code runs. This import
// reproduces that same evaluation order here; removing it (or reordering
// the imports below) reintroduces a `ReferenceError: Cannot access
// 'allEndpointDescriptors' before initialization` from routes/api.js.
import "./app.js";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ConfigError, loadConfig } from "./config.js";
import {
  bindHttpIntegrationTools,
  createHttpMcpServer,
  type HttpIntegrationBinding,
} from "./mcp/create-http-mcp-server.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Configuration error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const baseUrl = `http://${config.host}:${config.port}`;
  const mcpServer = createHttpMcpServer({ baseUrl, apiKey: config.apiKey });
  const integrationBinding: HttpIntegrationBinding = await bindHttpIntegrationTools(mcpServer, {
    baseUrl,
    apiKey: config.apiKey,
    onRefreshError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Unable to refresh optional MCP integrations: ${message}`);
    },
  });
  const transport = new StdioServerTransport();

  mcpServer
    .connect(transport)
    .then(() => {
      console.error(
        `MCP stdio server connected (mcp-remote) — forwarding tool calls to ${baseUrl}.`,
      );
    })
    .catch((err: unknown) => {
      console.error("Failed to start MCP stdio server:", err);
      process.exit(1);
    });

  let shuttingDown = false;
  function shutdown(signal: string): void {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.error(`\nReceived ${signal}, shutting down.`);
    integrationBinding?.dispose();
    Promise.resolve(mcpServer.close())
      .catch((err: unknown) => {
        console.error("Error closing MCP stdio server:", err);
      })
      .finally(() => process.exit(0));
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

void main().catch((err: unknown) => {
  console.error("Failed to initialize remote MCP stdio server:", err);
  process.exit(1);
});
