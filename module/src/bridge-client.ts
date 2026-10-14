import { LATENCY_BUILD } from "./latency-build.js";
import { registerDocumentGuard } from "./document-guards.js";
import type { BrowserBridgeApi } from "./extensions/bridge.js";
// WebSocket bridge client: connects the in-Foundry module out to the local
// server process (server/, Phase 1+). The server-side `/bridge` WS gateway
// doesn't exist until Phase 3, so a live connection attempt made against
// today's server will fail and retry via the backoff loop below — that is
// expected until Phase 3 lands, not a bug in this file.

import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeEnrollmentDeliveryInput,
  type BridgeEnrollmentHelloMessage,
  type BridgeClientLane,
  type BridgeEventMessage,
  type BridgeHelloMessage,
  type BridgeNegotiationMessage,
  type BridgeRequest,
  type BridgeResponse,
} from "@foundry-local-api/shared";

export type AcceptedBridgeEnrollment = Omit<
  BridgeEnrollmentDeliveryInput,
  "encryptedCredential"
> & { credential: string };
import {
  dispatch,
  listRegisteredCommands,
  registerCommand,
  unregisterCommand,
} from "./command-registry.js";
import {
  createBridgeDiagnostics,
  projectBridgeDiagnostics,
  transitionBridgeDiagnostics,
  type BridgeClientDiagnostics,
  type BridgeDiagnosticErrorCode,
} from "./bridge-diagnostics.js";
import {
  BridgeEventOutbox,
  MOVEMENT_EVENT_NAME,
  isBridgeEventAcknowledgement,
  type BridgeEventOutboxDiagnostics,
  type BridgeOutboxStorage,
} from "./bridge-client-outbox.js";

export const MODULE_ID = "foundry-local-api";
export const ALLOW_REMOTE_CONTROL_SETTING = "allowRemoteControl";
const CLIENT_ID_STORAGE_KEY = `${MODULE_ID}.clientId`;
const BROWSER_SESSION_ID_STORAGE_KEY = `${MODULE_ID}.browserSessionId`;
const IDENTITY_HANDOFF_STORAGE_KEY = `${MODULE_ID}.identityHandoff.v1`;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HANDOFF_PROOF_PATTERN = /^[A-Za-z0-9_-]{43}$/;
let memoryClientId: string | undefined;

export const BRIDGE_PORT = "3939";
export const BRIDGE_PATH = "/bridge";
const APPROVED_LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isApprovedLoopbackHostname(hostname: string): boolean {
  return APPROVED_LOOPBACK_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost");
}

export type ConnectionStatus = "disconnected" | "connecting" | "connected";

export interface BackoffOptions {
  /** Delay for the first reconnect attempt (attempt 0), before jitter. */
  baseDelayMs: number;
  /** Upper bound the exponential growth is capped at, before jitter. */
  maxDelayMs: number;
}

export const DEFAULT_BACKOFF_OPTIONS: BackoffOptions = {
  baseDelayMs: 500,
  maxDelayMs: 30_000,
};

/**
 * Pure exponential-backoff-with-jitter delay calculation, deliberately
 * extracted from {@link BridgeClient} so it can be unit-sanity-checked
 * without a real timer or socket.
 *
 * `attempt` is 0-based (0 = the first reconnect attempt after the initial
 * connection failure). Uses "full jitter": a uniformly random delay in
 * `[0, min(maxDelayMs, baseDelayMs * 2^attempt)]`, which avoids reconnect
 * storms while still capping the worst-case wait.
 */
export function computeBackoffDelayMs(
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF_OPTIONS,
): number {
  const { baseDelayMs, maxDelayMs } = options;
  const cappedExponential = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt));
  return Math.floor(Math.random() * cappedExponential);
}

/**
 * Registers the only user-facing bridge setting. GM session authentication
 * is automatic and player/TV enrollment remains controlled by this opt-in.
 */
export function registerBridgeSettings(onSettingChanged?: () => void): void {
  game.settings.register<boolean>(MODULE_ID, ALLOW_REMOTE_CONTROL_SETTING, {
    name: "Allow bounded remote control for this client",
    hint: "Lets the bridge route explicitly allowlisted commands to this signed-in user's client. GM clients are always available on the GM lane.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => onSettingChanged?.(),
  });
}

/**
 * Derives the bridge endpoint from the authenticated Foundry page so browser
 * cookie hostname rules remain aligned. Only literal loopback names and the
 * standards-reserved `.localhost` namespace are accepted; deceptive suffixes
 * and arbitrary caller-selected hosts fail closed.
 */
export function deriveBridgeUrl(pageLocation: Pick<Location, "hostname" | "protocol">): string {
  const hostname = pageLocation.hostname.toLowerCase();
  if (!isApprovedLoopbackHostname(hostname)) {
    throw new Error("Foundry page hostname is not an approved loopback host");
  }
  if (pageLocation.protocol !== "http:" && pageLocation.protocol !== "https:") {
    throw new Error("Foundry page protocol is not supported");
  }
  const websocketProtocol = pageLocation.protocol === "https:" ? "wss:" : "ws:";
  const urlHostname = hostname === "::1" ? "[::1]" : hostname;
  return `${websocketProtocol}//${urlHostname}:${BRIDGE_PORT}${BRIDGE_PATH}`;
}

export function getBridgeUrlForCurrentPage(): string {
  return deriveBridgeUrl(globalThis.location);
}

type ClientIdentityStorage = Pick<Storage, "getItem" | "setItem">;

function identityStorage(
  name: "localStorage" | "sessionStorage",
): ClientIdentityStorage | undefined {
  try {
    const storage = globalThis[name];
    return storage && typeof storage.getItem === "function" && typeof storage.setItem === "function"
      ? storage
      : undefined;
  } catch {
    return undefined;
  }
}

function readClientId(storage: ClientIdentityStorage | undefined): string | undefined {
  try {
    const value = storage?.getItem(CLIENT_ID_STORAGE_KEY) ?? undefined;
    return value && CLIENT_ID_PATTERN.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeClientId(storage: ClientIdentityStorage | undefined, clientId: string): boolean {
  if (!storage) return false;
  try {
    storage.setItem(CLIENT_ID_STORAGE_KEY, clientId);
    return storage.getItem(CLIENT_ID_STORAGE_KEY) === clientId;
  } catch {
    return false;
  }
}

function createClientId(excluded?: string): string {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = crypto.randomUUID();
    if (candidate !== excluded) return candidate;
  }
  throw new Error("Unable to generate a distinct bridge client identity");
}

function getBrowserSessionId(): string {
  const session = identityStorage("sessionStorage");
  try {
    const existing = session?.getItem(BROWSER_SESSION_ID_STORAGE_KEY) ?? undefined;
    if (existing && CLIENT_ID_PATTERN.test(existing)) return existing;
  } catch {
    // Generate an ephemeral session ID below.
  }
  const created = crypto.randomUUID();
  try {
    session?.setItem(BROWSER_SESSION_ID_STORAGE_KEY, created);
    if (session?.getItem(BROWSER_SESSION_ID_STORAGE_KEY) === created) return created;
  } catch {
    // Fail closed: a non-persistent value cannot authorize an adoption reconnect.
  }
  return created;
}

type IdentityHandoff = { clientId: string; proof: string };

function readIdentityHandoff(): IdentityHandoff | undefined {
  try {
    const raw = identityStorage("sessionStorage")?.getItem(IDENTITY_HANDOFF_STORAGE_KEY);
    if (!raw || raw.length > 512) return undefined;
    const value = JSON.parse(raw) as Partial<IdentityHandoff>;
    return typeof value.clientId === "string" &&
      CLIENT_ID_PATTERN.test(value.clientId) &&
      typeof value.proof === "string" &&
      HANDOFF_PROOF_PATTERN.test(value.proof)
      ? { clientId: value.clientId, proof: value.proof }
      : undefined;
  } catch {
    return undefined;
  }
}

export function stageIdentityHandoff(clientId: string, proof: string): void {
  if (!CLIENT_ID_PATTERN.test(clientId) || !HANDOFF_PROOF_PATTERN.test(proof)) {
    throw new Error("Invalid identity handoff proof");
  }
  const session = identityStorage("sessionStorage");
  if (!session) throw new Error("Session storage is unavailable for identity handoff");
  const serialized = JSON.stringify({ clientId, proof });
  session.setItem(IDENTITY_HANDOFF_STORAGE_KEY, serialized);
  if (session.getItem(IDENTITY_HANDOFF_STORAGE_KEY) !== serialized) {
    throw new Error("Unable to persist identity handoff proof");
  }
}

function clearIdentityHandoff(clientId: string): void {
  try {
    const session = globalThis.sessionStorage;
    if (readIdentityHandoff()?.clientId === clientId)
      session.removeItem(IDENTITY_HANDOFF_STORAGE_KEY);
  } catch {
    // The server-side proof is one-time even if browser cleanup fails.
  }
}

/**
 * Returns a browser-profile-stable, non-secret bridge identity. Existing
 * session-only identities are migrated once so an upgrade does not silently
 * break exact-client enrollment. Storage failures degrade to the tab and then
 * to memory, while every persisted write is verified before use.
 */
export function getClientId(): string {
  const persistent = identityStorage("localStorage");
  const session = identityStorage("sessionStorage");
  const existing = readClientId(persistent);
  if (existing) {
    memoryClientId = existing;
    writeClientId(session, existing);
    return existing;
  }
  const legacy = readClientId(session);
  if (legacy) {
    writeClientId(persistent, legacy);
    memoryClientId = legacy;
    return legacy;
  }
  if (memoryClientId) return memoryClientId;

  const created = createClientId();
  if (!writeClientId(persistent, created)) writeClientId(session, created);
  memoryClientId = created;
  return created;
}

/**
 * Rotates a persistent identity only when the caller still observes the
 * expected value. This compare-and-set guard prevents stale collision
 * remediation from overwriting an identity already rotated by another tab.
 * A live BridgeClient intentionally keeps its construction-time identity;
 * callers must reload after rotation and non-GM lanes must be re-enrolled.
 */
export function rotateClientId(expectedCurrentId: string): string {
  const current = getClientId();
  if (current !== expectedCurrentId) {
    throw new Error("Bridge client identity changed before rotation");
  }
  const rotated = createClientId(current);
  const persistent = identityStorage("localStorage");
  const persistedCurrent = readClientId(persistent);
  if (persistedCurrent && persistedCurrent !== expectedCurrentId) {
    throw new Error("Bridge client identity changed before rotation");
  }
  if (persistedCurrent && !writeClientId(persistent, rotated)) {
    throw new Error("Unable to persist rotated bridge client identity");
  }
  if (!persistedCurrent && !writeClientId(persistent, rotated)) {
    const session = identityStorage("sessionStorage");
    if (!writeClientId(session, rotated)) memoryClientId = rotated;
  } else {
    writeClientId(identityStorage("sessionStorage"), rotated);
  }
  memoryClientId = rotated;
  return rotated;
}

/** Adopts an operator-supplied UUID under the same compare-and-set guarantees as rotation. */
export function adoptClientId(expectedCurrentId: string, desiredClientId: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      desiredClientId,
    )
  ) {
    throw new Error("Desired bridge client identity is not a UUID");
  }
  const current = getClientId();
  const persistent = identityStorage("localStorage");
  if (current !== expectedCurrentId || readClientId(persistent) !== expectedCurrentId) {
    throw new Error("Bridge client identity changed before adoption");
  }
  if (!writeClientId(persistent, desiredClientId)) {
    throw new Error("Unable to persist adopted bridge client identity");
  }
  writeClientId(identityStorage("sessionStorage"), desiredClientId);
  memoryClientId = desiredClientId;
  return desiredClientId;
}

export function getClientLane(): BridgeClientLane {
  if (game.user.isGM) return game.user.name.toLowerCase() === "tv" ? "tv" : "gm";
  return game.user.name.toLowerCase() === "tv" ? "tv" : "player";
}

/** Produces the authenticated client's negotiation message without secrets or device telemetry. */
export function buildBridgeHello(laneOverride?: BridgeClientLane): BridgeHelloMessage {
  const moduleVersion = game.modules.get(MODULE_ID)?.version ?? "unknown";
  const lane = laneOverride ?? getClientLane();
  const clientId = getClientId();
  const handoff = readIdentityHandoff();
  return {
    kind: "hello",
    browserSessionId: getBrowserSessionId(),
    ...(handoff?.clientId === clientId ? { identityHandoffProof: handoff.proof } : {}),
    ...(lane === "gm"
      ? {
          worldId: game.world.id,
        }
      : {}),
    identity: {
      clientId,
      userId: game.user.id,
      userName: game.user.name,
      // This field describes bridge authority, not the Foundry role alone.
      // A Foundry GM deliberately assigned to the bounded TV lane must not
      // authenticate, reconnect, or advertise itself as the GM bridge lane.
      isGM: lane === "gm",
      lane,
      optedIn: lane === "gm" || game.settings.get<boolean>(MODULE_ID, ALLOW_REMOTE_CONTROL_SETTING),
    },
    versions: {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      foundryVersion: game.release.version,
      systemId: game.system.id,
      systemVersion: game.system.version,
      moduleVersion,
      transport: "websocket",
    },
    capabilities: listRegisteredCommands().sort(),
  };
}

/**
 * Manages a single reconnecting WebSocket connection to the bridge server,
 * dispatching every inbound {@link BridgeRequest} through the module's
 * command registry and sending the resulting {@link BridgeResponse} back.
 */
export class BridgeClient {
  private readonly extensionMessages = new Set<(message: unknown) => boolean>();
  private readonly extensionStatuses = new Set<(status: ConnectionStatus) => void>();
  private readonly extensionPumps = new Set<() => void>();
  private readonly userId: string;
  private socket: WebSocket | null = null;
  private status: ConnectionStatus = "disconnected";
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manuallyClosed = false;
  private enrollment: AcceptedBridgeEnrollment | null = null;
  private diagnostics: BridgeClientDiagnostics;
  private readonly clientId: string;
  private readonly fixedLane: BridgeClientLane;
  private readonly eventOutbox: BridgeEventOutbox;
  private outboxTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Bumped by every `openSocket()` call; each socket's listeners close over
   * the generation they were opened with and no-op if it's stale. This is
   * what lets `reconnect()` discard an in-flight socket without its
   * eventual "close" event racing the brand-new socket it's being replaced
   * by (see `reconnect()`).
   */
  private generation = 0;
  constructor(
    private readonly getUrl: () => string,
    private readonly backoffOptions: BackoffOptions = DEFAULT_BACKOFF_OPTIONS,
  ) {
    this.clientId = getClientId();
    this.fixedLane = getClientLane();
    this.diagnostics = createBridgeDiagnostics({
      moduleVersion: game.modules.get(MODULE_ID)?.version ?? "unknown",
      userId: game.user.id,
      intendedLane: this.fixedLane,
      consentGranted:
        this.fixedLane === "gm" ||
        game.settings.get<boolean>(MODULE_ID, ALLOW_REMOTE_CONTROL_SETTING),
    });
    this.userId = game.user.id;
    const outboxStorage = safeLocalStorage();
    this.eventOutbox = new BridgeEventOutbox(
      { clientId: this.clientId, userId: game.user.id, lane: this.fixedLane },
      {
        ...(outboxStorage ? { storage: outboxStorage } : {}),
        storageKey: `${MODULE_ID}.movementOutbox.${game.user.id}.${this.clientId}`,
      },
    );
  }

  /** The explicit extension API exposes authority and transport, never domain settings. */
  extensionApi(): BrowserBridgeApi {
    const listen = <T>(set: Set<T>, listener: T) => {
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    };
    return Object.freeze({
      version: 1 as const,
      identity: () => ({
        clientId: this.clientId,
        userId: this.userId,
        lane: this.fixedLane,
        connected: this.status === "connected" && game.user.id === this.userId,
      }),
      registerDocumentGuard,
      registerCommand: (type, handler) => {
        if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(type) || listRegisteredCommands().includes(type))
          throw new Error("Extension command is invalid or duplicated.");
        registerCommand(type, handler);
        return () => {
          unregisterCommand(type);
        };
      },
      sendEvent: (name, payload) => this.sendEvent(name, payload),
      sendPrivate: (payload) => {
        const socket = this.socket;
        const url = socket ? new URL(socket.url) : undefined;
        const kind =
          payload && typeof payload === "object" ? (payload as { kind?: unknown }).kind : undefined;
        if (
          this.fixedLane !== "gm" ||
          game.user.id !== this.userId ||
          !game.user.isGM ||
          game.user.name.toLowerCase() === "tv" ||
          this.status !== "connected" ||
          !socket ||
          socket.readyState !== WebSocket.OPEN ||
          !url ||
          !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
          !["ws:", "wss:"].includes(url.protocol) ||
          url.port !== "3939" ||
          url.pathname !== "/bridge" ||
          url.search ||
          url.hash ||
          url.username ||
          url.password ||
          typeof kind !== "string" ||
          !/^[A-Za-z0-9_.:-]{1,128}$/.test(kind)
        )
          throw new Error("Private local transport unavailable.");
        const serialized = JSON.stringify({ kind: "extension-private", channel: kind, payload });
        if (new TextEncoder().encode(serialized).byteLength > 16384)
          throw new Error("Private local message exceeds its bound.");
        socket.send(serialized);
      },
      onMessage: (listener) => listen(this.extensionMessages, listener),
      onStatus: (listener) => listen(this.extensionStatuses, listener),
      onPump: (listener) => listen(this.extensionPumps, listener),
    } satisfies BrowserBridgeApi);
  }

  /** Current connection status, programmatically queryable. */
  getStatus(): ConnectionStatus {
    return this.status;
  }

  getDiagnostics(): BridgeClientDiagnostics {
    return projectBridgeDiagnostics(this.diagnostics);
  }

  getOutboxDiagnostics(): BridgeEventOutboxDiagnostics {
    return this.eventOutbox.diagnostics();
  }

  /** Applies live client-setting changes to diagnostics before reconnecting. */
  handleSettingsChanged(): void {
    this.diagnostics = transitionBridgeDiagnostics(this.diagnostics, {
      type: "consent-changed",
      granted:
        this.fixedLane === "gm" ||
        game.settings.get<boolean>(MODULE_ID, ALLOW_REMOTE_CONTROL_SETTING),
    });
    this.reconnect();
  }

  /** Accepts a GM-targeted one-time offer in memory. It is never persisted to settings/storage. */
  acceptEnrollment(delivery: AcceptedBridgeEnrollment): void {
    if (
      delivery.targetUserId !== game.user.id ||
      delivery.expectedClientId !== this.clientId ||
      delivery.expectedLane !== this.fixedLane
    ) {
      throw new Error("Enrollment identity does not match this client");
    }
    this.enrollment = { ...delivery };
    this.diagnostics = {
      ...this.diagnostics,
      intendedLane: this.fixedLane,
      consentGranted: game.settings.get<boolean>(MODULE_ID, ALLOW_REMOTE_CONTROL_SETTING),
    };
    this.reconnect();
  }

  /** Opens the connection (and lets the reconnect loop keep it open). */
  connect(): void {
    this.manuallyClosed = false;
    if (this.fixedLane !== "gm" && this.enrollment === null) {
      this.diagnostics = transitionBridgeDiagnostics(this.diagnostics, {
        type: "negotiation-rejected",
        at: new Date().toISOString(),
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        moduleVersion: game.modules.get(MODULE_ID)?.version ?? "unknown",
        errorCode: "enrollment-required",
      });
      return;
    }
    this.openSocket();
  }

  /** Closes the connection and stops any pending reconnect attempt. */
  disconnect(): void {
    this.manuallyClosed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopOutboxPump();
    this.socket?.close();
  }

  /**
   * Discards any current/in-flight connection and immediately opens a new
   * one using the latest derived page URL, resetting the
   * reconnect backoff. For when the player/TV opt-in setting changes
   * while the module is already connected — see
   * `registerBridgeSettings()`'s `onSettingChanged`.
   */
  reconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
    this.manuallyClosed = false;
    this.socket?.close();
    this.openSocket();
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) {
      return;
    }
    this.status = status;
    for (const listener of this.extensionStatuses) {
      try {
        listener(status);
      } catch {
        /* No extension payload in logs. */
      }
    }
    console.log(`[${MODULE_ID}] bridge connection status: ${status}`);
  }

  private openSocket(): void {
    if (this.fixedLane !== "gm" && this.enrollment === null) return;
    const administrative = this.fixedLane === "gm";
    const url = this.getUrl();
    this.diagnostics = transitionBridgeDiagnostics(this.diagnostics, {
      type: "connection-attempted",
      at: new Date().toISOString(),
      reconnectAttempt: this.reconnectAttempt,
    });
    this.setStatus("connecting");
    // Captured per-socket so a superseded socket's later events (its "close"
    // above all) are recognizable as stale and ignored — see `generation`'s
    // own doc comment and `reconnect()`.
    const generation = ++this.generation;

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      console.error(`[${MODULE_ID}] failed to open bridge socket`);
      this.setStatus("disconnected");
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (generation !== this.generation) return;
      this.reconnectAttempt = 0;
      const enrollment = this.enrollment;
      if (administrative) {
        socket.send(JSON.stringify(buildBridgeHello("gm")));
      } else if (enrollment) {
        const message: BridgeEnrollmentHelloMessage = {
          kind: "enrollment",
          credential: enrollment.credential,
          hello: buildBridgeHello(enrollment.expectedLane),
        };
        this.enrollment = null;
        socket.send(JSON.stringify(message));
      } else {
        socket.close(1008, "Enrollment required");
      }
    });

    socket.addEventListener("message", (event: MessageEvent) => {
      if (generation !== this.generation) return;
      void this.handleMessage(event);
    });

    socket.addEventListener("close", () => {
      if (generation !== this.generation) return;
      this.socket = null;
      this.stopOutboxPump();
      this.setStatus("disconnected");
      if (!this.manuallyClosed && administrative) {
        this.scheduleReconnect();
      } else if (!administrative) {
        this.diagnostics = transitionBridgeDiagnostics(this.diagnostics, {
          type: "disconnected",
          errorCode: null,
        });
      }
    });

    socket.addEventListener("error", () => {
      if (generation !== this.generation) return;
      // The "close" event that follows drives status change + reconnect
      // scheduling; this just gets the failure into the console.
      console.error(`[${MODULE_ID}] bridge socket error`);
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) {
      return;
    }
    const delay = computeBackoffDelayMs(this.reconnectAttempt, this.backoffOptions);
    this.reconnectAttempt += 1;
    this.diagnostics = transitionBridgeDiagnostics(this.diagnostics, {
      type: "reconnect-scheduled",
      attempt: this.reconnectAttempt,
      nextAttemptAt: new Date(Date.now() + delay).toISOString(),
    });
    console.log(`[${MODULE_ID}] reconnecting to bridge in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private async handleMessage(event: MessageEvent): Promise<void> {
    const raw = typeof event.data === "string" ? event.data : null;
    if (raw === null) {
      console.error(`[${MODULE_ID}] ignoring non-text bridge message`);
      return;
    }

    let parsed: BridgeRequest | BridgeNegotiationMessage;
    try {
      parsed = JSON.parse(raw) as BridgeRequest | BridgeNegotiationMessage;
    } catch {
      console.error(`[${MODULE_ID}] failed to parse bridge message as JSON`);
      return;
    }

    if (isBridgeNegotiationMessage(parsed)) {
      if (parsed.accepted) {
        clearIdentityHandoff(getClientId());
        this.setStatus("connected");
        this.diagnostics = transitionBridgeDiagnostics(this.diagnostics, {
          type: "negotiation-accepted",
          at: parsed.at,
          protocolVersion: parsed.protocolVersion,
          moduleVersion: parsed.moduleVersion,
        });
        this.startOutboxPump();
      } else {
        this.diagnostics = transitionBridgeDiagnostics(this.diagnostics, {
          type: "negotiation-rejected",
          at: parsed.at,
          protocolVersion: parsed.protocolVersion,
          moduleVersion: parsed.moduleVersion,
          errorCode: diagnosticCode(parsed.errorCode),
        });
      }
      return;
    }

    for (const listener of this.extensionMessages) {
      try {
        if (listener(parsed)) return;
      } catch {
        return;
      }
    }

    if (isBridgeEventAcknowledgement(parsed)) {
      this.eventOutbox.acknowledge(parsed);
      return;
    }

    const started = performance.now();
    const spans: { stage: string; durationMs: number }[] = [];
    const response: BridgeResponse = await dispatch(parsed, {
      record: (stage, durationMs) => {
        if (
          spans.length < 32 &&
          /^[a-z0-9:_-]{1,80}$/i.test(stage) &&
          Number.isFinite(durationMs) &&
          durationMs >= 0
        )
          spans.push({ stage, durationMs });
      },
    });
    const ended = performance.now();
    if (
      typeof parsed.traceId === "string" &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(parsed.traceId)
    ) {
      const clock = globalThis as typeof globalThis & { __foundryLatencyClockId?: string };
      clock.__foundryLatencyClockId ??= crypto.randomUUID();
      response.latency = {
        traceId: parsed.traceId,
        nativeExecutionMs: ended - started,
        nativeStartMs: started,
        nativeEndMs: ended,
        clockId: clock.__foundryLatencyClockId,
        spans,
        instrumentationBuild: LATENCY_BUILD,
      };
    }
    this.send(response);
  }

  private send(response: BridgeResponse): void {
    if (this.socket !== null && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(response));
    }
  }

  /**
   * Sends an unsolicited `{kind: "event"}` message to the server (Phase 26)
   * — the bridge's first push-not-reply shape (shared/src/protocol.ts's
   * `BridgeEventMessage`), used by hook-forwarding (module/src/hooks.ts)
   * rather than the request/response `dispatch()` path. Public sibling of
   * the private `send()` above (which only ever sends replies to inbound
   * requests); mirrors its readyState-check idiom.
   */
  sendEvent(event: string, payload: unknown): void {
    if (event === MOVEMENT_EVENT_NAME) {
      this.eventOutbox.enqueue(event, payload);
      this.flushOutbox();
    } else if (this.socket !== null && this.socket.readyState === WebSocket.OPEN) {
      const message: BridgeEventMessage = { kind: "event", event, payload };
      this.socket.send(JSON.stringify(message));
    }
  }

  private startOutboxPump(): void {
    this.stopOutboxPump();
    this.flushOutbox();
    this.outboxTimer = setInterval(() => this.flushOutbox(), 1_000);
  }

  private stopOutboxPump(): void {
    if (this.outboxTimer !== null) {
      clearInterval(this.outboxTimer);
      this.outboxTimer = null;
    }
  }

  private flushOutbox(): void {
    if (
      this.status !== "connected" ||
      this.socket === null ||
      this.socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    for (const listener of this.extensionPumps) {
      try {
        listener();
      } catch {
        /* Extension owns retry state. */
      }
    }
    for (const record of this.eventOutbox.ready()) {
      const message = this.eventOutbox.markAttempt(record.deliveryId);
      if (message) this.socket.send(JSON.stringify(message));
    }
  }
}

function safeLocalStorage(): BridgeOutboxStorage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function diagnosticCode(code: BridgeNegotiationMessage["errorCode"]): BridgeDiagnosticErrorCode {
  switch (code) {
    case "CONSENT_REQUIRED":
      return "consent-required";
    case "ENROLLMENT_EXPIRED":
      return "enrollment-expired";
    case "ENROLLMENT_REPLAYED":
      return "enrollment-replayed";
    case "ENROLLMENT_USER_MISMATCH":
      return "enrollment-wrong-user";
    case "ENROLLMENT_LANE_MISMATCH":
      return "enrollment-wrong-lane";
    case "ENROLLMENT_CLIENT_MISMATCH":
      return "enrollment-wrong-client";
    case "ENROLLMENT_PATH_MISMATCH":
      return "enrollment-wrong-path";
    case "ENROLLMENT_INVALID":
      return "enrollment-invalid";
    case "ENROLLMENT_REVOKED":
    case "SERVER_RESTARTED":
      return "enrollment-revoked";
    case "ENROLLMENT_PROTOCOL_MISMATCH":
      return "protocol-version-mismatch";
    case "ENROLLMENT_MODULE_MISMATCH":
      return "module-version-mismatch";
    case "DUPLICATE_CLIENT":
      return "duplicate-client";
    case null:
    default:
      return "negotiation-rejected";
  }
}

function isBridgeNegotiationMessage(value: unknown): value is BridgeNegotiationMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "negotiation" &&
    typeof (value as { accepted?: unknown }).accepted === "boolean"
  );
}
