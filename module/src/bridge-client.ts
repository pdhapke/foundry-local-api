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
import { dispatch, listRegisteredCommands } from "./command-registry.js";
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
export const BRIDGE_URL_SETTING = "bridgeUrl";
export const BRIDGE_API_KEY_SETTING = "bridgeApiKey";
export const ALLOW_REMOTE_CONTROL_SETTING = "allowRemoteControl";
const CLIENT_ID_STORAGE_KEY = `${MODULE_ID}.clientId`;

/** Matches the server's Phase 1 default port (`server/src/config.ts`). */
export const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:3939/bridge";

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
 * Registers the client-scope module settings that hold the bridge URL and
 * API key. `onSettingChanged`, when given, fires whenever either setting is
 * saved from the config form — wired by `index.ts` to the live
 * `BridgeClient`'s `reconnect()` so correcting a bad URL/API key takes
 * effect immediately instead of silently doing nothing until the next full
 * page reload (the client only ever read these settings once, at
 * construction time).
 */
export function registerBridgeSettings(onSettingChanged?: () => void): void {
  game.settings.register<string>(MODULE_ID, BRIDGE_URL_SETTING, {
    name: "Bridge Server URL",
    hint: "WebSocket URL of the local foundry-local-api server this module connects to.",
    scope: "client",
    config: true,
    type: String,
    default: DEFAULT_BRIDGE_URL,
    onChange: () => onSettingChanged?.(),
  });

  game.settings.register<string>(MODULE_ID, BRIDGE_API_KEY_SETTING, {
    name: "Bridge Administrative API Key (GM only)",
    hint: "Administrative bridge credential. It is never used by player or TV clients.",
    scope: "client",
    // `game.user` is deliberately null during Foundry 14's `init` hook. Keep
    // this security-sensitive setting hidden while settings are registered;
    // `configureBridgeAdminSettingVisibility()` reveals it only after the
    // authenticated user exists at `ready`, and only for a GM.
    config: false,
    type: String,
    default: "",
    onChange: () => onSettingChanged?.(),
  });

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

/** Reveals the administrative credential setting only to the authenticated GM. */
export function configureBridgeAdminSettingVisibility(): void {
  const setting = game.settings.settings.get(`${MODULE_ID}.${BRIDGE_API_KEY_SETTING}`);
  if (!setting) throw new Error(`Bridge setting "${BRIDGE_API_KEY_SETTING}" is not registered.`);
  setting.config = getClientLane() === "gm";
}

/** Reads the currently configured bridge URL from the module setting. */
export function getConfiguredBridgeUrl(): string {
  return game.settings.get<string>(MODULE_ID, BRIDGE_URL_SETTING);
}

/** Reads the currently configured bridge API key from the module setting. */
export function getConfiguredApiKey(): string {
  return getClientLane() === "gm"
    ? game.settings.get<string>(MODULE_ID, BRIDGE_API_KEY_SETTING)
    : "";
}

/** Removes a legacy administrative key from every bounded lane and verifies the readback. */
export async function clearLegacyNonGmApiKey(): Promise<boolean> {
  if (getClientLane() === "gm") return true;
  if (game.settings.get<string>(MODULE_ID, BRIDGE_API_KEY_SETTING) !== "") {
    await game.settings.set(MODULE_ID, BRIDGE_API_KEY_SETTING, "");
  }
  return game.settings.get<string>(MODULE_ID, BRIDGE_API_KEY_SETTING) === "";
}

export function getClientId(): string {
  const existing = sessionStorage.getItem(CLIENT_ID_STORAGE_KEY);
  if (existing) return existing;
  const created = crypto.randomUUID();
  sessionStorage.setItem(CLIENT_ID_STORAGE_KEY, created);
  return created;
}

export function getClientLane(): BridgeClientLane {
  if (game.user.isGM) return game.user.name.toLowerCase() === "tv" ? "tv" : "gm";
  return game.user.name.toLowerCase() === "tv" ? "tv" : "player";
}

/** Produces the authenticated client's negotiation message without secrets or device telemetry. */
export function buildBridgeHello(laneOverride?: BridgeClientLane): BridgeHelloMessage {
  const moduleVersion = game.modules.get(MODULE_ID)?.version ?? "unknown";
  const lane = laneOverride ?? getClientLane();
  return {
    kind: "hello",
    identity: {
      clientId: getClientId(),
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
 * Appends `?apiKey=<value>` (URL-encoded, via `URLSearchParams`) to
 * `baseUrl`. Extracted as a pure function so it's sanity-checkable without a
 * real socket, same pattern as {@link computeBackoffDelayMs} above.
 */
export function buildBridgeConnectionUrl(baseUrl: string, apiKey: string): string {
  const url = new URL(baseUrl);
  if (apiKey !== "") {
    url.searchParams.set("apiKey", apiKey);
  }
  return url.toString();
}

/**
 * Manages a single reconnecting WebSocket connection to the bridge server,
 * dispatching every inbound {@link BridgeRequest} through the module's
 * command registry and sending the resulting {@link BridgeResponse} back.
 */
export class BridgeClient {
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
    private readonly getApiKey: () => string,
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
    const outboxStorage = safeLocalStorage();
    this.eventOutbox = new BridgeEventOutbox(
      { clientId: this.clientId, userId: game.user.id, lane: this.fixedLane },
      {
        ...(outboxStorage ? { storage: outboxStorage } : {}),
        storageKey: `${MODULE_ID}.movementOutbox.${game.user.id}.${this.clientId}`,
      },
    );
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
   * one using the latest `getUrl()`/`getApiKey()` values, resetting the
   * reconnect backoff. For when the bridge URL or API key setting changes
   * while the module is already connected (or stuck retrying with a stale
   * key) — see `registerBridgeSettings()`'s `onSettingChanged`.
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
    console.log(`[${MODULE_ID}] bridge connection status: ${status}`);
  }

  private openSocket(): void {
    if (this.fixedLane !== "gm" && this.enrollment === null) return;
    const administrative = this.fixedLane === "gm";
    const url = buildBridgeConnectionUrl(this.getUrl(), administrative ? this.getApiKey() : "");
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
    } catch (err) {
      console.error(`[${MODULE_ID}] failed to parse bridge message as JSON`, err);
      return;
    }

    if (isBridgeNegotiationMessage(parsed)) {
      if (parsed.accepted) {
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

    if (isBridgeEventAcknowledgement(parsed)) {
      this.eventOutbox.acknowledge(parsed);
      return;
    }

    const response: BridgeResponse = await dispatch(parsed);
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
