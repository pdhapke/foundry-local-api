import type { z } from "zod";
export declare const MCP_EVENTS_PROTOCOL_VERSION = "2026-07-28";
export interface EventInput {
  eventId: string;
  timestamp: string;
}
/** Domain adapters own schemas, occurrence identity, and scope semantics. */
export interface EventDefinition<F, D, I extends EventInput, V> {
  name: string;
  description: string;
  filtersSchema: z.ZodType<F>;
  dataSchema: z.ZodType<D>;
  inputSchema: z.ZodType<I>;
  identitySchema: z.ZodType<V>;
  eventId(data: D): string;
  data(input: I): D;
  canonicalFilters(filters: F): string;
  matchesFilters(data: D, filters: F): boolean;
  sameScope(subscription: F, scope: F): boolean;
  validateOccurrence(input: I, now: number): boolean;
}
export interface EventEnvelope<D> {
  eventId: string;
  name: string;
  timestamp: string;
  data: D;
  cursor: string;
}
/** Only fixed safe messages may cross the protocol boundary. */
export declare class McpError extends Error {
  readonly code: number;
  readonly reason?: string | undefined;
  constructor(code: number, message: string, reason?: string | undefined);
}
