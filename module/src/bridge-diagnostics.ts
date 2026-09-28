/**
 * Secrecy-safe, client-side bridge diagnostics.
 *
 * This module deliberately has no Foundry, WebSocket, storage, or logging
 * dependencies. Bridge wiring supplies already-bounded events and can expose
 * the result without risking credentials, URLs, headers, cookies, or device
 * metadata entering the diagnostics state.
 */

export type DiagnosticClientLane = "gm" | "player" | "tv";

export type BridgeConnectionState = "disconnected" | "connecting" | "connected" | "rejected";

/**
 * Closed error vocabulary suitable for logs and API projections. Never add a
 * raw error-message escape hatch here: transport errors can contain URLs or
 * credentials and must be mapped to one of these values at the integration
 * boundary.
 */
export type BridgeDiagnosticErrorCode =
  | "consent-required"
  | "protocol-version-mismatch"
  | "module-version-mismatch"
  | "enrollment-required"
  | "enrollment-expired"
  | "enrollment-replayed"
  | "enrollment-wrong-user"
  | "enrollment-wrong-lane"
  | "enrollment-wrong-client"
  | "enrollment-wrong-path"
  | "enrollment-invalid"
  | "enrollment-revoked"
  | "duplicate-client"
  | "client-replaced"
  | "connection-failed"
  | "server-unavailable"
  | "negotiation-rejected";

export interface BridgeNegotiationResult {
  outcome: "accepted" | "rejected";
  at: string;
  protocolVersion: number;
  moduleVersion: string;
  errorCode: BridgeDiagnosticErrorCode | null;
}

export interface BridgeReconnectState {
  state: "idle" | "scheduled" | "attempting";
  attempt: number;
  nextAttemptAt: string | null;
}

/**
 * A snapshot can only be created by executing module code, so `moduleLoaded`
 * is intentionally the literal `true`. A missing/disabled module is not
 * represented by fabricating a client snapshot; see
 * {@link observeMissingClientDiagnostics}.
 */
export interface BridgeClientDiagnostics {
  moduleLoaded: true;
  moduleVersion: string;
  userId: string;
  intendedLane: DiagnosticClientLane;
  consentGranted: boolean;
  connectionState: BridgeConnectionState;
  lastConnectionAttemptAt: string | null;
  lastNegotiationResult: BridgeNegotiationResult | null;
  errorCode: BridgeDiagnosticErrorCode | null;
  reconnect: BridgeReconnectState;
}

export interface InitialBridgeDiagnostics {
  moduleVersion: string;
  userId: string;
  intendedLane: DiagnosticClientLane;
  consentGranted: boolean;
}

export type BridgeDiagnosticsEvent =
  | { type: "consent-changed"; granted: boolean }
  | { type: "connection-attempted"; at: string; reconnectAttempt?: number }
  | {
      type: "negotiation-accepted";
      at: string;
      protocolVersion: number;
      moduleVersion: string;
    }
  | {
      type: "negotiation-rejected";
      at: string;
      protocolVersion: number;
      moduleVersion: string;
      errorCode: BridgeDiagnosticErrorCode;
    }
  | {
      type: "disconnected";
      errorCode: Extract<
        BridgeDiagnosticErrorCode,
        "connection-failed" | "server-unavailable"
      > | null;
    }
  | { type: "reconnect-scheduled"; attempt: number; nextAttemptAt: string }
  | { type: "client-replaced"; at: string; protocolVersion: number };

export function createBridgeDiagnostics(
  initial: InitialBridgeDiagnostics,
): BridgeClientDiagnostics {
  return {
    moduleLoaded: true,
    moduleVersion: initial.moduleVersion,
    userId: initial.userId,
    intendedLane: initial.intendedLane,
    consentGranted: initial.consentGranted,
    connectionState: "disconnected",
    lastConnectionAttemptAt: null,
    lastNegotiationResult: null,
    errorCode: null,
    reconnect: {
      state: "idle",
      attempt: 0,
      nextAttemptAt: null,
    },
  };
}

/** Applies one observed bridge lifecycle event without mutating the prior snapshot. */
export function transitionBridgeDiagnostics(
  current: BridgeClientDiagnostics,
  event: BridgeDiagnosticsEvent,
): BridgeClientDiagnostics {
  switch (event.type) {
    case "consent-changed":
      return { ...current, consentGranted: event.granted };
    case "connection-attempted": {
      const attempt = event.reconnectAttempt ?? 0;
      return {
        ...current,
        connectionState: "connecting",
        lastConnectionAttemptAt: event.at,
        errorCode: null,
        reconnect: {
          state: attempt > 0 ? "attempting" : "idle",
          attempt,
          nextAttemptAt: null,
        },
      };
    }
    case "negotiation-accepted":
      return {
        ...current,
        connectionState: "connected",
        lastNegotiationResult: {
          outcome: "accepted",
          at: event.at,
          protocolVersion: event.protocolVersion,
          moduleVersion: event.moduleVersion,
          errorCode: null,
        },
        errorCode: null,
        reconnect: { state: "idle", attempt: 0, nextAttemptAt: null },
      };
    case "negotiation-rejected":
      return {
        ...current,
        connectionState: "rejected",
        lastNegotiationResult: {
          outcome: "rejected",
          at: event.at,
          protocolVersion: event.protocolVersion,
          moduleVersion: event.moduleVersion,
          errorCode: event.errorCode,
        },
        errorCode: event.errorCode,
        reconnect: { state: "idle", attempt: 0, nextAttemptAt: null },
      };
    case "disconnected":
      return {
        ...current,
        connectionState: "disconnected",
        errorCode: event.errorCode,
        reconnect: { state: "idle", attempt: 0, nextAttemptAt: null },
      };
    case "reconnect-scheduled":
      return {
        ...current,
        connectionState: "disconnected",
        reconnect: {
          state: "scheduled",
          attempt: event.attempt,
          nextAttemptAt: event.nextAttemptAt,
        },
      };
    case "client-replaced":
      return {
        ...current,
        connectionState: "rejected",
        lastNegotiationResult: {
          outcome: "rejected",
          at: event.at,
          protocolVersion: event.protocolVersion,
          moduleVersion: current.moduleVersion,
          errorCode: "client-replaced",
        },
        errorCode: "client-replaced",
        reconnect: { state: "idle", attempt: 0, nextAttemptAt: null },
      };
  }
}

/**
 * Creates a fresh, allowlisted object even if an integration passes an object
 * with extra runtime properties. This is the only shape intended for logs,
 * REST, MCP, or module-socket diagnostics.
 */
export function projectBridgeDiagnostics(
  diagnostics: BridgeClientDiagnostics,
): BridgeClientDiagnostics {
  return {
    moduleLoaded: true,
    moduleVersion: diagnostics.moduleVersion,
    userId: diagnostics.userId,
    intendedLane: diagnostics.intendedLane,
    consentGranted: diagnostics.consentGranted,
    connectionState: diagnostics.connectionState,
    lastConnectionAttemptAt: diagnostics.lastConnectionAttemptAt,
    lastNegotiationResult:
      diagnostics.lastNegotiationResult === null
        ? null
        : {
            outcome: diagnostics.lastNegotiationResult.outcome,
            at: diagnostics.lastNegotiationResult.at,
            protocolVersion: diagnostics.lastNegotiationResult.protocolVersion,
            moduleVersion: diagnostics.lastNegotiationResult.moduleVersion,
            errorCode: diagnostics.lastNegotiationResult.errorCode,
          },
    errorCode: diagnostics.errorCode,
    reconnect: {
      state: diagnostics.reconnect.state,
      attempt: diagnostics.reconnect.attempt,
      nextAttemptAt: diagnostics.reconnect.nextAttemptAt,
    },
  };
}

export type MissingClientObservationReason = "no-registration" | "targeted-socket-ack-timeout";

export interface MissingClientDiagnosticsObservation {
  source: "server";
  clientSnapshot: null;
  reason: MissingClientObservationReason;
  expectedUserId: string;
  intendedLane: DiagnosticClientLane;
  observedAt: string;
}

/**
 * Records the server-observable boundary for a module that may be disabled or
 * not loaded. Absence or an acknowledgement timeout is evidence only; it does
 * not distinguish disabled, stale, crashed, or otherwise unreachable code.
 */
export function observeMissingClientDiagnostics(input: {
  reason: MissingClientObservationReason;
  expectedUserId: string;
  intendedLane: DiagnosticClientLane;
  observedAt: string;
}): MissingClientDiagnosticsObservation {
  return {
    source: "server",
    clientSnapshot: null,
    reason: input.reason,
    expectedUserId: input.expectedUserId,
    intendedLane: input.intendedLane,
    observedAt: input.observedAt,
  };
}
