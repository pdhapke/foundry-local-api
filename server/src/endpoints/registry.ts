// Turns EndpointDescriptors into real wiring on both surfaces.
//
// Split into two entry points (Phase 6), replacing Phase 5's single
// `registerEndpoint(descriptor, {router, mcpServer, foundryClient})`:
//
//   - `mountRestEndpoints(router, descriptors)` — REST side. Unlike Phase 5,
//     this does NOT take a concrete `foundryClient` up front: `apiRouter`
//     (server/src/routes/api.ts) is built at module-import time, before
//     server/src/index.ts ever constructs a `FoundryClient`. So each request
//     resolves `foundryClient` off `req.app.locals["foundryClient"]` instead
//     — exactly how index.ts already stashes it, and what makes the app
//     testable with `supertest` by just setting `app.locals["foundryClient"]`
//     before making requests (see server/src/app.ts's comment about
//     `createApp` being testable "without binding a real port").
//   - `registerMcpTools(mcpServer, descriptors, foundryClient)` — MCP side.
//     Still closure-captures a concrete `foundryClient` at registration
//     time, since by the time `connectMcpStdio(foundryClient)` runs, the
//     real `FoundryClient` already exists.
import type { NextFunction, Request, RequestHandler, Response, Router } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ZodObject, type ZodRawShape } from "zod";

import type { FoundryClient } from "../bridge/foundry-client.js";
import { FoundryBridgeError, foundryBridgeErrorToHttpError } from "../bridge/errors.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import type { AnyEndpointDescriptor, EndpointContext, EndpointDescriptor } from "./types.js";

/**
 * Mounts every descriptor that supplies both `method` and `path` as a real
 * Express route on `router`. Descriptors without REST wiring (e.g. Phase 5's
 * `foundry_status`) are skipped here entirely — they only ever become MCP
 * tools.
 */
export function mountRestEndpoints(router: Router, descriptors: AnyEndpointDescriptor[]): void {
  for (const descriptor of descriptors) {
    if (descriptor.method && descriptor.path) {
      registerRestRoute(descriptor, descriptor.method, descriptor.path, router);
    }
  }
}

function registerRestRoute<TInput, TResult>(
  descriptor: EndpointDescriptor<TInput, TResult>,
  method: "get" | "post" | "put" | "delete",
  path: string,
  router: Router,
): void {
  const { inputSchema, handler } = descriptor;
  const middlewares: RequestHandler[] = [];
  if (inputSchema) {
    middlewares.push(method === "get" ? validateQuery(inputSchema) : validateBody(inputSchema));
  }

  // Same async-handler-wrapping convention Phase 5's registry.ts
  // established (Promise.resolve(...).catch(next)) — no third-party
  // wrapper dependency, explicit `next(err)` forwarding throughout.
  const finalHandler: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    const input = (
      inputSchema
        ? method === "get"
          ? res.locals["validatedQuery"]
          : res.locals["validatedBody"]
        : undefined
    ) as TInput;

    const foundryClient = req.app.locals["foundryClient"] as FoundryClient;
    const ctx: EndpointContext = { foundryClient };

    Promise.resolve(handler(input, ctx))
      .then((result) => res.json(result))
      .catch((err: unknown) => {
        if (err instanceof FoundryBridgeError) {
          next(foundryBridgeErrorToHttpError(err));
          return;
        }
        next(err);
      });
  };

  const args: [string, ...RequestHandler[]] = [path, ...middlewares, finalHandler];
  switch (method) {
    case "get":
      router.get(...args);
      break;
    case "post":
      router.post(...args);
      break;
    case "put":
      router.put(...args);
      break;
    case "delete":
      router.delete(...args);
      break;
  }
}

/**
 * Registers every descriptor (regardless of `method`/`path`) as an MCP tool
 * against `mcpServer`, closure-capturing the given `foundryClient`.
 */
export function registerMcpTools(
  mcpServer: McpServer,
  descriptors: AnyEndpointDescriptor[],
  foundryClient: FoundryClient,
): void {
  const ctx: EndpointContext = { foundryClient };
  for (const descriptor of descriptors) {
    registerMcpTool(descriptor, mcpServer, ctx);
  }
}

function registerMcpTool<TInput, TResult>(
  descriptor: EndpointDescriptor<TInput, TResult>,
  mcpServer: McpServer,
  ctx: EndpointContext,
): void {
  const { name, description, inputSchema, handler, annotations } = descriptor;

  if (inputSchema) {
    // The MCP SDK's registerTool() wants the raw shape object (a plain
    // `{key: ZodType}` record), not the ZodObject wrapper — descriptors
    // that carry an inputSchema are expected to define it as a flat
    // ZodObject argument bag for exactly this reason.
    if (!(inputSchema instanceof ZodObject)) {
      throw new Error(
        `MCP tool "${name}": inputSchema must be a ZodObject (a flat argument bag) to be exposed as a tool.`,
      );
    }
    const shape = inputSchema.shape as ZodRawShape;
    mcpServer.registerTool(
      name,
      { description, inputSchema: shape, ...(annotations ? { annotations } : {}) },
      async (args) => {
        try {
          const result = await handler(args as TInput, ctx);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        } catch (err) {
          if (err instanceof FoundryBridgeError) {
            return {
              content: [{ type: "text" as const, text: `Foundry error (${err.code}): ${err.message}` }],
              isError: true,
            };
          }
          throw err;
        }
      },
    );
    return;
  }

  mcpServer.registerTool(
    name,
    { description, ...(annotations ? { annotations } : {}) },
    async () => {
      try {
        const result = await handler(undefined as TInput, ctx);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof FoundryBridgeError) {
          return {
            content: [{ type: "text" as const, text: `Foundry error (${err.code}): ${err.message}` }],
            isError: true,
          };
        }
        throw err;
      }
    },
  );
}
