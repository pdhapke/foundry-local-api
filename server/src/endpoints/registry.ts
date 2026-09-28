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
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ProtocolError } from "@foundry-local-api/shared";
import { ZodObject, type ZodRawShape } from "zod";

import type { FoundryClient } from "../bridge/foundry-client.js";
import { FoundryBridgeError, foundryBridgeErrorToHttpError } from "../bridge/errors.js";
import type { FoundryEventBus } from "../events/event-bus.js";
import type { FoundationRuntime } from "../foundations/runtime.js";
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
  const { inputSchema, outputSchema, handler } = descriptor;
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
    // Resolved off `app.locals` at request time, same convention (and same
    // reason) as `foundryClient` above — see this file's header comment.
    // Not present on any test app that doesn't set it (server/src/index.ts
    // is the only production wiring site), so descriptors that use it must
    // handle `undefined` gracefully rather than assume it's always there.
    const eventBus = req.app.locals["eventBus"] as FoundryEventBus | undefined;
    const foundations = req.app.locals["foundations"] as FoundationRuntime | undefined;
    const ctx: EndpointContext = { foundryClient, eventBus, foundations };

    Promise.resolve(handler(input, ctx))
      .then((result) => res.json(outputSchema ? outputSchema.parse(result) : result))
      .catch((err: unknown) => {
        if (err instanceof ProtocolError) {
          next(foundryBridgeErrorToHttpError(protocolToBridgeError(err)));
          return;
        }
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
 * against `mcpServer`, closure-capturing the given `foundryClient`/
 * `eventBus`. `eventBus` is optional for the same reason it's optional on
 * `EndpointContext` (types.ts) — only the recent-events tool uses it.
 *
 * Returns the `RegisteredTool` handle for each tool (Phase 32) — every
 * caller before Phase 32 ignored the return value, so this is a pure
 * additive change; Phase 32's `../integrations/mcp-tools.ts` is the first
 * caller that actually uses the handles, calling `.remove()` on them when an
 * integration goes inactive.
 */
export function registerMcpTools(
  mcpServer: McpServer,
  descriptors: AnyEndpointDescriptor[],
  foundryClient: FoundryClient,
  eventBus?: FoundryEventBus,
  foundations?: FoundationRuntime,
): RegisteredTool[] {
  const ctx: EndpointContext = { foundryClient, eventBus, foundations };
  return descriptors.map((descriptor) => registerMcpTool(descriptor, mcpServer, ctx));
}

function registerMcpTool<TInput, TResult>(
  descriptor: EndpointDescriptor<TInput, TResult>,
  mcpServer: McpServer,
  ctx: EndpointContext,
): RegisteredTool {
  const { name, description, inputSchema, outputSchema, handler, annotations } = descriptor;

  const outputShape =
    outputSchema instanceof ZodObject ? (outputSchema.shape as ZodRawShape) : undefined;
  if (outputSchema && !outputShape) {
    throw new Error(
      `MCP tool "${name}": outputSchema must be a ZodObject to be exposed as a tool.`,
    );
  }

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
    return mcpServer.registerTool(
      name,
      {
        description,
        inputSchema: shape,
        ...(outputShape ? { outputSchema: outputShape } : {}),
        ...(annotations ? { annotations } : {}),
      },
      async (args) => {
        try {
          // The SDK rebuilds a plain object from the raw shape above. Parse
          // again with the descriptor's complete schema so superRefine,
          // refine, transforms, and strictness are enforced for MCP calls too.
          const parsed = inputSchema.parse(args);
          const result = await handler(parsed as TInput, ctx);
          if (outputSchema) outputSchema.parse(result);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            ...(outputShape ? { structuredContent: result as Record<string, unknown> } : {}),
          };
        } catch (err) {
          if (err instanceof FoundryBridgeError) {
            return {
              content: [{ type: "text" as const, text: formatMcpBridgeError(err) }],
              isError: true,
            };
          }
          if (err instanceof ProtocolError) {
            return {
              content: [
                { type: "text" as const, text: formatMcpBridgeError(protocolToBridgeError(err)) },
              ],
              isError: true,
            };
          }
          throw err;
        }
      },
    );
  }

  return mcpServer.registerTool(
    name,
    {
      description,
      ...(outputShape ? { outputSchema: outputShape } : {}),
      ...(annotations ? { annotations } : {}),
    },
    async () => {
      try {
        const result = await handler(undefined as TInput, ctx);
        if (outputSchema) outputSchema.parse(result);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          ...(outputShape ? { structuredContent: result as Record<string, unknown> } : {}),
        };
      } catch (err) {
        if (err instanceof FoundryBridgeError) {
          return {
            content: [{ type: "text" as const, text: formatMcpBridgeError(err) }],
            isError: true,
          };
        }
        if (err instanceof ProtocolError) {
          return {
            content: [
              { type: "text" as const, text: formatMcpBridgeError(protocolToBridgeError(err)) },
            ],
            isError: true,
          };
        }
        throw err;
      }
    },
  );
}

function formatMcpBridgeError(error: FoundryBridgeError): string {
  return JSON.stringify({
    error: {
      code: error.code,
      message:
        error.code === "HANDLER_ERROR" ? "The Foundry command failed unexpectedly." : error.message,
      retryable: error.retryable,
      ...(error.fieldPath ? { fieldPath: error.fieldPath } : {}),
      ...(error.correlationId ? { correlationId: error.correlationId } : {}),
      ...(error.details ? { details: error.details } : {}),
    },
  });
}

function protocolToBridgeError(error: ProtocolError): FoundryBridgeError {
  return new FoundryBridgeError(error.code, error.message, {
    retryable: error.retryable,
    fieldPath: error.fieldPath,
    correlationId: error.correlationId,
    details: error.details,
  });
}
