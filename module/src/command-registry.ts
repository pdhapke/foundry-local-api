// Command dispatcher registry for the Foundry module bridge client.
//
// Later phases (6+) register real Foundry API command handlers here
// (get world info, actor CRUD, etc.) without touching the transport code
// in bridge-client.ts. Phase 2 registers only a trivial `ping` proof-of-life
// handler.

import {
  ProtocolError,
  type BridgeRequest,
  type BridgeResponse,
  type CommandHandler,
} from "@foundry-local-api/shared";

const handlers = new Map<string, CommandHandler>();

/** Registers a command handler for the given command `type`. */
export function registerCommand<TPayload = unknown, TResult = unknown>(
  type: string,
  handler: CommandHandler<TPayload, TResult>,
): void {
  handlers.set(type, handler as CommandHandler);
}

/** Removes a registered command handler, if one exists. Mainly for tests. */
export function unregisterCommand(type: string): void {
  handlers.delete(type);
}

/** Returns a snapshot of registered command types. Mainly for wiring tests. */
export function listRegisteredCommands(): string[] {
  return [...handlers.keys()];
}

/**
 * Looks up the handler for `request.type`, invokes it with `request.payload`,
 * and turns the outcome into a {@link BridgeResponse}. Never throws: handler
 * errors and unknown command types both become an error response carrying
 * the same request `id`, so a single bad request can't crash the dispatcher
 * or the bridge connection.
 */
export async function dispatch(request: BridgeRequest): Promise<BridgeResponse> {
  const handler = handlers.get(request.type);

  if (!handler) {
    return {
      id: request.id,
      ok: false,
      error: {
        message: `Unknown command "${request.type}"`,
        code: "UNKNOWN_COMMAND",
      },
    };
  }

  try {
    const result = await handler(request.payload);
    return { id: request.id, ok: true, result };
  } catch (err) {
    if (err instanceof ProtocolError) {
      return {
        id: request.id,
        ok: false,
        error: {
          message: err.message,
          code: err.code,
          retryable: err.retryable,
          ...(err.fieldPath ? { fieldPath: err.fieldPath } : {}),
          ...(err.correlationId ? { correlationId: err.correlationId } : {}),
          ...(err.details ? { details: err.details } : {}),
        },
      };
    }
    return {
      id: request.id,
      ok: false,
      error: {
        message: err instanceof Error ? err.message : String(err),
        code: "HANDLER_ERROR",
      },
    };
  }
}

registerCommand("ping", (payload: unknown) => ({ pong: true, payload }));
