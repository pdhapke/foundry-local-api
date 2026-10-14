import express, { type Express, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { MCP_EVENTS_PROTOCOL_VERSION, McpError } from "./contract.js";
import type { SubscriptionResult } from "./events.js";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}
export interface ScopedMcpTools {
  list(owner: string): Promise<McpToolDefinition[]>;
  call(
    owner: string,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>>;
}
export interface McpEventsHttpOptions {
  events: {
    list(owner: string, scope: unknown): Promise<unknown[]>;
    subscribe(owner: string, raw: unknown, signal: AbortSignal): Promise<SubscriptionResult>;
    unsubscribe(owner: string, raw: unknown): Promise<Record<string, never>>;
  };
  authenticate(request: Request, signal: AbortSignal): Promise<string | null>;
  scopeForPrincipal(owner: string): unknown | Promise<unknown>;
  tools: ScopedMcpTools;
  allowedOrigins?: readonly string[];
  serverInfo?: { name: string; version: string };
}
const PROTOCOL_KEY = "io.modelcontextprotocol/protocolVersion";
const CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const rpcSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string().max(128), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)]),
    method: z.string().min(1).max(128),
    params: z.record(z.string(), z.unknown()),
  })
  .strict();
function metadataAndHeaders(request: Request, rpc: z.infer<typeof rpcSchema>): void {
  const meta = rpc.params["_meta"];
  if (
    !meta ||
    typeof meta !== "object" ||
    Array.isArray(meta) ||
    typeof (meta as Record<string, unknown>)[PROTOCOL_KEY] !== "string" ||
    !(meta as Record<string, unknown>)[CAPABILITIES_KEY] ||
    typeof (meta as Record<string, unknown>)[CAPABILITIES_KEY] !== "object" ||
    Array.isArray((meta as Record<string, unknown>)[CAPABILITIES_KEY])
  )
    throw new McpError(-32602, "Required MCP request metadata is missing.");
  const version = (meta as Record<string, unknown>)[PROTOCOL_KEY];
  if (
    request.header("mcp-protocol-version") !== version ||
    request.header("mcp-method") !== rpc.method
  )
    throw new McpError(-32020, "MCP HTTP headers do not match request metadata.");
  if (version !== MCP_EVENTS_PROTOCOL_VERSION)
    throw new McpError(-32022, "Unsupported protocol version.");
  if (rpc.method === "tools/call") {
    let name = request.header("mcp-name");
    if (name?.startsWith("=?base64?") && name.endsWith("?=")) {
      const encoded = name.slice(9, -2);
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.toString("base64") !== encoded)
        throw new McpError(-32020, "Invalid MCP name header encoding.");
      name = bytes.toString("utf8");
    }
    if (!name || name !== rpc.params["name"])
      throw new McpError(-32020, "MCP name header does not match request.");
  }
}
function args(params: Record<string, unknown>): Record<string, unknown> {
  const { _meta: _metadata, ...rest } = params;
  return rest;
}
function strictEmpty(params: Record<string, unknown>): void {
  if (Object.keys(params).length) throw new McpError(-32602, "Unexpected MCP parameters.");
}
function errorResponse(response: Response, id: unknown, error: unknown): void {
  const safe =
    error instanceof McpError ? error : new McpError(-32603, "Scoped MCP operation failed.");
  const data =
    safe.code === -32022
      ? { supported: [MCP_EVENTS_PROTOCOL_VERSION] }
      : safe.reason
        ? { reason: safe.reason }
        : undefined;
  response.status([-32600, -32602, -32020, -32022].includes(safe.code) ? 400 : 200).json({
    jsonrpc: "2.0",
    id: typeof id === "string" || typeof id === "number" ? id : null,
    error: { code: safe.code, message: safe.message, ...(data ? { data } : {}) },
  });
}
/** Modern, stateless JSON replies. Authentication identity never comes from MCP metadata.
 * This deliberately does not forward the administrative MCP catalog or legacy sessions.
 */
export function createMcpEventsHandler(options: McpEventsHttpOptions): RequestHandler {
  if (
    !options.events ||
    typeof options.authenticate !== "function" ||
    typeof options.scopeForPrincipal !== "function" ||
    !options.tools ||
    typeof options.tools.list !== "function" ||
    typeof options.tools.call !== "function"
  )
    throw new McpError(-32603, "Scoped MCP authentication and tools are required.");
  return (request, response) => {
    const cancelled = new AbortController();
    const cancel = () => {
      if (!response.writableEnded) cancelled.abort();
    };
    response.once("close", cancel);
    const signal = AbortSignal.any([cancelled.signal, AbortSignal.timeout(25000)]);
    response.setHeader("Cache-Control", "no-store");
    void (async () => {
      const origin = request.header("origin");
      if (origin !== undefined && !options.allowedOrigins?.includes(origin)) {
        response.status(403).json({ error: "Origin is not authorized." });
        return;
      }
      const owner = await options.authenticate(request, signal);
      if (!owner || !/^[A-Za-z0-9_.:@-]{1,256}$/.test(owner)) {
        response.status(401).json({ error: "MCP authentication required." });
        return;
      }
      if (Buffer.byteLength(JSON.stringify(request.body) ?? "", "utf8") > 32768)
        throw new McpError(-32600, "Scoped MCP request exceeds its bound.");
      const parsed = rpcSchema.safeParse(request.body);
      if (!parsed.success) throw new McpError(-32600, "Invalid JSON-RPC request.");
      const rpc = parsed.data;
      metadataAndHeaders(request, rpc);
      // An authenticated owner must still be able to stop its exact subscription
      // after its controller/session access has been revoked.
      if (rpc.method !== "events/unsubscribe" && !(await options.scopeForPrincipal(owner))) {
        response.status(403).json({ error: "MCP scope is not authorized." });
        return;
      }
      const params = args(rpc.params);
      let result: Record<string, unknown>;
      switch (rpc.method) {
        case "server/discover":
          strictEmpty(params);
          result = {
            supportedVersions: [MCP_EVENTS_PROTOCOL_VERSION],
            capabilities: { tools: {}, events: {} },
            _meta: {
              "io.modelcontextprotocol/serverInfo": options.serverInfo ?? {
                name: "foundry-events",
                version: "0.1.0",
              },
            },
          };
          break;
        case "events/list": {
          strictEmpty(params);
          const scope = await options.scopeForPrincipal(owner);
          result = { events: scope ? await options.events.list(owner, scope) : [] };
          break;
        }
        case "events/subscribe":
          result = { ...(await options.events.subscribe(owner, params, signal)) };
          break;
        case "events/unsubscribe":
          result = await options.events.unsubscribe(owner, params);
          break;
        case "tools/list": {
          strictEmpty(params);
          const tools = await options.tools.list(owner);
          if (
            tools.length > 8 ||
            tools.some(
              (tool) =>
                !/^[A-Za-z0-9_-]{1,128}$/.test(tool.name) ||
                !tool.outputSchema ||
                !tool.inputSchema,
            )
          )
            throw new McpError(-32603, "Invalid scoped MCP tool catalog.");
          result = { tools };
          break;
        }
        case "tools/call": {
          const input = z
            .object({
              name: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
              arguments: z.record(z.string(), z.unknown()),
            })
            .strict()
            .safeParse(params);
          if (!input.success) throw new McpError(-32602, "Invalid scoped MCP tool call.");
          const tools = await options.tools.list(owner);
          if (!tools.some((tool) => tool.name === input.data.name))
            throw new McpError(-32602, "Tool is not in the scoped MCP catalog.");
          const content = await options.tools.call(
            owner,
            input.data.name,
            input.data.arguments,
            signal,
          );
          result = {
            content: [{ type: "text", text: JSON.stringify(content) }],
            structuredContent: content,
            isError: false,
          };
          break;
        }
        default:
          throw new McpError(-32601, "Method is not available on the scoped MCP endpoint.");
      }
      signal.throwIfAborted();
      const body = { jsonrpc: "2.0", id: rpc.id, result: { ...result, resultType: "complete" } };
      if (Buffer.byteLength(JSON.stringify(body), "utf8") > 65536)
        throw new McpError(-32603, "Scoped MCP response exceeds its bound.");
      response.json(body);
    })()
      .catch((error) => {
        if (!response.writableEnded && !cancelled.signal.aborted)
          errorResponse(response, request.body?.id, error);
      })
      .finally(() => response.removeListener("close", cancel));
  };
}
export function mountMcpEvents(
  app: Express,
  path: string,
  options: McpEventsHttpOptions | (() => McpEventsHttpOptions | undefined),
): void {
  const parser = express.json({ limit: "32kb", strict: true });
  const staticHandler = typeof options === "function" ? undefined : createMcpEventsHandler(options);
  app.post(path, (request, response, next) => {
    const selected = typeof options === "function" ? options() : options;
    if (!selected) {
      response.setHeader("Cache-Control", "no-store");
      response.status(503).json({ error: "MCP endpoint is inactive." });
      return;
    }
    // Capture exactly one runtime per request. Revocation remains enforced by
    // that instance's authenticate/authorization and cancellation signal.
    const handler = staticHandler ?? createMcpEventsHandler(selected);
    parser(request, response, (error) => {
      if (error) next(error);
      else handler(request, response, next);
    });
  });
  app.all(path, (_request, response) => {
    response.setHeader("Allow", "POST");
    response.sendStatus(405);
  });
}
