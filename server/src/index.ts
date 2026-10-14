// Bootstraps the standalone server process: loads config, builds the
// Express app, starts listening, and wires graceful shutdown.
import http from "node:http";
import type { SequencedMovementEvent } from "@foundry-local-api/shared";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createApp, createDefaultRequestLogger } from "./app.js";
import { FoundryClient } from "./bridge/foundry-client.js";
import { BridgeGateway } from "./bridge/gateway.js";
import { EnrollmentStore } from "./bridge/enrollment-store.js";
import { LocalFoundrySessionVerifier } from "./bridge/foundry-session-verifier.js";
import { ConfigError, loadConfig, type AppConfig } from "./config.js";
import { FoundryEventBus } from "./events/event-bus.js";
import { ingestMovementEvent, MOVEMENT_EVENT_NAME } from "./events/movement-event-ingestor.js";
import { MovementEventStore } from "./events/movement-event-store.js";
import { configureMovementEventStore } from "./endpoints/movement-events.js";
import { configureMovementEventStoreDiagnostics } from "./endpoints/movement-events.js";
import { DurableAuditLog } from "./foundations/audit-log.js";
import { DurableIdempotencyStore } from "./foundations/idempotency-store.js";
import { productionFixtureRegistry } from "./foundations/runtime.js";
import { configureLatencyTrace } from "./latency-trace.js";
import { IntegrationManager } from "./integrations/manager.js";
import { integrations } from "./integrations/registry.js";
import { applyActiveIntegrations } from "./integrations/router.js";
import { connectMcpStdio } from "./mcp/index.js";
import { readPackageVersion } from "./version.js";
import { createHash } from "node:crypto";
import { ApiExtensionHost } from "./extensions/host.js";

/** Standalone unless trusted local extension factories are explicitly configured. */
export async function main(): Promise<void> {
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

  // `server` is created without a request listener yet: BridgeGateway only
  // needs the raw http.Server to attach its own WS `upgrade` listener to,
  // and building `foundryClient`/`eventBus` before `createApp()` lets the
  // app wire up the MCP HTTP transport (which needs `foundryClient`) in one
  // pass instead of bolting `/mcp` on after the fact — see CreateAppOptions'
  // `mcp` field in app.ts for why that ordering matters (must exist before
  // the catch-all 404 handler, which `createApp` also owns).
  const server = http.createServer();

  // Bridge WS gateway (Phase 3), mounted on the same http.Server/port at
  // `/bridge`, plus the FoundryClient abstraction route handlers will use
  // from Phase 6 onward to round-trip commands to the connected module.
  // The GM lane is authenticated independently against the browser's existing
  // Foundry session. The administrative API key remains REST/MCP-only.
  const enrollmentStore = new EnrollmentStore({
    laneCommandAllowlist: {
      player: [
        "effectiveUserExecute",
        "sceneRenderSnapshot",
        "sceneVisibilityInspect",
        "clientPreloadScene",
        "clientReadinessGet",
        "clientViewportApply",
        "clientReload",
        "clientEnrolledIdentityAdopt",
      ],
      tv: [
        "gmTvControl",
        "clientPreloadScene",
        "clientReadinessGet",
        "clientViewportApply",
        "clientReload",
        "clientEnrolledIdentityAdopt",
      ],
    },
  });
  const runtimeDirectory = new URL("../../.runtime/", import.meta.url);
  configureLatencyTrace(
    fileURLToPath(new URL("latency-traces.jsonl", runtimeDirectory)),
    "mcp-node",
  );
  const allowedFoundryOrigins = [
    "http://127.0.0.1:30000",
    "http://localhost:30000",
    "http://[::1]:30000",
    ...config.corsAllowedOrigins.filter(isPotentialLoopbackOrigin),
  ];
  const gateway = new BridgeGateway(server, {
    foundrySessionVerifier: new LocalFoundrySessionVerifier({ allowedFoundryOrigins }),
    enrollmentStore,
    bindHost: config.host,
    allowedFoundryOrigins,
  });
  const auditLog = new DurableAuditLog(fileURLToPath(new URL("audit.jsonl", runtimeDirectory)));
  const foundations = {
    fixtures: productionFixtureRegistry,
    idempotency: new DurableIdempotencyStore(
      fileURLToPath(new URL("idempotency.json", runtimeDirectory)),
    ),
    enrollments: enrollmentStore,
  };
  const foundryClient = new FoundryClient(gateway, {
    defaultTimeoutMs: config.bridgeTimeoutMs,
    serverVersion: readPackageVersion(),
    auditSink: (record) => auditLog.write(record),
  });
  const administrativeCredentialSha256 = createHash("sha256")
    .update(config.apiKey, "utf8")
    .digest("hex");
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
  // (server/src/endpoints/events.ts).
  const eventBus = new FoundryEventBus();
  const movementStorePath = fileURLToPath(new URL("movement-events.json", runtimeDirectory));
  let movementEventStore: MovementEventStore | undefined;
  try {
    movementEventStore = new MovementEventStore(movementStorePath);
  } catch {
    // Preserve the forensic file and keep the read-only diagnostic surface
    // available. The aggregate validator reports a typed integrity code.
  }
  configureMovementEventStore(movementEventStore);
  configureMovementEventStoreDiagnostics(() =>
    MovementEventStore.diagnose(movementStorePath, true, movementEventStore !== undefined),
  );
  const movementListeners = new Set<(record: SequencedMovementEvent) => void>();
  const extensions = new ApiExtensionHost({
    gateway,
    foundryClient,
    runtimeRoot: runtimeDirectory,
    moduleRoot: new URL("../../", import.meta.url),
    bindHost: config.host,
    administrativeCredentialSha256,
    movement: {
      path: movementStorePath,
      getStore: () => movementEventStore,
      diagnose: () =>
        MovementEventStore.diagnose(movementStorePath, true, movementEventStore !== undefined),
      reloadStore: () => {
        movementEventStore = new MovementEventStore(movementStorePath);
        configureMovementEventStore(movementEventStore);
      },
      onRecord: (handler) => {
        movementListeners.add(handler);
        return () => {
          movementListeners.delete(handler);
        };
      },
    },
  });
  try {
    await extensions.load(process.env["FOUNDRY_API_EXTENSIONS"]);
  } catch {
    await gateway.close();
    throw new Error("API extension startup failed.");
  }

  foundryClient.onEvent((event, payload, metadata) => {
    if (extensions.consumeEvent(event, payload, metadata)) return;
    if (event !== MOVEMENT_EVENT_NAME) {
      eventBus.publish(event, payload);
      return;
    }
    if (!movementEventStore) return;
    const record = ingestMovementEvent(movementEventStore, payload, metadata);
    if (!record) return;
    for (const listener of movementListeners) {
      try {
        listener(record);
      } catch {
        /* Durable record remains available for replay. */
      }
    }
    eventBus.publish(event, record);
    if (metadata.delivery) {
      gateway.acknowledgeEvent(metadata.delivery.deliveryId, metadata.clientId);
    }
  });
  // When MCP_STDIO is on, this process's stdout is reserved exclusively for
  // the MCP JSON-RPC stream (see connectMcpStdio below) — nothing else may
  // write to it, so the request logger is redirected to stderr instead.
  // Behavior is byte-for-byte unchanged (stdout logger) when it's off.
  const app = createApp({
    extensionRoutes: extensions.routeSnapshot(),
    isDevelopment: config.isDevelopment,
    apiKey: config.apiKey,
    corsAllowedOrigins: config.corsAllowedOrigins,
    rateLimitWindowMs: config.rateLimitWindowMs,
    rateLimitMax: config.rateLimitMax,
    mcp: { foundryClient, integrationManager, eventBus, foundations },
    ...(config.mcpStdio ? { requestLogger: createDefaultRequestLogger(console.error) } : {}),
  });
  app.locals["foundryClient"] = foundryClient;
  app.locals["eventBus"] = eventBus;
  app.locals["foundations"] = foundations;
  server.on("request", app);

  // MCP stdio server (Phase 5) — opt-in via MCP_STDIO, for MCP clients
  // (Claude Desktop/Code) that spawn this process directly. While it's on,
  // stdout is reserved exclusively for the MCP JSON-RPC stream, so this
  // (like the banner below) logs via console.error rather than console.log.
  let mcpServer: McpServer | undefined;
  if (config.mcpStdio) {
    connectMcpStdio(foundryClient, integrationManager, eventBus, foundations)
      .then((connectedMcpServer) => {
        mcpServer = connectedMcpServer;
        console.error("MCP stdio server connected (MCP_STDIO=true).");
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
    const stopExtensions = extensions.shutdown();
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
    Promise.resolve(stopExtensions)
      .then(() => mcpServer?.close())
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

function isPotentialLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return false;
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(hostname) !== 0) {
      return hostname === "127.0.0.1" || hostname === "::1";
    }
    return /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(
      hostname,
    );
  } catch {
    return false;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().catch(() => {
    console.error("Server startup failed.");
    process.exit(1);
  });
}
