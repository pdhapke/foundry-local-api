// Phase 26 — Hooks/Event Streaming: the MCP-side half.
//
// PLAN.md's Phase 26 text asks for the event stream to be exposed "over MCP
// as a subscribable resource/notification stream". The installed
// `@modelcontextprotocol/sdk` (v1.30.0)'s high-level `McpServer` wrapper
// (server/src/mcp/create-mcp-server.ts) has `registerResource()` and the
// low-level `Server` has `sendResourceUpdated()`/`sendResourceListChanged()`,
// but neither layer implements `resources/subscribe`/`resources/unsubscribe`
// request handling or per-client subscription bookkeeping — that would need
// hand-rolling protocol-level request handlers via the low-level `Server`
// underneath `McpServer`, materially expanding `createMcpServer()`'s surface
// for a single-tenant local server that already has a bounded, replayable
// event history. Narrowed to a plain descriptor-pattern polling tool
// instead, consistent with this project's repeated "prefer a working,
// well-tested narrower solution over a half-working literal one" precedent
// (see PLAN.md's Phase 15/21/22 deviation notes): `foundry_get_recent_events`
// reads `FoundryEventBus.recent()` (server/src/events/event-bus.ts)
// directly — no bridge round-trip, since events already live server-side by
// the time this fires. The REST route (`GET /api/events`, SSE) remains the
// live/streaming surface for a client that wants push delivery.
import { z } from "zod";

import type { RecentEventsInput, RecentEventsResult } from "@foundry-local-api/shared";

import { HttpError } from "../app.js";
import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";

const recentEventsSchema = z.object({
  limit: z.coerce.number().int().positive().optional(),
});

const recentEventsDescriptor: EndpointDescriptor<RecentEventsInput, RecentEventsResult> = {
  name: "foundry_get_recent_events",
  description:
    "Reads the most recently published Foundry hook events (createActor, updateToken, etc.) from a bounded in-memory buffer — a polling alternative to the live-streaming GET /api/events SSE endpoint, for MCP clients without a subscribe-to-a-stream primitive. Optional `limit` caps how many of the most recent events are returned.",
  method: "get",
  path: "/events/recent",
  inputSchema: recentEventsSchema,
  handler: ({ limit }, { eventBus }) => {
    if (!eventBus) {
      throw new HttpError(
        503,
        "No event bus is currently wired up on this server.",
        "NO_EVENT_BUS",
      );
    }
    return { events: eventBus.recent(limit) };
  },
};

export const eventEndpointDescriptors: AnyEndpointDescriptor[] = [recentEventsDescriptor];
