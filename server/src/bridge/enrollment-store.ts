import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type EnrollmentLane = "player" | "tv";
export type EnrollmentScope = "/bridge";

export type EnrollmentModuleVersionRequirement =
  | { kind: "exact"; version: string }
  | { kind: "range"; minInclusive: string; maxExclusive?: string };

export interface EnrollmentIssuer {
  userId: string;
  clientId: string;
  isGM: boolean;
  connected: boolean;
}

export interface EnrollmentIssueRequest {
  issuer: EnrollmentIssuer;
  expectedUserId: string;
  expectedClientId: string;
  lane: EnrollmentLane;
  protocolVersion: number;
  moduleVersion: EnrollmentModuleVersionRequirement;
  ttlMs?: number;
}

export interface EnrollmentRedeemRequest {
  credential: string;
  userId: string;
  lane: EnrollmentLane;
  protocolVersion: number;
  moduleVersion: string;
  path: string;
  clientId: string;
  consent: boolean;
}

export type EnrollmentIssueErrorCode =
  "no_connected_gm" | "issuer_not_gm" | "invalid_issue_request";

export class EnrollmentIssueError extends Error {
  readonly code: EnrollmentIssueErrorCode;

  constructor(code: EnrollmentIssueErrorCode, message: string) {
    super(message);
    this.name = "EnrollmentIssueError";
    this.code = code;
  }
}

export type EnrollmentRejectionCode =
  | "invalid_credential"
  | "credential_expired"
  | "credential_replayed"
  | "credential_reused_by_second_client"
  | "credential_invalidated"
  | "wrong_user"
  | "wrong_lane"
  | "wrong_protocol_version"
  | "wrong_module_version"
  | "wrong_scope"
  | "consent_required"
  | "duplicate_client";

export type EnrollmentStatus = "pending" | "accepted" | "rejected" | "expired" | "invalidated";

export interface SafeEnrollmentProjection {
  enrollmentId: string;
  expectedUserId: string;
  expectedClientId: string;
  lane: EnrollmentLane;
  protocolVersion: number;
  moduleVersion: EnrollmentModuleVersionRequirement;
  scope: EnrollmentScope;
  issuedAt: number;
  expiresAt: number;
  status: EnrollmentStatus;
  issuerUserId: string;
  issuerClientId: string;
  connectedClientId?: string;
  rejectionCode?: EnrollmentRejectionCode;
}

export interface IssuedEnrollment {
  /** Returned exactly once to the authenticated GM distribution path. */
  credential: string;
  enrollment: SafeEnrollmentProjection;
}

export interface EnrollmentAuthorization {
  enrollmentId: string;
  userId: string;
  lane: EnrollmentLane;
  clientId: string;
  protocolVersion: number;
  moduleVersion: string;
  scope: EnrollmentScope;
  allowedCommands: readonly string[];
  acceptedAt: number;
  expiresAt: number;
}

export type EnrollmentRedeemResult =
  | { ok: true; authorization: EnrollmentAuthorization }
  | { ok: false; code: EnrollmentRejectionCode };

export type EnrollmentEventAction = "issued" | "accepted" | "rejected" | "invalidated" | "expired";

export interface SafeEnrollmentEvent {
  eventId: string;
  timestamp: number;
  action: EnrollmentEventAction;
  enrollmentId?: string;
  expectedUserId?: string;
  expectedClientId?: string;
  expectedLane?: EnrollmentLane;
  observedUserId?: string;
  observedLane?: EnrollmentLane | "gm" | undefined;
  expectedProtocolVersion?: number;
  observedProtocolVersion?: number;
  expectedModuleVersion?: EnrollmentModuleVersionRequirement;
  observedModuleVersion?: string;
  clientId?: string;
  reason?: EnrollmentRejectionCode | EnrollmentInvalidationReason | EnrollmentObservationReason;
}

export type EnrollmentObservationReason = "no_connected_gm" | "module_not_observed";

export interface EnrollmentRejectedObservation {
  expectedUserId: string;
  expectedLane: EnrollmentLane;
  reason: EnrollmentRejectionCode | EnrollmentObservationReason;
  observedUserId?: string;
  observedLane?: EnrollmentLane | "gm";
  expectedProtocolVersion?: number;
  observedProtocolVersion?: number;
  observedModuleVersion?: string;
  clientId?: string;
}

export type EnrollmentInvalidationReason =
  "rotated" | "client_disconnected" | "server_restart" | "administrative";

export interface EnrollmentStoreOptions {
  defaultTtlMs?: number;
  maxTtlMs?: number;
  /**
   * Lifetime of an accepted (redeemed) bridge session, measured from
   * acceptance. Independent of the short one-time credential TTL so a client
   * that enrolled inside the credential window stays authorized for a full
   * play session. Defaults to 8 hours; must not exceed 24 hours.
   */
  sessionTtlMs?: number;
  maxEvents?: number;
  now?: () => number;
  laneCommandAllowlist?: Partial<Record<EnrollmentLane, readonly string[]>>;
}

export interface SafeEnrollmentDiagnostics {
  pendingCount: number;
  pending: SafeEnrollmentProjection[];
  active: SafeEnrollmentProjection[];
  events: SafeEnrollmentEvent[];
}

interface EnrollmentRecord {
  enrollmentId: string;
  credentialDigest: Buffer;
  expectedUserId: string;
  expectedClientId: string;
  lane: EnrollmentLane;
  protocolVersion: number;
  moduleVersion: EnrollmentModuleVersionRequirement;
  scope: EnrollmentScope;
  issuedAt: number;
  expiresAt: number;
  status: EnrollmentStatus;
  issuerUserId: string;
  issuerClientId: string;
  connectedClientId?: string;
  acceptedAt?: number;
  rejectionCode?: EnrollmentRejectionCode;
}

const CREDENTIAL_PATTERN = /^fle1_([A-Za-z0-9_-]{22})_([A-Za-z0-9_-]{43})$/;
const DEFAULT_TTL_MS = 2 * 60 * 1000;
const DEFAULT_MAX_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_EVENTS = 500;
export const DEFAULT_BRIDGE_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const MAX_BRIDGE_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export type BridgeSessionTtlSource = "default" | "env" | "clamped" | "invalid";

/**
 * Resolves the accepted bridge session lifetime from an optional raw env value
 * (BRIDGE_SESSION_TTL_MS). Unset/blank uses the 8 hour default; a value that is
 * not a positive integer falls back to the default; values above 24 hours are
 * clamped to 24 hours.
 */
export function resolveBridgeSessionTtlMs(raw: string | undefined): {
  ttlMs: number;
  source: BridgeSessionTtlSource;
} {
  if (raw === undefined || raw.trim() === "") {
    return { ttlMs: DEFAULT_BRIDGE_SESSION_TTL_MS, source: "default" };
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { ttlMs: DEFAULT_BRIDGE_SESSION_TTL_MS, source: "invalid" };
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    if (Number.isFinite(parsed) && parsed > 0) {
      return { ttlMs: MAX_BRIDGE_SESSION_TTL_MS, source: "clamped" };
    }
    return { ttlMs: DEFAULT_BRIDGE_SESSION_TTL_MS, source: "invalid" };
  }
  if (parsed > MAX_BRIDGE_SESSION_TTL_MS) {
    return { ttlMs: MAX_BRIDGE_SESSION_TTL_MS, source: "clamped" };
  }
  return { ttlMs: parsed, source: "env" };
}

/**
 * In-memory, restart-scoped one-time bridge enrollment store.
 *
 * Raw credentials are returned only from issue/rotate and are never retained.
 * Records contain a SHA-256 digest plus non-secret binding metadata. A new store
 * after process restart therefore has no credentials or active authorizations.
 *
 * The one-time credential expires quickly (default 2 min, max 10 min), but once
 * redeemed the accepted session gets its own lifetime (sessionTtlMs, default
 * 8 h) measured from acceptance. Rotation, disconnect, restart, and
 * administrative invalidation still end a session immediately.
 */
export class EnrollmentStore {
  private readonly records = new Map<string, EnrollmentRecord>();
  private readonly events: SafeEnrollmentEvent[] = [];
  private readonly now: () => number;
  private readonly defaultTtlMs: number;
  private readonly maxTtlMs: number;
  private readonly sessionTtlMs: number;
  private readonly maxEvents: number;
  private readonly allowlists: Record<EnrollmentLane, readonly string[]>;

  constructor(options: EnrollmentStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.maxTtlMs = options.maxTtlMs ?? DEFAULT_MAX_TTL_MS;
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_BRIDGE_SESSION_TTL_MS;
    if (
      !Number.isSafeInteger(this.sessionTtlMs) ||
      this.sessionTtlMs <= 0 ||
      this.sessionTtlMs > MAX_BRIDGE_SESSION_TTL_MS
    ) {
      throw new Error("Enrollment session TTL configuration is invalid");
    }
    if (this.defaultTtlMs <= 0 || this.maxTtlMs <= 0 || this.defaultTtlMs > this.maxTtlMs) {
      throw new Error("Enrollment TTL configuration is invalid");
    }
    if (!Number.isSafeInteger(this.maxEvents) || this.maxEvents <= 0) {
      throw new Error("Enrollment event limit must be a positive safe integer");
    }
    this.allowlists = {
      player: normalizeCommands(options.laneCommandAllowlist?.player ?? []),
      tv: normalizeCommands(options.laneCommandAllowlist?.tv ?? []),
    };
  }

  issue(request: EnrollmentIssueRequest): IssuedEnrollment {
    this.assertIssueRequest(request);
    this.invalidateMatching(request.expectedUserId, request.lane, "rotated", false);
    return this.createCredential(request);
  }

  /** Invalidates pending and active enrollment for the identity before issuing a replacement. */
  rotate(request: EnrollmentIssueRequest): IssuedEnrollment {
    this.assertIssueRequest(request);
    this.invalidateMatching(request.expectedUserId, request.lane, "rotated", true);
    return this.createCredential(request);
  }

  redeem(request: EnrollmentRedeemRequest): EnrollmentRedeemResult {
    const observed = safeObserved(request);
    const match = CREDENTIAL_PATTERN.exec(request.credential);
    if (!match) {
      this.recordEvent({ action: "rejected", ...observed, reason: "invalid_credential" });
      return { ok: false, code: "invalid_credential" };
    }

    const enrollmentId = match[1];
    if (!enrollmentId) {
      this.recordEvent({ action: "rejected", ...observed, reason: "invalid_credential" });
      return { ok: false, code: "invalid_credential" };
    }
    const record = this.records.get(enrollmentId);
    if (!record || !digestMatches(request.credential, record.credentialDigest)) {
      this.recordEvent({
        action: "rejected",
        enrollmentId,
        ...observed,
        reason: "invalid_credential",
      });
      return { ok: false, code: "invalid_credential" };
    }

    const expected = safeExpected(record);
    if (record.status === "accepted") {
      const code =
        record.connectedClientId === request.clientId
          ? "credential_replayed"
          : "credential_reused_by_second_client";
      this.recordEvent({ action: "rejected", ...expected, ...observed, reason: code });
      return { ok: false, code };
    }
    if (record.status === "invalidated") {
      this.recordEvent({
        action: "rejected",
        ...expected,
        ...observed,
        reason: "credential_invalidated",
      });
      return { ok: false, code: "credential_invalidated" };
    }
    if (record.status === "expired" || this.now() >= record.expiresAt) {
      record.status = "expired";
      this.recordEvent({
        action: "expired",
        ...expected,
        ...observed,
        reason: "credential_expired",
      });
      return { ok: false, code: "credential_expired" };
    }
    if (record.status === "rejected") {
      const code = record.rejectionCode ?? "credential_invalidated";
      this.recordEvent({ action: "rejected", ...expected, ...observed, reason: code });
      return { ok: false, code };
    }

    const rejection = this.validateBindings(record, request);
    if (rejection) {
      record.status = "rejected";
      record.rejectionCode = rejection;
      this.recordEvent({ action: "rejected", ...expected, ...observed, reason: rejection });
      return { ok: false, code: rejection };
    }

    const duplicate = [...this.records.values()].some(
      (candidate) =>
        candidate.status === "accepted" &&
        candidate.expectedUserId === record.expectedUserId &&
        candidate.lane === record.lane &&
        candidate.connectedClientId !== request.clientId,
    );
    if (duplicate) {
      record.status = "rejected";
      record.rejectionCode = "duplicate_client";
      this.recordEvent({
        action: "rejected",
        ...expected,
        ...observed,
        reason: "duplicate_client",
      });
      return { ok: false, code: "duplicate_client" };
    }

    const acceptedAt = this.now();
    record.status = "accepted";
    record.connectedClientId = request.clientId;
    record.acceptedAt = acceptedAt;
    // The credential window only gates redemption; the accepted session gets
    // its own lifetime from acceptance so play is not cut off at the
    // credential's (<= 10 min) expiry.
    record.expiresAt = acceptedAt + this.sessionTtlMs;
    this.recordEvent({ action: "accepted", ...expected, ...observed });
    return {
      ok: true,
      authorization: {
        enrollmentId: record.enrollmentId,
        userId: record.expectedUserId,
        lane: record.lane,
        clientId: request.clientId,
        protocolVersion: record.protocolVersion,
        moduleVersion: request.moduleVersion,
        scope: record.scope,
        allowedCommands: [...this.allowlists[record.lane]],
        acceptedAt,
        expiresAt: record.expiresAt,
      },
    };
  }

  /** Fail-closed command check tied to the active enrolled client identity. */
  isCommandAllowed(clientId: string, command: string): boolean {
    if (!clientId || !command) return false;
    const active = this.findActiveClient(clientId);
    return active ? this.allowlists[active.lane].includes(command) : false;
  }

  /**
   * Verifies that an enrolled socket still owns an unexpired authorization
   * for its exact negotiated user and lane. Rotation, disconnect, restart,
   * and expiry all fail closed without relying on the socket closing first.
   */
  isClientAuthorized(clientId: string, userId: string, lane: EnrollmentLane): boolean {
    const active = this.findActiveClient(clientId);
    return active?.expectedUserId === userId && active.lane === lane;
  }

  invalidateClient(
    clientId: string,
    reason: EnrollmentInvalidationReason = "client_disconnected",
  ): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.status !== "accepted" || record.connectedClientId !== clientId) continue;
      this.invalidateRecord(record, reason);
      count += 1;
    }
    return count;
  }

  invalidateForRestart(): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.status !== "pending" && record.status !== "accepted") continue;
      this.invalidateRecord(record, "server_restart");
      count += 1;
    }
    return count;
  }

  listPending(): SafeEnrollmentProjection[] {
    this.markExpired();
    return [...this.records.values()]
      .filter((record) => record.status === "pending")
      .map(projectRecord)
      .sort((a, b) => a.issuedAt - b.issuedAt);
  }

  pendingCount(): number {
    return this.listPending().length;
  }

  listActive(): SafeEnrollmentProjection[] {
    this.markExpired();
    return [...this.records.values()]
      .filter((record) => record.status === "accepted")
      .map(projectRecord)
      .sort((a, b) => a.issuedAt - b.issuedAt);
  }

  listEvents(): SafeEnrollmentEvent[] {
    return this.events.map((event) => ({
      ...event,
      ...(event.expectedModuleVersion
        ? { expectedModuleVersion: cloneVersionRequirement(event.expectedModuleVersion) }
        : {}),
    }));
  }

  getDiagnostics(): SafeEnrollmentDiagnostics {
    const pending = this.listPending();
    return {
      pendingCount: pending.length,
      pending,
      active: this.listActive(),
      events: this.listEvents(),
    };
  }

  /** Records a bounded rejection observed before a credential can safely be issued. */
  recordRejectedObservation(observation: EnrollmentRejectedObservation): void {
    this.recordEvent({ action: "rejected", ...observation });
  }

  private createCredential(request: EnrollmentIssueRequest): IssuedEnrollment {
    const now = this.now();
    const ttlMs = request.ttlMs ?? this.defaultTtlMs;
    const enrollmentId = randomBytes(16).toString("base64url");
    const credential = `fle1_${enrollmentId}_${randomBytes(32).toString("base64url")}`;
    const record: EnrollmentRecord = {
      enrollmentId,
      credentialDigest: digest(credential),
      expectedUserId: request.expectedUserId,
      expectedClientId: request.expectedClientId,
      lane: request.lane,
      protocolVersion: request.protocolVersion,
      moduleVersion: cloneVersionRequirement(request.moduleVersion),
      scope: "/bridge",
      issuedAt: now,
      expiresAt: now + ttlMs,
      status: "pending",
      issuerUserId: request.issuer.userId,
      issuerClientId: request.issuer.clientId,
    };
    this.records.set(enrollmentId, record);
    this.recordEvent({ action: "issued", ...safeExpected(record) });
    return { credential, enrollment: projectRecord(record) };
  }

  private assertIssueRequest(request: EnrollmentIssueRequest): void {
    if (!request.issuer.connected) {
      throw new EnrollmentIssueError("no_connected_gm", "A connected GM bridge client is required");
    }
    if (!request.issuer.isGM) {
      throw new EnrollmentIssueError("issuer_not_gm", "Only a GM may issue bridge enrollment");
    }
    const ttlMs = request.ttlMs ?? this.defaultTtlMs;
    if (
      !isBoundedIdentifier(request.issuer.userId) ||
      !isBoundedIdentifier(request.issuer.clientId) ||
      !isBoundedIdentifier(request.expectedUserId) ||
      !isBoundedIdentifier(request.expectedClientId) ||
      (request.lane !== "player" && request.lane !== "tv") ||
      !Number.isSafeInteger(request.protocolVersion) ||
      request.protocolVersion <= 0 ||
      !Number.isSafeInteger(ttlMs) ||
      ttlMs <= 0 ||
      ttlMs > this.maxTtlMs ||
      !isValidVersionRequirement(request.moduleVersion)
    ) {
      throw new EnrollmentIssueError("invalid_issue_request", "Enrollment request is invalid");
    }
  }

  private validateBindings(
    record: EnrollmentRecord,
    request: EnrollmentRedeemRequest,
  ): EnrollmentRejectionCode | null {
    if (request.path !== record.scope) return "wrong_scope";
    if (request.userId !== record.expectedUserId) return "wrong_user";
    if (request.clientId !== record.expectedClientId) return "credential_reused_by_second_client";
    if (request.lane !== record.lane) return "wrong_lane";
    if (request.protocolVersion !== record.protocolVersion) return "wrong_protocol_version";
    if (!matchesVersion(request.moduleVersion, record.moduleVersion)) return "wrong_module_version";
    if (request.consent !== true) return "consent_required";
    if (!isBoundedIdentifier(request.clientId)) return "invalid_credential";
    return null;
  }

  private invalidateMatching(
    expectedUserId: string,
    lane: EnrollmentLane,
    reason: EnrollmentInvalidationReason,
    includeAccepted: boolean,
  ): void {
    for (const record of this.records.values()) {
      if (record.expectedUserId !== expectedUserId || record.lane !== lane) continue;
      if (record.status === "pending" || (includeAccepted && record.status === "accepted")) {
        this.invalidateRecord(record, reason);
      }
    }
  }

  private invalidateRecord(record: EnrollmentRecord, reason: EnrollmentInvalidationReason): void {
    record.status = "invalidated";
    this.recordEvent({ action: "invalidated", ...safeExpected(record), reason });
  }

  private markExpired(): void {
    const now = this.now();
    for (const record of this.records.values()) {
      if ((record.status !== "pending" && record.status !== "accepted") || now < record.expiresAt)
        continue;
      record.status = "expired";
      this.recordEvent({
        action: "expired",
        ...safeExpected(record),
        reason: "credential_expired",
      });
    }
  }

  private findActiveClient(clientId: string): EnrollmentRecord | undefined {
    this.markExpired();
    return [...this.records.values()].find(
      (record) => record.status === "accepted" && record.connectedClientId === clientId,
    );
  }

  private recordEvent(event: Omit<SafeEnrollmentEvent, "eventId" | "timestamp">): void {
    this.events.push({
      eventId: randomBytes(12).toString("base64url"),
      timestamp: this.now(),
      ...event,
    });
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function digestMatches(value: string, expected: Buffer): boolean {
  const actual = digest(value);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isBoundedIdentifier(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function normalizeCommands(commands: readonly string[]): readonly string[] {
  if (commands.some((command) => !isBoundedIdentifier(command))) {
    throw new Error("Enrollment command allowlist contains an invalid command");
  }
  return [...new Set(commands)].sort();
}

function isValidVersionRequirement(requirement: EnrollmentModuleVersionRequirement): boolean {
  if (requirement.kind === "exact") return isBoundedIdentifier(requirement.version);
  const min = parseVersion(requirement.minInclusive);
  if (!min) return false;
  if (requirement.maxExclusive === undefined) return true;
  const max = parseVersion(requirement.maxExclusive);
  return max !== null && compareVersions(min, max) < 0;
}

function matchesVersion(version: string, requirement: EnrollmentModuleVersionRequirement): boolean {
  if (requirement.kind === "exact") return version === requirement.version;
  const observed = parseVersion(version);
  const min = parseVersion(requirement.minInclusive);
  if (!observed || !min || compareVersions(observed, min) < 0) return false;
  if (requirement.maxExclusive === undefined) return true;
  const max = parseVersion(requirement.maxExclusive);
  return max !== null && compareVersions(observed, max) < 0;
}

type ParsedVersion = readonly [number, number, number];

function parseVersion(version: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return null;
  const parsed = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return parsed.every(Number.isSafeInteger) ? parsed : null;
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (let index = 0; index < left.length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function cloneVersionRequirement(
  requirement: EnrollmentModuleVersionRequirement,
): EnrollmentModuleVersionRequirement {
  return requirement.kind === "exact"
    ? { kind: "exact", version: requirement.version }
    : {
        kind: "range",
        minInclusive: requirement.minInclusive,
        ...(requirement.maxExclusive === undefined
          ? {}
          : { maxExclusive: requirement.maxExclusive }),
      };
}

function projectRecord(record: EnrollmentRecord): SafeEnrollmentProjection {
  return {
    enrollmentId: record.enrollmentId,
    expectedUserId: record.expectedUserId,
    expectedClientId: record.expectedClientId,
    lane: record.lane,
    protocolVersion: record.protocolVersion,
    moduleVersion: cloneVersionRequirement(record.moduleVersion),
    scope: record.scope,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    status: record.status,
    issuerUserId: record.issuerUserId,
    issuerClientId: record.issuerClientId,
    ...(record.connectedClientId === undefined
      ? {}
      : { connectedClientId: record.connectedClientId }),
    ...(record.rejectionCode === undefined ? {} : { rejectionCode: record.rejectionCode }),
  };
}

function safeExpected(
  record: EnrollmentRecord,
): Pick<
  SafeEnrollmentEvent,
  | "enrollmentId"
  | "expectedUserId"
  | "expectedClientId"
  | "expectedLane"
  | "expectedProtocolVersion"
  | "expectedModuleVersion"
> {
  return {
    enrollmentId: record.enrollmentId,
    expectedUserId: record.expectedUserId,
    expectedClientId: record.expectedClientId,
    expectedLane: record.lane,
    expectedProtocolVersion: record.protocolVersion,
    expectedModuleVersion: cloneVersionRequirement(record.moduleVersion),
  };
}

function safeObserved(
  request: EnrollmentRedeemRequest,
): Partial<
  Pick<
    SafeEnrollmentEvent,
    | "observedUserId"
    | "observedLane"
    | "observedProtocolVersion"
    | "observedModuleVersion"
    | "clientId"
  >
> {
  const safeUserId = safeDiagnosticValue(request.userId, request.credential);
  const safeModuleVersion = safeDiagnosticValue(request.moduleVersion, request.credential);
  const safeClientId = safeDiagnosticValue(request.clientId, request.credential);
  return {
    ...(safeUserId === undefined ? {} : { observedUserId: safeUserId }),
    ...(request.lane === "player" || request.lane === "tv" ? { observedLane: request.lane } : {}),
    ...(Number.isSafeInteger(request.protocolVersion)
      ? { observedProtocolVersion: request.protocolVersion }
      : {}),
    ...(safeModuleVersion === undefined ? {} : { observedModuleVersion: safeModuleVersion }),
    ...(safeClientId === undefined ? {} : { clientId: safeClientId }),
  };
}

function safeDiagnosticValue(value: unknown, credential: string): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return undefined;
  if (
    value.includes(credential) ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    })
  ) {
    return "[redacted]";
  }
  return value;
}
