import { type EventDefinition, type EventInput } from "./contract.js";
import type { EventStore } from "./store.js";
import { type WebhookClient } from "./webhook.js";
export interface EventSecretCodec {
  seal(secret: string): string;
  unseal(encoded: string): string;
}
export interface EventServiceOptions<F, D, I extends EventInput, V> {
  definition: EventDefinition<F, D, I, V>;
  store: EventStore<F, I>;
  codec: EventSecretCodec;
  webhooks: WebhookClient;
  authorizeSubscription(owner: string, filters: F): boolean | Promise<boolean>;
  authorizeIngress(input: I, identity: V): boolean;
  canDeliver(owner: string, data: D): boolean | Promise<boolean>;
  now?: () => number;
  maxEvents?: number;
  maxAttempts?: number;
}
export interface SubscriptionResult {
  id: string;
  refreshBefore: string;
  cursor: string;
  truncated: boolean;
}
export declare function eventCursor(
  state: {
    generation: string;
  },
  sequence: number,
): string;
export declare class EventService<F, D, I extends EventInput, V> {
  #private;
  readonly options: EventServiceOptions<F, D, I, V>;
  constructor(options: EventServiceOptions<F, D, I, V>);
  private exclusive;
  private owner;
  list(owner: string, filters?: F): Promise<unknown[]>;
  subscribe(owner: string, raw: unknown, signal: AbortSignal): Promise<SubscriptionResult>;
  unsubscribe(owner: string, raw: unknown): Promise<Record<string, never>>;
  enqueue(
    raw: unknown,
    identity: V,
  ): {
    eventId: string;
    cursor: string;
    replayed: boolean;
  };
  /** One explicit bounded pump pass. No timers or network activity occur on construction. */
  dispatchDue(
    externalSignal: AbortSignal,
    limit?: number,
  ): Promise<{
    attempted: number;
    received: number;
    deadLettered: number;
  }>;
  /** Local operator stop; never exposed as an unauthenticated MCP control. */
  stopScope(filters: F): void;
}
