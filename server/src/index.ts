// Bootstraps the standalone server process: loads config, builds the
// Express app, starts listening, and wires graceful shutdown.
import http from "node:http";

import { createApp } from "./app.js";
import { FoundryClient } from "./bridge/foundry-client.js";
import { BridgeGateway } from "./bridge/gateway.js";
import { ConfigError, loadConfig, type AppConfig } from "./config.js";

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

  const app = createApp({ isDevelopment: config.isDevelopment });
  const server = http.createServer(app);

  // Bridge WS gateway (Phase 3), mounted on the same http.Server/port at
  // `/bridge`, plus the FoundryClient abstraction route handlers will use
  // from Phase 6 onward to round-trip commands to the connected module.
  // Stashed on app.locals so future route modules can reach it via
  // `req.app.locals.foundryClient` without a separate wiring mechanism.
  const gateway = new BridgeGateway(server);
  const foundryClient = new FoundryClient(gateway, {
    defaultTimeoutMs: config.bridgeTimeoutMs,
  });
  app.locals["foundryClient"] = foundryClient;

  server.listen(config.port, config.host, () => {
    console.log(
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
    console.log(`\nReceived ${signal}, shutting down gracefully...`);

    const forceExitTimer = setTimeout(() => {
      console.error(
        `Graceful shutdown timed out after ${config.shutdownTimeoutMs}ms, forcing exit.`,
      );
      process.exit(1);
    }, config.shutdownTimeoutMs);
    forceExitTimer.unref();

    // Close any active bridge connection and stop the WS server first
    // (independent of the HTTP server's own close below — ws's
    // WebSocketServer attached via `{ server }` does not close the HTTP
    // server itself, and vice versa), then stop accepting new HTTP
    // connections; the server.close() callback fires once all in-flight
    // requests/connections have finished.
    gateway
      .close()
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
          console.log("Shutdown complete.");
          process.exit(0);
        });
      });
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
