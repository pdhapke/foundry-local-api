// Configured Express app. Kept separate from `index.ts` (which owns
// `http.listen` + process lifecycle) so the app itself is trivially
// testable later (e.g. with `supertest`) without binding a real port.
import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";

import { createApiKeyAuth } from "./middleware/auth.js";
import { apiRouter } from "./routes/api.js";
import { readPackageVersion } from "./version.js";

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

/** Normalized shape every error response body uses. */
interface ErrorResponseBody {
  error: {
    message: string;
    code?: string;
  };
}

/** Error subclass routes/middleware can throw to control the response status/code. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export interface CreateAppOptions {
  isDevelopment: boolean;
  requestLogger?: RequestLogger;
  /** Static API key required on every `/api/*` request (Phase 4). */
  apiKey: string;
  /** Origins allowed to make cross-origin requests to `/api/*`. Empty = deny all cross-origin requests. */
  corsAllowedOrigins: string[];
  /** Rate-limit window (milliseconds) applied to `/api/*`. */
  rateLimitWindowMs: number;
  /** Max requests per `rateLimitWindowMs` per client, applied to `/api/*`. */
  rateLimitMax: number;
}

export function createApp(options: CreateAppOptions): Express {
  const {
    isDevelopment,
    requestLogger = defaultRequestLogger,
    apiKey,
    corsAllowedOrigins,
    rateLimitWindowMs,
    rateLimitMax,
  } = options;
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json());

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

  // 404 for anything unmatched by a route above.
  app.use((req: Request, res: Response) => {
    const body: ErrorResponseBody = {
      error: { message: `Not found: ${req.method} ${req.originalUrl}`, code: "NOT_FOUND" },
    };
    res.status(404).json(body);
  });

  // Centralized error handler — must be last, and must keep all four
  // parameters (including unused `_next`) for Express to recognize it as an
  // error-handling middleware.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpError ? err.status : 500;
    const code = err instanceof HttpError ? err.code : undefined;
    const message =
      err instanceof HttpError || status < 500 ? (err as Error).message : "Internal server error";

    if (isDevelopment) {
      console.error(err);
    } else {
      console.error(err instanceof Error ? err.message : "Unknown error");
    }

    const body: ErrorResponseBody = { error: { message, ...(code ? { code } : {}) } };
    res.status(status).json(body);
  });

  return app;
}

export { startedAt };
