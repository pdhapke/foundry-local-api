// Phase 26 — Hooks/Event Streaming. Shared types for the recent-events
// polling endpoint (server/src/endpoints/events.ts, the MCP-side narrowing
// of PLAN.md's "subscribable resource/notification stream" wording — see
// PLAN.md's Phase 26 deviations note).
//
// Unlike every other shared domain file, this one carries no `*_COMMANDS`
// bridge-command map: recent events are served straight off the server-side
// `FoundryEventBus` (server/src/events/event-bus.ts), never round-tripped
// through `FoundryClient.call()`/the bridge — the first server-only endpoint
// in this codebase. The events themselves arrive over the bridge as
// `BridgeEventMessage`s (shared/src/protocol.ts), pushed by the module, not
// pulled by a command.

/** One published Foundry hook event, as recorded in the server-side ring buffer. */
export interface FoundryEventRecord {
  /** Foundry hook name, e.g. "createActor". */
  event: string;
  payload: unknown;
  /** `Date.now()` at publish time. */
  timestamp: number;
}

export interface RecentEventsInput {
  /** Caps the number of most-recent events returned; omit to return the whole buffer. */
  limit?: number | undefined;
}

export interface RecentEventsResult {
  events: FoundryEventRecord[];
}
