// Endpoint descriptor pattern (Phase 5, relocated out of mcp/ in Phase 6 —
// see registry.ts and index.ts). One descriptor generates both an Express
// route (from Phase 6 onward, once a descriptor supplies `method`+`path`)
// and an MCP tool (always). This lives outside `mcp/` because it is
// REST+MCP shared infrastructure, not MCP-specific.
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ZodType } from "zod";

import type { FoundryClient } from "../bridge/foundry-client.js";
import type { FoundryEventBus } from "../events/event-bus.js";
import type { FoundationRuntime } from "../foundations/runtime.js";

export interface EndpointContext {
  foundryClient: FoundryClient;
  /**
   * The server-side event bus (Phase 26), present once `server/src/index.ts`
   * wires one up. Optional — and resolved from `app.locals`/passed
   * separately rather than added to `FoundryClientOptions` or similar —
   * because most descriptors never touch it; only the recent-events polling
   * tool (server/src/endpoints/events.ts) does. Undefined in any test that
   * builds a bare `{foundryClient}` context, same as every other phase's
   * existing tests.
   */
  eventBus?: FoundryEventBus | undefined;
  foundations?: FoundationRuntime | undefined;
}

export interface EndpointDescriptor<TInput = void, TResult = unknown> {
  /** MCP tool name, e.g. "foundry_get_world". */
  name: string;
  description: string;
  inputSchema?: ZodType<TInput>;
  handler: (input: TInput, ctx: EndpointContext) => Promise<TResult> | TResult;
  /**
   * REST wiring is optional: from Phase 6 onward every descriptor should
   * supply both `method`+`path` and get a real Express route generated for
   * it. Phase 5's own `foundry_status` descriptor deliberately omits them
   * because its REST equivalent, `/health`, already exists as a
   * hand-rolled, pre-pattern, *unauthenticated* liveness route (see
   * server/src/app.ts) that predates this file — duplicating it under
   * `/api` would either collide with Phase 6's real `/api/status` or need
   * its own bespoke unauthenticated mount, neither of which is worth it for
   * a scaffold-proving tool.
   */
  method?: "get" | "post" | "put" | "delete";
  path?: string;
  /**
   * MCP tool annotation hints (Phase 15) — surfaced to MCP clients alongside
   * the tool definition. Per the MCP spec these are advisory only, not
   * enforced by the server, so a genuinely dangerous descriptor (e.g. Macro
   * execution, which runs arbitrary JS with full Foundry client privileges)
   * must also say so in plain language in `description` — `annotations` is
   * the structured "safety flag" PLAN.md's Phase 15 calls for, `description`
   * is what actually reaches a human/LLM reading the tool catalog.
   */
  annotations?: ToolAnnotations;
}

/**
 * A descriptor with its concrete `TInput`/`TResult` erased. Every collection
 * that holds descriptors of differing input/result types side by side
 * (`allEndpointDescriptors`, and the `mountRestEndpoints`/`registerMcpTools`
 * parameters that consume it) needs this: TypeScript's structural checking
 * of `inputSchema: ZodType<TInput>` is effectively invariant in `TInput`
 * under `exactOptionalPropertyTypes`, so a bare `EndpointDescriptor[]`
 * (defaulting to `EndpointDescriptor<void, unknown>`) only accepts
 * void-input descriptors — first hit in Phase 7, whose settings descriptors
 * are the first with a real (non-void) input type.
 */
export type AnyEndpointDescriptor = EndpointDescriptor<any, any>;
