// REST API key auth middleware (Phase 4), mounted ahead of the `/api`
// router in app.ts. `GET /health` is mounted outside this and stays
// unauthenticated (liveness check).
import type { NextFunction, Request, Response } from "express";

import { HttpError } from "../app.js";
import { timingSafeEqualStrings } from "../security/api-key.js";

/** Header convention: `X-Api-Key: <key>`. */
export const API_KEY_HEADER = "x-api-key";

/**
 * Builds the auth middleware for a fixed `apiKey`. Records the outcome on
 * `res.locals["authenticated"]` (before succeeding or failing) so the
 * request logger in app.ts can include it in the audit line regardless of
 * whether the request is ultimately allowed through.
 */
export function createApiKeyAuth(apiKey: string) {
  return function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
    const provided = req.header(API_KEY_HEADER);
    const authenticated =
      typeof provided === "string" && provided.length > 0 && timingSafeEqualStrings(provided, apiKey);

    res.locals["authenticated"] = authenticated;

    if (!authenticated) {
      next(
        new HttpError(
          401,
          `Missing or invalid API key. Provide it via the "${API_KEY_HEADER}" header.`,
          "UNAUTHORIZED",
        ),
      );
      return;
    }

    next();
  };
}
