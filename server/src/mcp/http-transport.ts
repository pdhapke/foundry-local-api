// Streamable HTTP MCP transport (spec: 2025-03-26 "Streamable HTTP"),
// mounted directly on the app's own Express instance alongside `/api`.
//
// Unlike mcp-remote.ts/create-http-mcp-server.ts (which exist so a *second*
// process can reach an already-running server's tools without owning the
// bridge), this runs in the same process that owns `foundryClient` — each
// session gets its own McpServer wired straight to it via createMcpServer(),
// same as the MCP_STDIO path in index.ts, just multiplexed over HTTP instead
// of a single stdio pair. That lets any number of MCP clients (multiple
// Claude Code sessions, etc.) connect concurrently over plain HTTP with no
// subprocess spawn per client and no self-referential HTTP hop back into
// `/api`.
//
// Session lifecycle follows the SDK's documented pattern: a session begins
// with an `initialize` POST (no `Mcp-Session-Id` header yet), the transport
// mints a session id and this module remembers it; every subsequent request
// for that session must carry the header, and DELETE ends it early. Each
// tracked transport owns exactly one McpServer for its lifetime — a
// McpServer/Server pair binds to one transport at a time (see
// create-mcp-server.ts), so a fresh instance per session is required, not
// optional.
import type { Express, NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import type { FoundryClient } from "../bridge/foundry-client.js";
import { HttpError } from "../http-error.js";
import type { FoundryEventBus } from "../events/event-bus.js";
import type { FoundationRuntime } from "../foundations/runtime.js";
import type { IntegrationManager } from "../integrations/manager.js";
import { createMcpServer, disposeMcpServerIntegrations } from "./create-mcp-server.js";

export interface McpHttpOptions {
  foundryClient: FoundryClient;
  integrationManager: IntegrationManager;
  eventBus?: FoundryEventBus;
  foundations?: FoundationRuntime;
  /**
   * Maximum concurrent Streamable HTTP sessions on this listener.
   * `0` or omitted disables the cap.
   */
  maxSessions?: number;
  /**
   * Close a session that has no in-flight request and has not been touched
   * for this many milliseconds. A held SSE GET counts as in flight, so an
   * actively connected client is not expired. `0` or omitted disables expiry.
   */
  sessionIdleMs?: number;
}

interface TrackedSession {
  transport: StreamableHTTPServerTransport;
  lastSeenMs: number;
  inFlight: number;
}

const SESSION_ID_HEADER = "mcp-session-id";

/**
 * Mounts the Streamable HTTP MCP endpoint at `POST|GET|DELETE /mcp`. Must be
 * called after the caller has already applied CORS/rate-limit/API-key
 * middleware for the `/mcp` path (see index.ts) — this function only adds
 * the MCP protocol handling itself, matching how `apiRouter` in
 * routes/api.ts stays agnostic of the auth it's mounted behind.
 */
export function mountMcpHttp(app: Express, options: McpHttpOptions): void {
  const { foundryClient, integrationManager, eventBus, foundations } = options;
  const maxSessions = options.maxSessions ?? 0;
  const sessionIdleMs = options.sessionIdleMs ?? 0;
  const transports = new Map<string, TrackedSession>();
  let pendingInitializations = 0;

  function noteActivity(tracked: TrackedSession, res: Response): void {
    tracked.inFlight += 1;
    tracked.lastSeenMs = Date.now();
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      tracked.inFlight = Math.max(0, tracked.inFlight - 1);
      tracked.lastSeenMs = Date.now();
    };
    res.on("finish", done);
    res.on("close", done);
  }

  if (sessionIdleMs > 0) {
    const intervalMs = Math.min(Math.max(sessionIdleMs, 50), 30_000);
    const timer = setInterval(() => {
      const cutoff = Date.now() - sessionIdleMs;
      const expired: StreamableHTTPServerTransport[] = [];
      for (const tracked of transports.values()) {
        if (tracked.inFlight === 0 && tracked.lastSeenMs <= cutoff) {
          expired.push(tracked.transport);
        }
      }
      for (const transport of expired) {
        void transport.close().catch(() => undefined);
      }
    }, intervalMs);
    timer.unref();
  }

  async function handleSessionRequest(req: Request, res: Response): Promise<void> {
    const sessionId = req.header(SESSION_ID_HEADER);
    const tracked = sessionId ? transports.get(sessionId) : undefined;
    if (!tracked) {
      throw new HttpError(400, "Missing or unknown Mcp-Session-Id header.", "BAD_REQUEST");
    }
    noteActivity(tracked, res);
    await tracked.transport.handleRequest(req, res);
  }

  app.post("/mcp", (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const sessionId = req.header(SESSION_ID_HEADER);
      const existing = sessionId ? transports.get(sessionId) : undefined;

      if (existing) {
        noteActivity(existing, res);
        await existing.transport.handleRequest(req, res, req.body as unknown);
        return;
      }

      if (sessionId || !isInitializeRequest(req.body)) {
        throw new HttpError(
          400,
          "No valid session (missing/unknown Mcp-Session-Id, or not an initialize request).",
          "BAD_REQUEST",
        );
      }

      if (maxSessions > 0 && transports.size + pendingInitializations >= maxSessions) {
        throw new HttpError(503, "MCP session limit reached.", "MCP_SESSION_LIMIT");
      }

      pendingInitializations += 1;
      try {
        const mcpServer = createMcpServer(foundryClient, integrationManager, eventBus, foundations);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            const tracked: TrackedSession = {
              transport,
              lastSeenMs: Date.now(),
              inFlight: 0,
            };
            transports.set(newSessionId, tracked);
            noteActivity(tracked, res);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            transports.delete(transport.sessionId);
          }
        };

        // StreamableHTTPServerTransport declares `onclose`/`onerror`/`onmessage`
        // as accessor pairs typed `X | undefined`, which the `Transport`
        // interface's `exactOptionalPropertyTypes`-sensitive `onclose?: () =>
        // void` field shape rejects on structural grounds alone — the class
        // does implement `Transport` (per its own `implements` clause), this
        // is a tsconfig-strictness/SDK-typings mismatch, not an actual runtime
        // incompatibility.
        try {
          await mcpServer.connect(transport as unknown as Transport);
        } catch (error) {
          // A failed connect never reaches the SDK's normal close callback.
          disposeMcpServerIntegrations(mcpServer);
          throw error;
        }
        await transport.handleRequest(req, res, req.body as unknown);
      } finally {
        pendingInitializations -= 1;
      }
    })().catch(next);
  });

  app.get("/mcp", (req: Request, res: Response, next: NextFunction) => {
    handleSessionRequest(req, res).catch(next);
  });

  app.delete("/mcp", (req: Request, res: Response, next: NextFunction) => {
    handleSessionRequest(req, res).catch(next);
  });
}
