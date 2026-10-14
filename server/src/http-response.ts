// Shared 404 and error responses so the main app and the public MCP listener
// stay on one error shape.
import type { Express, NextFunction, Request, Response } from "express";

import { HttpError } from "./http-error.js";

interface ErrorResponseBody {
  error: {
    message: string;
    code?: string;
    retryable?: boolean;
    fieldPath?: string;
    correlationId?: string;
    details?: Record<string, unknown>;
  };
}

export function installNotFoundHandler(app: Express): void {
  app.use((req: Request, res: Response) => {
    const body: ErrorResponseBody = {
      error: { message: `Not found: ${req.method} ${req.originalUrl}`, code: "NOT_FOUND" },
    };
    res.status(404).json(body);
  });
}

export function installErrorHandler(app: Express, isDevelopment: boolean): void {
  // Must keep all four parameters so Express treats this as an error handler.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpError ? err.status : 500;
    const code = err instanceof HttpError ? err.code : undefined;
    const message =
      err instanceof HttpError || status < 500 ? (err as Error).message : "Internal server error";

    if (err instanceof HttpError) {
      // Keep the user-owned HTTP-error audit signal, but never echo an
      // endpoint's message: validation failures can be derived from
      // caller-controlled input and may contain an API key or one-time
      // enrollment credential.
      console.error(`${status} ${code ?? "HTTP_ERROR"}`);
    } else if (isDevelopment) {
      console.error(err instanceof Error ? err.name : "Unknown error");
    } else {
      console.error("Internal server error");
    }

    const body: ErrorResponseBody = {
      error: {
        message,
        ...(code ? { code } : {}),
        ...(err instanceof HttpError && err.retryable !== undefined
          ? { retryable: err.retryable }
          : {}),
        ...(err instanceof HttpError && err.fieldPath ? { fieldPath: err.fieldPath } : {}),
        ...(err instanceof HttpError && err.correlationId
          ? { correlationId: err.correlationId }
          : {}),
        ...(err instanceof HttpError && err.details ? { details: err.details } : {}),
      },
    };
    res.status(status).json(body);
  });
}
