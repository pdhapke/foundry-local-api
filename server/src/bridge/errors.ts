// Error normalization for the bridge (Phase 3). `FoundryClient.call` never
// throws a raw `Error` or lets a bridge-protocol error code leak out
// unnormalized — every rejection is a `FoundryBridgeError`, so route
// handlers from Phase 6 onward can catch one type and convert it into a
// proper REST error via `foundryBridgeErrorToHttpError`.
import type { ProtocolErrorCode } from "@foundry-local-api/shared";

import { HttpError } from "../http-error.js";

/**
 * The closed set of error codes a bridge call can fail with:
 *  - "NOT_CONNECTED": no module client is currently connected (checked
 *    up-front, or the connection dropped while the call was pending).
 *  - "TIMEOUT": no response arrived within the configured timeout.
 *  - "UNKNOWN_COMMAND": the module's command registry has no handler for
 *    the requested `type` (see module/src/command-registry.ts).
 *  - "HANDLER_ERROR": the module-side handler ran but threw.
 * The latter two mirror the codes the module's `dispatch()` already
 * produces (shared/src/protocol.ts `BridgeError.code`); an unrecognized or
 * missing code coming back over the wire is normalized to "HANDLER_ERROR"
 * as the closest generic bucket, so callers never have to handle an
 * open-ended string.
 */
export type FoundryBridgeErrorCode = ProtocolErrorCode;

/** Thrown/rejected by `FoundryClient.call` for every failure mode. */
export class FoundryBridgeError extends Error {
  readonly code: FoundryBridgeErrorCode;
  readonly retryable: boolean;
  readonly fieldPath: string | undefined;
  readonly correlationId: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: FoundryBridgeErrorCode,
    message: string,
    options: {
      retryable?: boolean | undefined;
      fieldPath?: string | undefined;
      correlationId?: string | undefined;
      details?: Record<string, unknown> | undefined;
    } = {},
  ) {
    super(message);
    this.name = "FoundryBridgeError";
    this.code = code;
    this.retryable = options.retryable ?? (code === "TIMEOUT" || code === "NOT_CONNECTED");
    this.fieldPath = options.fieldPath;
    this.correlationId = options.correlationId;
    this.details = options.details;
  }
}

/** Normalizes a `BridgeError.code` (an open-ended string per the shared protocol type) into our closed set. */
export function normalizeBridgeErrorCode(raw: string | undefined): FoundryBridgeErrorCode {
  switch (raw) {
    case "NOT_CONNECTED":
    case "TIMEOUT":
    case "UNKNOWN_COMMAND":
    case "HANDLER_ERROR":
    case "INVALID_PAYLOAD":
    case "PERMISSION_DENIED":
    case "NOT_FOUND":
    case "STALE_REVISION":
    case "UNSUPPORTED_VERSION":
    case "UNSUPPORTED_TYPE":
    case "IDEMPOTENCY_CONFLICT":
    case "CURSOR_GAP":
    case "PROTECTED_PATH":
    case "HASH_MISMATCH":
    case "ROLLBACK_FAILED":
    case "INCOMPLETE_RESULT":
      return raw;
    default:
      return "HANDLER_ERROR";
  }
}

/**
 * Converts a `FoundryBridgeError` into an `HttpError` (server/src/app.ts)
 * for the centralized error handler. Status choices:
 *  - NOT_CONNECTED -> 503 Service Unavailable: the HTTP server itself is
 *    fine, but its upstream dependency (a connected Foundry client) isn't
 *    there right now. 503 is the standard "try again later, the service
 *    you depend on is temporarily down" status.
 *  - TIMEOUT -> 504 Gateway Timeout: this server is acting as a gateway to
 *    the Foundry client over the bridge WebSocket, and that upstream did
 *    not respond in time — the direct semantic match for 504.
 *  - UNKNOWN_COMMAND -> 502 Bad Gateway: our request was well-formed but
 *    the upstream (module) rejected it as unrecognized, which signals a
 *    server/module version mismatch rather than anything wrong with the
 *    original HTTP request — the caller did nothing wrong, so this isn't a
 *    4xx.
 *  - HANDLER_ERROR -> 500 Internal Server Error: the module-side handler
 *    ran and threw while executing real Foundry API calls. From the HTTP
 *    caller's perspective this is an unexpected failure in fulfilling the
 *    request, the same bucket an uncaught exception in our own code would
 *    fall into. (A future phase may choose to remap specific well-known
 *    handler errors to 400/404/422 once handlers start distinguishing
 *    "bad input" from "unexpected failure"; Phase 3 doesn't have enough
 *    information to do that safely yet.)
 */
export function foundryBridgeErrorToHttpError(err: FoundryBridgeError): HttpError {
  switch (err.code) {
    case "NOT_CONNECTED":
      return new HttpError(503, err.message, err.code, err);
    case "TIMEOUT":
      return new HttpError(504, err.message, err.code, err);
    case "UNKNOWN_COMMAND":
      return new HttpError(502, err.message, err.code, err);
    case "HANDLER_ERROR":
      return new HttpError(500, err.message, err.code, err);
    case "INVALID_PAYLOAD":
      return new HttpError(400, err.message, err.code, err);
    case "PERMISSION_DENIED":
      return new HttpError(403, err.message, err.code, err);
    case "NOT_FOUND":
      return new HttpError(404, err.message, err.code, err);
    case "STALE_REVISION":
    case "IDEMPOTENCY_CONFLICT":
    case "HASH_MISMATCH":
      return new HttpError(409, err.message, err.code, err);
    case "UNSUPPORTED_VERSION":
    case "UNSUPPORTED_TYPE":
      return new HttpError(422, err.message, err.code, err);
    case "CURSOR_GAP":
    case "ROLLBACK_FAILED":
    case "INCOMPLETE_RESULT":
      return new HttpError(409, err.message, err.code, err);
    case "PROTECTED_PATH":
      return new HttpError(403, err.message, err.code, err);
    default:
      return new HttpError(500, err.message, err.code);
  }
}
