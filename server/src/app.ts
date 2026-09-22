// Configured Express app. Kept separate from `index.ts` (which owns
// `http.listen` + process lifecycle) so the app itself is trivially
// testable later (e.g. with `supertest`) without binding a real port.
import express, { type Express, type NextFunction, type Request, type Response } from "express";

import { readPackageVersion } from "./version.js";

const startedAt = Date.now();

/** Structure every logger call receives; swap in a real logger without touching call sites. */
export interface RequestLogEntry {
  method: string;
  path: string;
  status: number;
  durationMs: number;
}

export type RequestLogger = (entry: RequestLogEntry) => void;

/** Default logger: single-line, human-readable, stdout. */
const defaultRequestLogger: RequestLogger = ({ method, path, status, durationMs }) => {
  console.log(`${method} ${path} ${status} ${durationMs}ms`);
};

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
}

export function createApp(options: CreateAppOptions): Express {
  const { isDevelopment, requestLogger = defaultRequestLogger } = options;
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json());

  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      requestLogger({
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
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
      err instanceof HttpError || status < 500
        ? (err as Error).message
        : "Internal server error";

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
