// Alternate MCP tool wiring that forwards every call over HTTP to an
// already-running foundry-local-api instance's REST API, instead of the
// in-process registerMcpTools() (registry.ts) path that calls FoundryClient
// directly. This exists because MCP stdio is spawned per-client: a second
// Claude Code process can't share the first server's WebSocket/HTTP port
// (see mcp-remote.ts), so instead of standing up a second bridge, it just
// talks to the one already listening.
//
// Reuses the same `allEndpointDescriptors` list REST+MCP already share
// (endpoints/types.ts) for both the tool catalog (name/description/schema)
// and the HTTP call shape (method/path) — only the handler differs.
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ZodObject, type ZodRawShape } from "zod";

import type { AnyEndpointDescriptor } from "../endpoints/types.js";

// Mirrors middleware/auth.ts's API_KEY_HEADER constant, duplicated rather
// than imported: importing from middleware/auth.ts drags in app.ts ->
// routes/api.ts, which calls mountRestEndpoints(allEndpointDescriptors) at
// module-load time — a circular import back through endpoints/index.ts that
// this module (and mcp-remote.ts, which must stay decoupled from the
// Express app entirely) doesn't otherwise need.
const API_KEY_HEADER = "x-api-key";

export interface HttpMcpClientOptions {
  /** e.g. "http://127.0.0.1:3939" — no trailing slash. */
  baseUrl: string;
  apiKey: string;
}

export type HttpRouteBase = "/api" | "/api/integrations";

/** Thrown when the target server responds with a non-2xx status. */
export class HttpToolError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HttpToolError";
  }
}

const PATH_PARAM_PATTERN = /:([A-Za-z0-9_]+)/g;

/**
 * Substitutes `:param` segments in `path` with the matching key from `args`
 * (removing it from the returned "rest" bag) — the same flat-argument-bag
 * convention `validateBody`/`validateQuery` (middleware/validate.ts) expect
 * on the REST side, just applied in reverse.
 */
function fillPath(
  path: string,
  args: Record<string, unknown>,
): { resolvedPath: string; rest: Record<string, unknown> } {
  const rest = { ...args };
  const resolvedPath = path.replace(PATH_PARAM_PATTERN, (_match, name: string) => {
    const value = rest[name];
    delete rest[name];
    if (value === undefined) {
      throw new Error(`Missing required path parameter "${name}".`);
    }
    return encodeURIComponent(String(value));
  });
  return { resolvedPath, rest };
}

/** Arrays serialize as repeated keys (qs's default parse of `k=a&k=b` as `["a","b"]`, matching Express's query parser). */
function buildQueryString(rest: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        params.append(key, String(item));
      }
    } else if (typeof value === "object" && value !== null) {
      params.append(key, JSON.stringify(value));
    } else {
      params.append(key, String(value));
    }
  }
  const qs = params.toString();
  return qs.length > 0 ? `?${qs}` : "";
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessageFrom(body: unknown, status: number): string {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: { message?: string } }).error;
    if (error?.message) {
      return error.message;
    }
  }
  return `HTTP ${status}`;
}

export async function callRestEndpoint(
  descriptor: AnyEndpointDescriptor,
  args: Record<string, unknown>,
  options: HttpMcpClientOptions,
  routeBase: HttpRouteBase = "/api",
): Promise<unknown> {
  const { method, path } = descriptor;
  if (!method || !path) {
    throw new Error(`Endpoint "${descriptor.name}" has no REST route to call.`);
  }

  const { resolvedPath, rest } = fillPath(path, args);
  const isGet = method === "get";
  const url = `${options.baseUrl}${routeBase}${resolvedPath}${isGet ? buildQueryString(rest) : ""}`;

  const response = await fetch(url, {
    method: method.toUpperCase(),
    headers: {
      [API_KEY_HEADER]: options.apiKey,
      ...(isGet ? {} : { "content-type": "application/json" }),
    },
    ...(isGet ? {} : { body: JSON.stringify(rest) }),
  });

  const body = await parseBody(response);
  if (!response.ok) {
    throw new HttpToolError(errorMessageFrom(body, response.status), response.status);
  }
  return body;
}

/**
 * `foundry_status` (endpoints/health.ts) deliberately has no `method`/`path`
 * — its REST equivalent is the pre-existing, unauthenticated `GET /health`,
 * not an `/api/*` route (see that file's comment). Every other descriptor is
 * REST-wired, so this is the only tool that needs special-casing here.
 */
async function callHealthEndpoint(options: HttpMcpClientOptions): Promise<unknown> {
  const response = await fetch(`${options.baseUrl}/health`);
  const body = await parseBody(response);
  if (!response.ok) {
    throw new HttpToolError(errorMessageFrom(body, response.status), response.status);
  }
  return body;
}

export function registerHttpMcpTools(
  mcpServer: McpServer,
  descriptors: AnyEndpointDescriptor[],
  options: HttpMcpClientOptions,
  routeBase: HttpRouteBase = "/api",
): RegisteredTool[] {
  return descriptors.map((descriptor) =>
    registerHttpMcpTool(descriptor, mcpServer, options, routeBase),
  );
}

function registerHttpMcpTool(
  descriptor: AnyEndpointDescriptor,
  mcpServer: McpServer,
  options: HttpMcpClientOptions,
  routeBase: HttpRouteBase,
): RegisteredTool {
  const { name, description, inputSchema, annotations, method, path } = descriptor;

  const invoke = async (args: Record<string, unknown>) => {
    try {
      const result =
        method && path
          ? await callRestEndpoint(descriptor, args, options, routeBase)
          : await callHealthEndpoint(options);
      return { content: [{ type: "text" as const, text: JSON.stringify(result ?? null) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Foundry API error: ${message}` }],
        isError: true,
      };
    }
  };

  if (inputSchema) {
    if (!(inputSchema instanceof ZodObject)) {
      throw new Error(
        `MCP tool "${name}": inputSchema must be a ZodObject (a flat argument bag) to be exposed as a tool.`,
      );
    }
    const shape = inputSchema.shape as ZodRawShape;
    return mcpServer.registerTool(
      name,
      { description, inputSchema: shape, ...(annotations ? { annotations } : {}) },
      async (args) => invoke(args as Record<string, unknown>),
    );
  }

  return mcpServer.registerTool(
    name,
    { description, ...(annotations ? { annotations } : {}) },
    async () => invoke({}),
  );
}
