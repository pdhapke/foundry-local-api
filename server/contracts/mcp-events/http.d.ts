import { type Express, type Request, type RequestHandler } from "express";
import type { SubscriptionResult } from "./events.js";
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}
export interface ScopedMcpTools {
  list(owner: string): Promise<McpToolDefinition[]>;
  call(
    owner: string,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>>;
}
export interface McpEventsHttpOptions {
  events: {
    list(owner: string, scope: unknown): Promise<unknown[]>;
    subscribe(owner: string, raw: unknown, signal: AbortSignal): Promise<SubscriptionResult>;
    unsubscribe(owner: string, raw: unknown): Promise<Record<string, never>>;
  };
  authenticate(request: Request, signal: AbortSignal): Promise<string | null>;
  scopeForPrincipal(owner: string): unknown | Promise<unknown>;
  tools: ScopedMcpTools;
  allowedOrigins?: readonly string[];
  serverInfo?: {
    name: string;
    version: string;
  };
}
/** Modern, stateless JSON replies. Authentication identity never comes from MCP metadata.
 * This deliberately does not forward the administrative MCP catalog or legacy sessions.
 */
export declare function createMcpEventsHandler(options: McpEventsHttpOptions): RequestHandler;
export declare function mountMcpEvents(
  app: Express,
  path: string,
  options: McpEventsHttpOptions | (() => McpEventsHttpOptions | undefined),
): void;
