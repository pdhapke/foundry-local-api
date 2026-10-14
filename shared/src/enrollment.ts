import type { BridgeClientLane, BridgeHelloMessage, ConnectedBridgeClient } from "./foundations.js";

export const BRIDGE_ENROLLMENT_SCOPE = "/bridge" as const;
export const BRIDGE_ENROLLMENT_QUERY = "foundry-local-api.bridgeEnrollment" as const;

export const BRIDGE_ENROLLMENT_COMMANDS = {
  TARGET: "bridgeEnrollmentTarget",
} as const;

export type EnrollableBridgeLane = Extract<BridgeClientLane, "player" | "tv">;

export type BridgeEnrollmentErrorCode =
  | "NO_CONNECTED_GM"
  | "ENROLLMENT_REQUIRED"
  | "ENROLLMENT_INVALID"
  | "FOUNDRY_SESSION_REQUIRED"
  | "FOUNDRY_SESSION_REJECTED"
  | "FOUNDRY_SESSION_UNAVAILABLE"
  | "FOUNDRY_IDENTITY_MISMATCH"
  | "ENROLLMENT_EXPIRED"
  | "ENROLLMENT_REPLAYED"
  | "ENROLLMENT_USER_MISMATCH"
  | "ENROLLMENT_LANE_MISMATCH"
  | "ENROLLMENT_CLIENT_MISMATCH"
  | "ENROLLMENT_PROTOCOL_MISMATCH"
  | "ENROLLMENT_MODULE_MISMATCH"
  | "ENROLLMENT_PATH_MISMATCH"
  | "ENROLLMENT_REVOKED"
  | "CONSENT_REQUIRED"
  | "DUPLICATE_CLIENT"
  | "NEGOTIATION_TIMEOUT"
  | "MODULE_NOT_OBSERVED"
  | "LANE_COMMAND_DENIED"
  | "SERVER_RESTARTED";

export interface BridgeEnrollmentProbeInput {
  action: "probe";
  targetUserId: string;
  expectedLane: EnrollableBridgeLane;
}

export interface BridgeEnrollmentDeliveryInput {
  action: "deliver";
  targetUserId: string;
  expectedLane: EnrollableBridgeLane;
  expectedClientId: string;
  /** RSA-OAEP/SHA-256 ciphertext for the target client's ephemeral session key. */
  encryptedCredential: string;
  expiresAt: string;
  protocolVersion: number;
  moduleVersion: string;
}

export type BridgeEnrollmentTargetInput =
  BridgeEnrollmentProbeInput | BridgeEnrollmentDeliveryInput;

export interface BridgeEnrollmentTargetResult {
  moduleLoaded: true;
  moduleVersion: string;
  userId: string;
  clientId: string;
  /** Base64 DER SubjectPublicKeyInfo for an ephemeral, browser-memory-only RSA-OAEP key. */
  enrollmentPublicKey: string;
  /** The lane actually inferred by the responding client, including `gm` for fail-closed mismatch reporting. */
  intendedLane: BridgeClientLane;
  consentGranted: boolean;
  protocolVersion: number;
  foundryVersion: string;
  systemId: string;
  systemVersion: string;
  delivery: "not-requested" | "accepted" | "consent-required" | "rejected";
  errorCode: BridgeEnrollmentErrorCode | null;
  diagnostics: BridgeClientDiagnosticSnapshot;
}

export interface BridgeClientDiagnosticSnapshot {
  moduleLoaded: true;
  moduleVersion: string;
  userId: string;
  intendedLane: BridgeClientLane;
  consentGranted: boolean;
  connectionState: "disconnected" | "connecting" | "connected" | "rejected";
  lastConnectionAttemptAt: string | null;
  lastNegotiationResult: {
    outcome: "accepted" | "rejected";
    at: string;
    protocolVersion: number;
    moduleVersion: string;
    errorCode: string | null;
  } | null;
  errorCode: string | null;
  reconnect: {
    state: "idle" | "scheduled" | "attempting";
    attempt: number;
    nextAttemptAt: string | null;
  };
}

/** First application message for a non-GM socket. The credential is never placed in the URL. */
export interface BridgeEnrollmentHelloMessage {
  kind: "enrollment";
  credential: string;
  hello: BridgeHelloMessage;
}

export interface BridgeNegotiationMessage {
  kind: "negotiation";
  accepted: boolean;
  at: string;
  protocolVersion: number;
  moduleVersion: string;
  errorCode: BridgeEnrollmentErrorCode | null;
}

export interface IssueBridgeEnrollmentInput {
  userId: string;
  lane: EnrollableBridgeLane;
  ttlMs?: number | undefined;
}

export interface IssueBridgeEnrollmentResult {
  enrollmentId: string;
  userId: string;
  lane: EnrollableBridgeLane;
  clientId: string;
  scope: typeof BRIDGE_ENROLLMENT_SCOPE;
  protocolVersion: number;
  moduleVersion: string;
  expiresAt: string;
  deliveredAt: string;
  client: BridgeEnrollmentTargetResult;
}

export interface BridgeEnrollmentSafeEvent {
  eventId: string;
  timestamp: number;
  action: "issued" | "accepted" | "rejected" | "invalidated" | "expired";
  enrollmentId?: string;
  expectedUserId?: string;
  expectedClientId?: string;
  expectedLane?: EnrollableBridgeLane;
  observedUserId?: string;
  observedLane?: BridgeClientLane;
  expectedProtocolVersion?: number;
  observedProtocolVersion?: number;
  expectedModuleVersion?: BridgeEnrollmentModuleVersionRequirement;
  observedModuleVersion?: string;
  clientId?: string;
  reason?: string;
}

export type BridgeEnrollmentModuleVersionRequirement =
  | { kind: "exact"; version: string }
  | { kind: "range"; minInclusive: string; maxExclusive?: string };

export interface BridgeEnrollmentPendingProjection {
  enrollmentId: string;
  expectedUserId: string;
  expectedClientId: string;
  lane: EnrollableBridgeLane;
  scope: typeof BRIDGE_ENROLLMENT_SCOPE;
  protocolVersion: number;
  moduleVersion: BridgeEnrollmentModuleVersionRequirement;
  issuedAt: number;
  expiresAt: number;
  status: "pending" | "accepted" | "rejected" | "expired" | "invalidated";
  issuerUserId: string;
  issuerClientId: string;
  connectedClientId?: string;
  rejectionCode?: string;
}

export interface BridgeEnrollmentDiagnostics {
  generatedAt: string;
  pendingCount: number;
  pending: BridgeEnrollmentPendingProjection[];
  active: BridgeEnrollmentPendingProjection[];
  events: BridgeEnrollmentSafeEvent[];
  connectedClients: ConnectedBridgeClient[];
}
