// Endpoint descriptor pattern (Phase 5). One descriptor generates both an
// Express route (from Phase 6 onward, once a descriptor supplies
// `method`+`path`) and an MCP tool (always) — see registry.ts. Every later
// phase defines its endpoints this way rather than hand-rolling a route or a
// tool separately.
import type { ZodType } from "zod";

import type { FoundryClient } from "../bridge/foundry-client.js";

export interface EndpointContext {
  foundryClient: FoundryClient;
}

export interface EndpointDescriptor<TInput = void, TResult = unknown> {
  /** MCP tool name, e.g. "foundry_status". */
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
}
