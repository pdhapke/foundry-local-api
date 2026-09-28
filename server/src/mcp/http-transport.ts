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
  const transports = new Map<string, StreamableHTTPServerTransport>();

  async function handleSessionRequest(req: Request, res: Response): Promise<void> {
    const sessionId = req.header(SESSION_ID_HEADER);
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      throw new HttpError(400, "Missing or unknown Mcp-Session-Id header.", "BAD_REQUEST");
    }
    await transport.handleRequest(req, res);
  }

  app.post("/mcp", (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const sessionId = req.header(SESSION_ID_HEADER);
      const existing = sessionId ? transports.get(sessionId) : undefined;

      if (existing) {
        await existing.handleRequest(req, res, req.body as unknown);
        return;
      }

      if (sessionId || !isInitializeRequest(req.body)) {
        throw new HttpError(
          400,
          "No valid session (missing/unknown Mcp-Session-Id, or not an initialize request).",
          "BAD_REQUEST",
        );
      }

      const mcpServer = createMcpServer(foundryClient, integrationManager, eventBus, foundations);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          transports.set(newSessionId, transport);
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
    })().catch(next);
  });

  app.get("/mcp", (req: Request, res: Response, next: NextFunction) => {
    handleSessionRequest(req, res).catch(next);
  });

  app.delete("/mcp", (req: Request, res: Response, next: NextFunction) => {
    handleSessionRequest(req, res).catch(next);
  });
}
