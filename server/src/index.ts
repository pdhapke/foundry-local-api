// Bootstraps the standalone server process: loads config, builds the
// Express app, starts listening, and wires graceful shutdown.
import http from "node:http";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createApp, createDefaultRequestLogger } from "./app.js";
import { FoundryClient } from "./bridge/foundry-client.js";
import { BridgeGateway } from "./bridge/gateway.js";
import { ConfigError, loadConfig, type AppConfig } from "./config.js";
import { FoundryEventBus } from "./events/event-bus.js";
import { IntegrationManager } from "./integrations/manager.js";
import { applyActiveIntegrationTools } from "./integrations/mcp-tools.js";
import { integrations } from "./integrations/registry.js";
import { applyActiveIntegrations } from "./integrations/router.js";
import { connectMcpStdio } from "./mcp/index.js";

function main(): void {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Configuration error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  // When MCP_STDIO is on, this process's stdout is reserved exclusively for
  // the MCP JSON-RPC stream (see connectMcpStdio below) — nothing else may
  // write to it, so the request logger is redirected to stderr instead.
  // Behavior is byte-for-byte unchanged (stdout logger) when it's off.
  const app = createApp({
    isDevelopment: config.isDevelopment,
    apiKey: config.apiKey,
    corsAllowedOrigins: config.corsAllowedOrigins,
    rateLimitWindowMs: config.rateLimitWindowMs,
    rateLimitMax: config.rateLimitMax,
    ...(config.mcpStdio ? { requestLogger: createDefaultRequestLogger(console.error) } : {}),
  });
  const server = http.createServer(app);

  // Bridge WS gateway (Phase 3), mounted on the same http.Server/port at
  // `/bridge`, plus the FoundryClient abstraction route handlers will use
  // from Phase 6 onward to round-trip commands to the connected module.
  // Stashed on app.locals so future route modules can reach it via
  // `req.app.locals.foundryClient` without a separate wiring mechanism.
  // The same API key (Phase 4) gates the WS upgrade, since `/bridge` has no
  // auth of its own otherwise.
  const gateway = new BridgeGateway(server, { apiKey: config.apiKey });
  const foundryClient = new FoundryClient(gateway, {
    defaultTimeoutMs: config.bridgeTimeoutMs,
  });
  app.locals["foundryClient"] = foundryClient;

  // Optional integration framework (Phase 32) — detects which registered
  // integrations (server/src/integrations/registry.js, empty until Phase 34
  // adds dnd5e) are active in the connected world, and re-detects every time
  // a bridge connection is (re-)established. The REST router
  // (server/src/integrations/router.js) is subscribed unconditionally, since
  // it works with or without MCP_STDIO; the MCP side is subscribed further
  // below, once the MCP server actually exists.
  const integrationManager = new IntegrationManager(foundryClient, integrations);
  integrationManager.onChange((active) => {
    applyActiveIntegrations(active);
  });
  gateway.onConnectionEstablished(() => {
    integrationManager.refresh().catch((err: unknown) => {
      console.error("[integrations] detection failed:", err instanceof Error ? err.message : err);
    });
  });

  // Server-side event bus (Phase 26) — buffers/fans out the module's pushed
  // hook events (FoundryClient.onEvent()) to the SSE route
  // (server/src/endpoints/events-sse.ts) and the MCP recent-events tool
  // (server/src/endpoints/events.ts). Stashed on app.locals the same way and
  // for the same reason as foundryClient above (see endpoints/registry.ts's
  // header comment).
  const eventBus = new FoundryEventBus();
  foundryClient.onEvent((event, payload) => eventBus.publish(event, payload));
  app.locals["eventBus"] = eventBus;

  // MCP stdio server (Phase 5) — opt-in via MCP_STDIO, for MCP clients
  // (Claude Desktop/Code) that spawn this process directly. While it's on,
  // stdout is reserved exclusively for the MCP JSON-RPC stream, so this
  // (like the banner below) logs via console.error rather than console.log.
  let mcpServer: McpServer | undefined;
  if (config.mcpStdio) {
    connectMcpStdio(foundryClient, eventBus)
      .then((connectedMcpServer) => {
        mcpServer = connectedMcpServer;
        console.error("MCP stdio server connected (MCP_STDIO=true).");

        // Phase 32 — subscribe the MCP tool set to future integration
        // changes, then immediately sync it to whatever's active *right
        // now*: a bridge connection (and thus detection) may already have
        // happened before this promise resolved, in which case
        // `integrationManager.getActive()` is already non-empty and this
        // call is what actually registers those tools for the first time.
        integrationManager.onChange((active) => {
          applyActiveIntegrationTools(connectedMcpServer, active, foundryClient, eventBus);
        });
        applyActiveIntegrationTools(
          connectedMcpServer,
          integrationManager.getActive(),
          foundryClient,
          eventBus,
        );
      })
      .catch((err: unknown) => {
        console.error("Failed to start MCP stdio server:", err);
        process.exit(1);
      });
  }

  // The startup banner and the shutdown log lines below are the only other
  // console output on the default (non-MCP) path; all of it moves to
  // stderr too when MCP_STDIO=true, for the same stdout-hygiene reason as
  // the request logger above.
  const lifecycleLog = config.mcpStdio ? console.error : console.log;

  server.listen(config.port, config.host, () => {
    lifecycleLog(
      "\n" +
        "foundry-local-api server listening\n" +
        `  address: http://${config.host}:${config.port}\n` +
        `  env:     ${config.nodeEnv}\n` +
        `  health:  http://${config.host}:${config.port}/health\n`,
    );
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${config.port} is already in use.`);
    } else {
      console.error("Server error:", err);
    }
    process.exit(1);
  });

  let shuttingDown = false;

  function shutdown(signal: string): void {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    lifecycleLog(`\nReceived ${signal}, shutting down gracefully...`);

    const forceExitTimer = setTimeout(() => {
      console.error(
        `Graceful shutdown timed out after ${config.shutdownTimeoutMs}ms, forcing exit.`,
      );
      process.exit(1);
    }, config.shutdownTimeoutMs);
    forceExitTimer.unref();

    // Close the MCP stdio connection (if any), then the bridge connection
    // and WS server (independent of the HTTP server's own close below —
    // ws's WebSocketServer attached via `{ server }` does not close the
    // HTTP server itself, and vice versa), then stop accepting new HTTP
    // connections; the server.close() callback fires once all in-flight
    // requests/connections have finished.
    Promise.resolve(mcpServer?.close())
      .catch((err: unknown) => {
        console.error("Error closing MCP stdio server:", err);
      })
      .then(() => gateway.close())
      .catch((err: unknown) => {
        console.error("Error closing bridge gateway:", err);
      })
      .finally(() => {
        server.close((err) => {
          clearTimeout(forceExitTimer);
          if (err) {
            console.error("Error during shutdown:", err);
            process.exit(1);
          }
          lifecycleLog("Shutdown complete.");
          process.exit(0);
        });
      });
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
