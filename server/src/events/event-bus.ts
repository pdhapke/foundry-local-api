// Phase 26 — Hooks/Event Streaming: server-side event bus.
//
// Sits between `FoundryClient.onEvent()` (which receives raw pushed bridge
// events) and this phase's two consumers — the SSE route
// (server/src/endpoints/events-sse.ts) and the MCP-side polling tool
// (server/src/endpoints/events.ts). Deliberately dependency-free (no
// Express/MCP imports) — pure infra, the same role `BridgeGateway` plays for
// raw bridge messages without knowing about HTTP.
import type { FoundryEventRecord } from "@foundry-local-api/shared";

export type FoundryEventListener = (event: string, payload: unknown) => void;

/** Most recent events kept in memory for `recent()` — bounds memory use for a long-running server process. */
const DEFAULT_CAPACITY = 200;

export class FoundryEventBus {
  private readonly capacity: number;
  private readonly buffer: FoundryEventRecord[] = [];
  private readonly listeners = new Set<FoundryEventListener>();

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.capacity = capacity;
  }

  /** Records `event`/`payload` into the ring buffer and notifies every live subscriber. */
  publish(event: string, payload: unknown): void {
    this.buffer.push({ event, payload, timestamp: Date.now() });
    if (this.buffer.length > this.capacity) {
      this.buffer.shift();
    }
    for (const listener of this.listeners) {
      listener(event, payload);
    }
  }

  /** Registers a listener invoked on every future `publish()`. Returns an unsubscribe function. */
  subscribe(listener: FoundryEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Returns the `limit` most recent events (oldest first), or the whole buffer if `limit` is omitted. */
  recent(limit?: number): FoundryEventRecord[] {
    if (limit === undefined || limit >= this.buffer.length) {
      return [...this.buffer];
    }
    return this.buffer.slice(this.buffer.length - limit);
  }
}
