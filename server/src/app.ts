// Configured Express app. Kept separate from `index.ts` (which owns
// `http.listen` + process lifecycle) so the app itself is trivially
// testable later (e.g. with `supertest`) without binding a real port.
import cors from "cors";
import { latencyDiagnostics } from "./latency-trace.js";
import { startupBuildIdentity } from "./build-identity.js";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";

import type { FoundryClient } from "./bridge/foundry-client.js";
import type { FoundryEventBus } from "./events/event-bus.js";
import type { IntegrationManager } from "./integrations/manager.js";
import type { FoundationRuntime } from "./foundations/runtime.js";
import { mountMcpHttp } from "./mcp/http-transport.js";
import type { ExtensionRoute } from "./extensions/host.js";
import { installErrorHandler, installNotFoundHandler } from "./http-response.js";
import { createApiKeyAuth } from "./middleware/auth.js";
import { createLoopbackHostGuard, createTunnelGuard } from "./middleware/remote-access.js";
import { apiRouter } from "./routes/api.js";
import { readPackageVersion } from "./version.js";
import { HttpError } from "./http-error.js";

export { HttpError } from "./http-error.js";

const startedAt = Date.now();

/**
 * Structure every logger call receives; swap in a real logger without
 * touching call sites. `authenticated` is only present for requests that
 * passed through the `/api` mount's auth middleware (Phase 4) — `undefined`
 * for everything else (e.g. `/health`), which never checks a key.
 */
export interface RequestLogEntry {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  authenticated?: boolean;
}

export type RequestLogger = (entry: RequestLogEntry) => void;

/**
 * Builds a single-line, human-readable request logger over a given sink —
 * this is the audit log for Phase 4 (console only, no rotation/external
 * service, by design). Parameterized over the sink (rather than hardcoding
 * `console.log`) so index.ts can reuse the exact same line format on
 * `console.error` instead when `MCP_STDIO=true` reserves stdout for the MCP
 * JSON-RPC stream (Phase 5) — see index.ts.
 */
export function createDefaultRequestLogger(sink: (line: string) => void): RequestLogger {
  return ({ method, path, status, durationMs, authenticated }) => {
    const authSuffix = authenticated === undefined ? "" : ` auth=${authenticated}`;
    sink(`${method} ${path} ${status} ${durationMs}ms${authSuffix}`);
  };
}

/** Default logger: writes to stdout. Not used when `MCP_STDIO=true` — see index.ts. */
const defaultRequestLogger: RequestLogger = createDefaultRequestLogger(console.log);

export interface CreateAppOptions {
  /** Explicit extension routes own their authentication and bounded parsing. */
  extensionRoutes?: readonly ExtensionRoute[];
  isDevelopment: boolean;
  requestLogger?: RequestLogger;
  /** Static API key required on every `/api/*` request (Phase 4). */
  apiKey: string;
  /**
   * Extra keys accepted on `/mcp` only (never on `/api`). Used for
   * `MCP_REMOTE_API_KEY` so a cloud client can call local `/mcp` without
   * the administrative key, while `/api` still requires `apiKey`.
   */
  mcpApiKeys?: readonly string[];
  /**
   * When true, reject `Host` values that are not loopback (or `*.localhost`).
   * Turned on with remote MCP or `MCP_ALLOWED_HOSTS`. Default false so a
   * stock local install is unchanged.
   */
  enforceLoopbackHost?: boolean;
  /** `0` or omitted disables the cap. See `mountMcpHttp`. */
  mcpMaxSessions?: number;
  /** `0` or omitted disables idle expiry. See `mountMcpHttp`. */
  mcpSessionIdleMs?: number;
  /** Origins allowed to make cross-origin requests to `/api/*`. Empty = deny all cross-origin requests. */
  corsAllowedOrigins: string[];
  /** Rate-limit window (milliseconds) applied to `/api/*`. */
  rateLimitWindowMs: number;
  /** Max requests per `rateLimitWindowMs` per client, applied to `/api/*`. */
  rateLimitMax: number;
  /**
   * When provided, mounts the MCP Streamable HTTP transport at `/mcp`
   * (behind the same CORS/API-key auth as `/api`, no rate limiting — see
   * mcp/http-transport.ts). Optional because `foundryClient`/`eventBus`
   * only exist once index.ts has an `http.Server` to build the bridge
   * gateway from — tests that just exercise REST endpoints never pass it,
   * so `/mcp` doesn't exist in that Express instance at all.
   */
  mcp?: {
    foundryClient: FoundryClient;
    integrationManager: IntegrationManager;
    eventBus?: FoundryEventBus;
    foundations?: FoundationRuntime;
  };
}

export function createApp(options: CreateAppOptions): Express {
  const {
    isDevelopment,
    requestLogger = defaultRequestLogger,
    apiKey,
    corsAllowedOrigins,
    rateLimitWindowMs,
    rateLimitMax,
    mcp,
  } = options;
  const app = express();

  app.disable("x-powered-by");
  // Structural complement to the public MCP listener: an HTTP tunnel pointed
  // at this port adds proxy headers, and those requests are rejected for every
  // path before extensions, parsers, or auth run. Direct local requests do
  // not carry the headers and fall through unchanged. A raw TCP tunnel does
  // not add headers; that case is why remote access has its own listener.
  app.use(createTunnelGuard());
  if (options.enforceLoopbackHost) app.use(createLoopbackHostGuard());
  // Extensions must enforce their own authorization and bounded parsing. Their
  // routes run before shared parsers and request logging to protect private data.
  for (const route of options.extensionRoutes ?? []) {
    app.use((request, response, next) => {
      if (request.path === route.path) route.handler(request, response, next);
      else next();
    });
  }
  // Phase 24's file-upload endpoint carries a base64-encoded file (~33%
  // larger than the raw file) in its JSON body, which needs a much higher
  // limit than every other route. Phase 29 audit: raising the limit to
  // 50mb *globally* (the original Phase 24 approach) made every route an
  // unbounded-body DoS vector, including `/health`, which sits ahead of
  // the `/api` mount's rate limiter and auth check entirely and would
  // otherwise happily buffer a ~50mb body per request from any caller,
  // authenticated or not. So the 50mb limit is scoped to the one route
  // that actually needs it; everything else (every other `/api/*` route,
  // plus `/health` and any unmatched path) gets a much smaller default.
  // `read()` in `body-parser`'s internals (`onFinished.isFinished(req)`)
  // no-ops the second parser once the first has already consumed the
  // request stream, so stacking these two is safe and only the
  // path-matched one ever actually parses a given request.
  const UPLOAD_BODY_LIMIT = "50mb";
  const DEFAULT_BODY_LIMIT = "2mb";
  app.use("/api/files/upload", express.json({ limit: UPLOAD_BODY_LIMIT }));
  app.use(express.json({ limit: DEFAULT_BODY_LIMIT }));

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

  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      uptime: process.uptime(),
      version: readPackageVersion(),
      latency: latencyDiagnostics(),
      build: startupBuildIdentity,
    });
  });

  // --- `/api` mount (Phase 4) -----------------------------------------
  // Deny-by-default CORS, then rate limiting, then API-key auth, then the
  // (currently empty) route table. Order matters: CORS runs first so
  // preflight `OPTIONS` requests are answered before hitting the rate
  // limiter/auth, and so even a 401/429 response carries the right CORS
  // headers for an allowed origin. `authenticated` defaults to `false`
  // immediately on entry so the audit log always has a value for any
  // request that reaches this mount, even one rejected by the rate
  // limiter before ever reaching the auth check.
  const corsOptions: cors.CorsOptions = {
    origin(origin, callback) {
      // No Origin header at all (curl, server-to-server, same-origin) —
      // nothing for a browser to enforce, so let it through.
      if (origin === undefined) {
        callback(null, true);
        return;
      }
      callback(null, corsAllowedOrigins.includes(origin));
    },
  };

  const apiRateLimiter = rateLimit({
    windowMs: rateLimitWindowMs,
    max: rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req: Request, _res: Response, next: NextFunction) => {
      next(new HttpError(429, "Too many requests, please try again later.", "RATE_LIMITED"));
    },
  });

  app.use(
    "/api",
    cors(corsOptions),
    (_req: Request, res: Response, next: NextFunction) => {
      res.locals["authenticated"] = false;
      next();
    },
    apiRateLimiter,
    createApiKeyAuth(apiKey),
    apiRouter,
  );

  // --- `/mcp` mount (Streamable HTTP MCP transport) --------------------
  // Same CORS gate as `/api`. Local `/mcp` accepts the administrative key
  // and, when configured, `MCP_REMOTE_API_KEY`. It is not rate limited:
  // sessions hold a long-lived GET stream, and remote abuse is limited on
  // the separate public listener instead. Must be mounted here, before the
  // catch-all 404 below (Express dispatches middleware in registration
  // order), which is why this whole block is conditional on `mcp` rather
  // than something index.ts bolts on after the fact.
  if (mcp) {
    app.use(
      "/mcp",
      cors(corsOptions),
      (_req: Request, res: Response, next: NextFunction) => {
        res.locals["authenticated"] = false;
        next();
      },
      createApiKeyAuth([apiKey, ...(options.mcpApiKeys ?? [])]),
    );
    mountMcpHttp(app, {
      ...mcp,
      ...(options.mcpMaxSessions !== undefined ? { maxSessions: options.mcpMaxSessions } : {}),
      ...(options.mcpSessionIdleMs !== undefined
        ? { sessionIdleMs: options.mcpSessionIdleMs }
        : {}),
    });
  }

  if (mcp?.foundations) app.locals["foundations"] = mcp.foundations;

  installNotFoundHandler(app);
  installErrorHandler(app, isDevelopment);

  return app;
}

export { startedAt };
