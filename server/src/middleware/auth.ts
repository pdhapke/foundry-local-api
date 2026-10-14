// REST API key auth middleware (Phase 4), mounted ahead of the `/api`
// router in app.ts. `GET /health` is mounted outside this and stays
// unauthenticated (liveness check).
import type { NextFunction, Request, Response } from "express";

import { HttpError } from "../http-error.js";
import { timingSafeEqualStrings } from "../security/api-key.js";

/** Header convention: `X-Api-Key: <key>`. */
export const API_KEY_HEADER = "x-api-key";

const BEARER_PREFIX = "Bearer ";

/**
 * Extracts the API key from either the `X-Api-Key` header or an
 * `Authorization: Bearer <key>` header — the latter accommodates MCP clients
 * (e.g. Codex CLI's `--bearer-token-env-var`) that only support standard
 * bearer-token auth for streamable-HTTP servers, not arbitrary headers.
 */
function extractProvidedKey(req: Request): string | undefined {
  const apiKeyHeader = req.header(API_KEY_HEADER);
  if (typeof apiKeyHeader === "string" && apiKeyHeader.length > 0) {
    return apiKeyHeader;
  }

  const authHeader = req.header("authorization");
  if (typeof authHeader === "string" && authHeader.startsWith(BEARER_PREFIX)) {
    return authHeader.slice(BEARER_PREFIX.length);
  }

  return undefined;
}

/**
 * Builds the auth middleware for one or more accepted keys. Every provided
 * key is compared (no early return) so a second key does not change the
 * timing of a mismatch against the first. Records the outcome on
 * `res.locals["authenticated"]` (before succeeding or failing) so the
 * request logger in app.ts can include it in the audit line regardless of
 * whether the request is ultimately allowed through.
 *
 * Pass only the keys that are valid for the mount. `/api` receives the
 * administrative key alone. `/mcp` may also receive `MCP_REMOTE_API_KEY`.
 * The public MCP listener receives the remote key alone.
 */
export function createApiKeyAuth(apiKey: string | readonly string[]) {
  const acceptedKeys = (typeof apiKey === "string" ? [apiKey] : apiKey).filter(
    (key) => key.length > 0,
  );
  return function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
    const provided = extractProvidedKey(req);
    let authenticated = false;
    if (typeof provided === "string" && provided.length > 0) {
      for (const key of acceptedKeys) {
        if (timingSafeEqualStrings(provided, key)) authenticated = true;
      }
    }

    res.locals["authenticated"] = authenticated;

    if (!authenticated) {
      next(
        new HttpError(
          401,
          `Missing or invalid API key. Provide it via the "${API_KEY_HEADER}" header or "Authorization: Bearer <key>".`,
          "UNAUTHORIZED",
        ),
      );
      return;
    }

    next();
  };
}
