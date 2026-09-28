/** Cross-cutting protocol foundations used by every MCP requirement. */
export const BRIDGE_PROTOCOL_VERSION = 2;

export type BridgeClientLane = "gm" | "player" | "tv";

export interface BridgeClientIdentity {
  clientId: string;
  userId: string;
  userName: string;
  isGM: boolean;
  lane: BridgeClientLane;
  optedIn: boolean;
}

export interface BridgeVersionInfo {
  protocolVersion: number;
  foundryVersion: string;
  systemId: string;
  systemVersion: string;
  moduleVersion: string;
  transport: "websocket";
}

/** First application message sent by every module client after opening the socket. */
export interface BridgeHelloMessage {
  kind: "hello";
  identity: BridgeClientIdentity;
  versions: BridgeVersionInfo;
  capabilities: string[];
}

export interface ConnectedBridgeClient extends BridgeClientIdentity, BridgeVersionInfo {
  connectedAt: number;
  lastSeenAt: number;
  capabilities: string[];
}

export type ProtocolErrorCode =
  | "NOT_CONNECTED"
  | "TIMEOUT"
  | "UNKNOWN_COMMAND"
  | "INVALID_PAYLOAD"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "STALE_REVISION"
  | "UNSUPPORTED_VERSION"
  | "UNSUPPORTED_TYPE"
  | "IDEMPOTENCY_CONFLICT"
  | "CURSOR_GAP"
  | "PROTECTED_PATH"
  | "HASH_MISMATCH"
  | "ROLLBACK_FAILED"
  | "INCOMPLETE_RESULT"
  | "NO_CONNECTED_GM"
  | "ENROLLMENT_REQUIRED"
  | "ENROLLMENT_INVALID"
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
  | "SERVER_RESTARTED"
  | "HANDLER_ERROR";

export interface StructuredProtocolError {
  code: ProtocolErrorCode;
  message: string;
  retryable: boolean;
  fieldPath?: string | undefined;
  correlationId?: string | undefined;
  /** Details must already be redacted and safe for an authenticated caller. */
  details?: Record<string, unknown> | undefined;
}

export class ProtocolError extends Error implements StructuredProtocolError {
  readonly code: ProtocolErrorCode;
  readonly retryable: boolean;
  readonly fieldPath: string | undefined;
  readonly correlationId: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(error: Omit<StructuredProtocolError, "message"> & { message: string }) {
    super(error.message);
    this.name = "ProtocolError";
    this.code = error.code;
    this.retryable = error.retryable;
    this.fieldPath = error.fieldPath;
    this.correlationId = error.correlationId;
    this.details = error.details;
  }
}

export interface RevisionExpectation {
  expectedRevision?: string | undefined;
}

export interface IdempotencyOptions {
  idempotencyKey?: string | undefined;
}

export function assertIdempotencyKey(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
    throw new ProtocolError({
      code: "INVALID_PAYLOAD",
      message: "Idempotency keys must be 8-128 portable characters.",
      retryable: false,
      fieldPath: "idempotencyKey",
    });
  }
}

export type CapabilityState = "supported" | "partial" | "unsupported";

export interface CapabilityReportEntry {
  id: string;
  state: CapabilityState;
  connected: boolean;
  liveVerified: boolean;
  notes?: string[] | undefined;
}

export interface CapabilityReport {
  generatedAt: number;
  serverVersion: string;
  protocolVersion: number;
  clients: ConnectedBridgeClient[];
  capabilities: CapabilityReportEntry[];
}

export interface MutationAuditRecord {
  timestamp: string;
  correlationId: string;
  command: string;
  requestingUserId: string | null;
  effectiveUserId: string | null;
  executingClientId: string | null;
  outcome: "started" | "succeeded" | "failed";
  operation?: string | undefined;
  permissionDecision?:
    | { allowed: boolean; requiredPermission?: string | undefined; reason?: string | undefined }
    | undefined;
  mutationIds?: string[] | undefined;
  errorCode?: ProtocolErrorCode | undefined;
  payloadSummary?: unknown;
}

export interface TestFixtureDocumentRef {
  documentType: string;
  id: string;
  parentType?: string | undefined;
  parentId?: string | undefined;
}

export interface TestFixtureRun {
  testRunId: string;
  namespace: "foundry-local-api";
  createdAt: string;
  documents: TestFixtureDocumentRef[];
  files: Array<{ root?: string | undefined; path: string; sha256: string }>;
}

export interface RecordFixtureFileInput {
  testRunId: string;
  file: { root: string; path: string; sha256: string };
}
