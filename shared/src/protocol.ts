// Bridge protocol types shared between the server's (Phase 3) FoundryClient
// and the module's (Phase 2) command dispatcher / WebSocket bridge client.
//
// Wire shape:
//   request:  { id, type, payload? }
//   response: { id, ok: true, result } | { id, ok: false, error }

/** A request sent over the bridge WebSocket, in either direction. */
export interface BridgeRequest<TPayload = unknown> {
  /** Correlation ID, unique per in-flight request. */
  id: string;
  /** Command name, looked up in the receiving side's command registry. */
  type: string;
  /** Optional command-specific payload. */
  payload?: TPayload;
}

/** A successful reply to a {@link BridgeRequest} with the same `id`. */
export interface BridgeSuccessResponse<TResult = unknown> {
  id: string;
  ok: true;
  result: TResult;
}

/** Structured error information for a failed {@link BridgeRequest}. */
export interface BridgeError {
  message: string;
  code?: string;
}

/** A failed reply to a {@link BridgeRequest} with the same `id`. */
export interface BridgeErrorResponse {
  id: string;
  ok: false;
  error: BridgeError;
}

/** Discriminated union of every possible reply to a {@link BridgeRequest}. */
export type BridgeResponse<TResult = unknown> =
  | BridgeSuccessResponse<TResult>
  | BridgeErrorResponse;

/**
 * The shape of a single command handler. Used both by the module's command
 * dispatcher registry (Phase 2) and, from Phase 3 onward, by the server's
 * FoundryClient-side registrations — kept generic and not module-specific
 * so both sides can share the type.
 */
export type CommandHandler<TPayload = unknown, TResult = unknown> = (
  payload: TPayload,
) => TResult | Promise<TResult>;
