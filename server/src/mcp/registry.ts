// Registers one EndpointDescriptor onto both surfaces: an Express route
// (only when the descriptor supplies method+path) and an MCP tool (always).
// This is the one place that turns a descriptor into real wiring — see
// types.ts for why the pattern exists.
import type { NextFunction, Request, RequestHandler, Response, Router } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ZodObject, type ZodRawShape } from "zod";

import type { FoundryClient } from "../bridge/foundry-client.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import type { EndpointContext, EndpointDescriptor } from "./types.js";

export interface RegisterEndpointDeps {
  router: Router;
  mcpServer: McpServer;
  foundryClient: FoundryClient;
}

export function registerEndpoint<TInput, TResult>(
  descriptor: EndpointDescriptor<TInput, TResult>,
  deps: RegisterEndpointDeps,
): void {
  const ctx: EndpointContext = { foundryClient: deps.foundryClient };

  if (descriptor.method && descriptor.path) {
    registerRestRoute(descriptor, descriptor.method, descriptor.path, deps.router, ctx);
  }

  registerMcpTool(descriptor, deps.mcpServer, ctx);
}

function registerRestRoute<TInput, TResult>(
  descriptor: EndpointDescriptor<TInput, TResult>,
  method: "get" | "post" | "put" | "delete",
  path: string,
  router: Router,
  ctx: EndpointContext,
): void {
  const { inputSchema, handler } = descriptor;
  const middlewares: RequestHandler[] = [];
  if (inputSchema) {
    middlewares.push(method === "get" ? validateQuery(inputSchema) : validateBody(inputSchema));
  }

  // No async route handling convention exists yet elsewhere in the codebase
  // (routes/api.ts is still empty as of Phase 5) — this small
  // Promise.resolve(...).catch(next) wrapper is the one this file
  // establishes, consistent with the rest of the codebase's preference for
  // explicit `next(err)` forwarding over a third-party wrapper dependency.
  const finalHandler: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    const input = (
      inputSchema
        ? method === "get"
          ? res.locals["validatedQuery"]
          : res.locals["validatedBody"]
        : undefined
    ) as TInput;

    Promise.resolve(handler(input, ctx))
      .then((result) => res.json(result))
      .catch(next);
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

function registerMcpTool<TInput, TResult>(
  descriptor: EndpointDescriptor<TInput, TResult>,
  mcpServer: McpServer,
  ctx: EndpointContext,
): void {
  const { name, description, inputSchema, handler } = descriptor;

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
    mcpServer.registerTool(name, { description, inputSchema: shape }, async (args) => {
      const result = await handler(args as TInput, ctx);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    });
    return;
  }

  mcpServer.registerTool(name, { description }, async () => {
    const result = await handler(undefined as TInput, ctx);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });
}
