// Loopback listener that serves only Streamable HTTP MCP. A tunnel (HTTP or
// raw TCP) pointed here cannot reach `/api`, `/health`, `/bridge`, or extension
// routes because those handlers are not mounted, and WebSocket upgrades are
// rejected outright. `trust proxy` stays off: the remote rate limiter reads
// forwarded headers itself.
import http from "node:http";
import type { Server as HttpServer } from "node:http";

import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";

import type { FoundryClient } from "../bridge/foundry-client.js";
import type { FoundryEventBus } from "../events/event-bus.js";
import type { FoundationRuntime } from "../foundations/runtime.js";
import { HttpError } from "../http-error.js";
import { installErrorHandler, installNotFoundHandler } from "../http-response.js";
import type { IntegrationManager } from "../integrations/manager.js";
import { createApiKeyAuth } from "../middleware/auth.js";
import { createAllowedHostGuard } from "../middleware/remote-access.js";
import { remoteRateLimitKey } from "../security/remote-access.js";
import type { RequestLogger } from "../app.js";
import { mountMcpHttp } from "./http-transport.js";

/** Public MCP is always bound here. Tunnels connect to loopback; do not publish this port directly. */
export const PUBLIC_MCP_BIND_HOST = "127.0.0.1";

const DEFAULT_REQUEST_LOGGER: RequestLogger = () => undefined;

export interface PublicMcpAppOptions {
  isDevelopment: boolean;
  requestLogger?: RequestLogger;
  /** `MCP_REMOTE_API_KEY`. The administrative `API_KEY` is intentionally not accepted. */
  remoteApiKey: string;
  corsAllowedOrigins: string[];
  /** Empty disables the Host check. */
  allowedHosts: readonly string[];
  rateLimitWindowMs: number;
  rateLimitMax: number;
  foundryClient: FoundryClient;
  integrationManager: IntegrationManager;
  eventBus?: FoundryEventBus;
  foundations?: FoundationRuntime;
  maxSessions?: number;
  sessionIdleMs?: number;
}

export function createPublicMcpApp(options: PublicMcpAppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  // Never enable trust proxy. `req.ip` stays the socket peer (the local tunnel
  // process). The limiter below keys off forwarded headers on its own.
  app.set("trust proxy", false);

  const requestLogger = options.requestLogger ?? DEFAULT_REQUEST_LOGGER;
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      const authenticated = res.locals["authenticated"] as boolean | undefined;
      requestLogger({
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        ...(authenticated === undefined ? {} : { authenticated }),
      });
    });
    next();
  });

  const corsOptions: cors.CorsOptions = {
    origin(origin, callback) {
      if (origin === undefined) {
        callback(null, true);
        return;
      }
      callback(null, options.corsAllowedOrigins.includes(origin));
    },
  };

  const remoteRateLimiter = rateLimit({
    windowMs: options.rateLimitWindowMs,
    max: options.rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    // These validations exist to stop a limiter from silently ignoring
    // forwarded headers. This limiter reads them in `remoteRateLimitKey`
    // and must not flip trust proxy on to satisfy the default checks.
    validate: {
      xForwardedForHeader: false,
      forwardedHeader: false,
    },
    keyGenerator: (req) => remoteRateLimitKey(req),
    handler: (_req: Request, _res: Response, next: NextFunction) => {
      next(
        new HttpError(429, "Too many remote MCP requests, please try again later.", "RATE_LIMITED"),
      );
    },
  });

  app.use(createAllowedHostGuard(options.allowedHosts));
  app.use(
    "/mcp",
    cors(corsOptions),
    remoteRateLimiter,
    (_req: Request, res: Response, next: NextFunction) => {
      res.locals["authenticated"] = false;
      next();
    },
    createApiKeyAuth(options.remoteApiKey),
    express.json({ limit: "2mb" }),
  );
  mountMcpHttp(app, {
    foundryClient: options.foundryClient,
    integrationManager: options.integrationManager,
    ...(options.eventBus ? { eventBus: options.eventBus } : {}),
    ...(options.foundations ? { foundations: options.foundations } : {}),
    ...(options.maxSessions !== undefined ? { maxSessions: options.maxSessions } : {}),
    ...(options.sessionIdleMs !== undefined ? { sessionIdleMs: options.sessionIdleMs } : {}),
  });

  if (options.foundations) app.locals["foundations"] = options.foundations;
  app.locals["foundryClient"] = options.foundryClient;
  if (options.eventBus) app.locals["eventBus"] = options.eventBus;

  installNotFoundHandler(app);
  installErrorHandler(app, options.isDevelopment);
  return app;
}

/**
 * HTTP server for the public MCP app. Any WebSocket upgrade, including
 * `/bridge` and `/mcp`, is rejected: Streamable HTTP does not use WebSockets,
 * and the GM bridge must never be reachable through the tunnel.
 */
export function createPublicMcpServer(options: PublicMcpAppOptions): HttpServer {
  const server = http.createServer(createPublicMcpApp(options));
  server.on("upgrade", (_request, socket) => {
    socket.end(
      "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: 9\r\n\r\nForbidden",
    );
  });
  return server;
}
