// Main-listener guards for tunneled traffic and DNS rebinding. The public MCP
// listener (server/src/mcp/public-app.ts) is a separate Express app and does
// not use the tunnel guard — every connection there is expected to be proxied,
// and that app mounts no route except `/mcp`.
import type { NextFunction, Request, Response } from "express";

import { HttpError } from "../http-error.js";
import {
  forwardedHostAllowed,
  hostHeaderAllowed,
  hostnameFromHostHeader,
  isLoopbackHostname,
  requestHasProxyHeaders,
} from "../security/remote-access.js";

const TUNNEL_MESSAGE =
  "This listener does not accept tunneled or proxied requests. Point the tunnel at the public MCP port.";

/**
 * Rejects any request carrying reverse-proxy headers. Must run before extension
 * routes and body parsers so a tunnel pointed at the main port cannot reach
 * `/api`, `/health`, `/bridge` (HTTP), extension routes, or even `/mcp`.
 * Direct local clients do not send these headers and are unchanged.
 */
export function createTunnelGuard() {
  return function tunnelGuard(req: Request, _res: Response, next: NextFunction): void {
    if (requestHasProxyHeaders(req.headers)) {
      next(new HttpError(403, TUNNEL_MESSAGE, "TUNNEL_FORBIDDEN"));
      return;
    }
    next();
  };
}

/**
 * DNS-rebinding guard for the main listener. Allows only loopback hostnames
 * (including the `*.localhost` names the Foundry bridge already uses). Enabled
 * only when remote MCP or `MCP_ALLOWED_HOSTS` is configured, so a default
 * local install does not grow a new Host check.
 */
export function createLoopbackHostGuard() {
  return function loopbackHostGuard(req: Request, _res: Response, next: NextFunction): void {
    const hostname = hostnameFromHostHeader(req.headers.host);
    if (!hostname || !isLoopbackHostname(hostname)) {
      next(new HttpError(403, "Host is not allowed on the local listener.", "HOST_NOT_ALLOWED"));
      return;
    }
    next();
  };
}

/**
 * Host allowlist for the public MCP listener. When `patterns` is empty the
 * check is skipped (protection off). When set, both `Host` and every
 * `X-Forwarded-Host` value must match.
 */
export function createAllowedHostGuard(patterns: readonly string[]) {
  return function allowedHostGuard(req: Request, _res: Response, next: NextFunction): void {
    if (patterns.length === 0) {
      next();
      return;
    }
    const hostAllowed = hostHeaderAllowed(req.headers.host, patterns);
    const forwardedAllowed = forwardedHostAllowed(req.headers["x-forwarded-host"], patterns);
    if (!hostAllowed || !forwardedAllowed) {
      next(new HttpError(403, "Host is not allowed for remote MCP.", "HOST_NOT_ALLOWED"));
      return;
    }
    next();
  };
}
