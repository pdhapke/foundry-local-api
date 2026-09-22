// Bootstraps the standalone server process: loads config, builds the
// Express app, starts listening, and wires graceful shutdown.
import http from "node:http";

import { createApp } from "./app.js";
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

    // Stops accepting new connections; the callback fires once all
    // in-flight requests/connections have finished.
    server.close((err) => {
      clearTimeout(forceExitTimer);
      if (err) {
        console.error("Error during shutdown:", err);
        process.exit(1);
      }
      console.log("Shutdown complete.");
      process.exit(0);
    });
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
