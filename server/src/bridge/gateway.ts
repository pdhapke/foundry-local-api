// Server-side WebSocket gateway for the Foundry module bridge (Phase 3).
//
// Mounted on the *existing* http.Server at path `/bridge` — this is
// deliberately not a second listening port, so the whole server process
// still binds exactly one TCP port (see server/src/config.ts HOST/PORT
// validation).
//
// Track 0 replaces the historical "newest socket wins" behavior with a
// negotiated registry. Every socket must send a BridgeHelloMessage before it
// can receive commands. Ordinary calls use the stable GM lane; bounded
// effective-user operations explicitly select an opted-in player/TV client.
import type { IncomingMessage, Server as HttpServer } from "node:http";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeEnrollmentErrorCode,
  type BridgeEnrollmentHelloMessage,
  type BridgeEventAcknowledgement,
  type BridgeClientLane,
  type BridgeHelloMessage,
  type BridgeNegotiationMessage,
  type ConnectedBridgeClient,
} from "@foundry-local-api/shared";

import { timingSafeEqualStrings } from "../security/api-key.js";
import { EnrollmentStore, type EnrollmentRejectionCode } from "./enrollment-store.js";

export type BridgeMessageListener = (clientId: string, raw: string) => void;
export type BridgeConnectionLostListener = (client: ConnectedBridgeClient) => void;
/**
 * Fired whenever a negotiated client is added (initial connect or reconnect
 * of the same stable client identity). This is what Phase 32's integration detection
 * (server/src/integrations/manager.ts's `IntegrationManager.refresh()`)
 * hooks into: the connected module is the only source of truth for which
 * game system/modules are active, so detection needs to re-run every time a
 * (re)connection happens, not just once at server startup.
 */
export type BridgeConnectionEstablishedListener = (client: ConnectedBridgeClient) => void;

export interface BridgeClientSelector {
  clientId?: string;
  userId?: string;
  lane?: BridgeClientLane;
}

interface RegisteredConnection {
  socket: WebSocket;
  client: ConnectedBridgeClient;
}

export interface BridgeGatewayOptions {
  /**
   * Static API key (Phase 4) required to open a `/bridge` connection.
   * Browser `WebSocket` can't set custom handshake headers, so this is
   * checked as a `?apiKey=` query-string param on the upgrade request
   * instead of a header — same static key as the REST `/api/*` auth
   * (server/src/middleware/auth.ts), same timing-safe comparison.
   */
  apiKey: string;
  enrollmentStore?: EnrollmentStore;
  negotiationTimeoutMs?: number;
}

export class BridgeGateway {
  private readonly wss: WebSocketServer;
  private readonly apiKey: string;
  private readonly enrollmentStore: EnrollmentStore;
  private readonly negotiationTimeoutMs: number;
  private readonly clients = new Map<string, RegisteredConnection>();
  private readonly socketClientIds = new Map<WebSocket, string>();
  private readonly messageListeners = new Set<BridgeMessageListener>();
  private readonly connectionLostListeners = new Set<BridgeConnectionLostListener>();
  private readonly connectionEstablishedListeners = new Set<BridgeConnectionEstablishedListener>();

  constructor(httpServer: HttpServer, options: BridgeGatewayOptions) {
    this.apiKey = options.apiKey;
    this.enrollmentStore = options.enrollmentStore ?? new EnrollmentStore();
    this.negotiationTimeoutMs = options.negotiationTimeoutMs ?? 5_000;
    this.wss = new WebSocketServer({
      server: httpServer,
      path: "/bridge",
      verifyClient: (info: { req: IncomingMessage }, callback) => {
        if (this.isUpgradeAllowed(info.req)) {
          callback(true);
          return;
        }
        console.warn("[bridge] rejected connection attempt: invalid administrative authentication");
        callback(false, 401, "Unauthorized");
      },
    });
    this.wss.on("connection", (socket: WebSocket, req: IncomingMessage) =>
      this.handleConnection(socket, this.hasValidApiKey(req)),
    );
  }

  /** Checks the `?apiKey=` query param on an upgrade request's URL against the configured key. */
  private hasValidApiKey(req: IncomingMessage): boolean {
    const url = new URL(req.url ?? "", "http://localhost");
    const provided = url.searchParams.get("apiKey");
    return (
      provided !== null && provided.length > 0 && timingSafeEqualStrings(provided, this.apiKey)
    );
  }

  private isUpgradeAllowed(req: IncomingMessage): boolean {
    const url = new URL(req.url ?? "", "http://localhost");
    return !url.searchParams.has("apiKey") || this.hasValidApiKey(req);
  }

  /** Whether a matching opted-in client is connected and able to receive messages. */
  isConnected(selector?: BridgeClientSelector): boolean {
    return this.resolveConnection(selector) !== null;
  }

  /** Sends a raw message to the selected lane/client. Default is the stable GM lane. */
  send(raw: string, selector?: BridgeClientSelector): boolean {
    const connection = this.resolveConnection(selector);
    if (!connection) return false;
    if (connection.client.lane !== "gm") {
      const command = bridgeRequestType(raw);
      if (!command || !this.enrollmentStore.isCommandAllowed(connection.client.clientId, command)) {
        return false;
      }
    }
    connection.socket.send(raw);
    return true;
  }

  /** Sends only the fixed event-ack control shape, including to an enrolled non-GM lane. */
  acknowledgeEvent(deliveryId: string, clientId: string): boolean {
    const connection = this.resolveConnection({ clientId });
    if (!connection || deliveryId.length === 0 || deliveryId.length > 512) return false;
    const acknowledgement: BridgeEventAcknowledgement = {
      kind: "event-ack",
      deliveryId,
      accepted: true,
      clientId,
    };
    connection.socket.send(JSON.stringify(acknowledgement));
    return true;
  }

  /** Returns the selected client's negotiated identity, or null. */
  getClient(selector?: BridgeClientSelector): ConnectedBridgeClient | null {
    return this.resolveConnection(selector)?.client ?? null;
  }

  /** Safe snapshot used by capability reporting; contains no credentials/device details. */
  listClients(): ConnectedBridgeClient[] {
    return [...this.clients.values()]
      .filter(
        ({ socket, client }) =>
          socket.readyState === WebSocket.OPEN && this.isClientCurrentlyAuthorized(client),
      )
      .map(({ client }) => ({ ...client, capabilities: [...client.capabilities] }))
      .sort((a, b) => a.connectedAt - b.connectedAt || a.clientId.localeCompare(b.clientId));
  }

  /** Registers a listener invoked with the raw text of every inbound message from the active connection. */
  onMessage(listener: BridgeMessageListener): void {
    this.messageListeners.add(listener);
  }

  /** Registers a listener invoked whenever the active connection is lost (closed or replaced). */
  onConnectionLost(listener: BridgeConnectionLostListener): void {
    this.connectionLostListeners.add(listener);
  }

  /** Registers a listener invoked whenever a new connection becomes the active one. See `BridgeConnectionEstablishedListener`'s doc comment above. */
  onConnectionEstablished(listener: BridgeConnectionEstablishedListener): void {
    this.connectionEstablishedListeners.add(listener);
  }

  /** Closes any active connection and stops the underlying WebSocketServer. Part of graceful shutdown. */
  async close(): Promise<void> {
    for (const client of this.wss.clients) {
      client.terminate();
    }
    this.clients.clear();
    this.socketClientIds.clear();

    await new Promise<void>((resolve, reject) => {
      this.wss.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  private handleConnection(socket: WebSocket, administrative: boolean): void {
    const negotiationTimer = setTimeout(() => {
      if (!this.socketClientIds.has(socket)) socket.close(1008, "Negotiation timeout");
    }, this.negotiationTimeoutMs);
    negotiationTimer.unref?.();
    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        console.warn("[bridge] ignoring unexpected binary message");
        return;
      }
      const raw = data.toString();
      const clientId = this.socketClientIds.get(socket);
      if (!clientId) {
        if (administrative) this.acceptAdministrativeHello(socket, raw);
        else this.acceptEnrollmentHello(socket, raw);
        return;
      }
      const registered = this.clients.get(clientId);
      if (!registered || registered.socket !== socket) {
        socket.close(1008, "Client socket has been superseded");
        return;
      }
      if (!this.isClientCurrentlyAuthorized(registered.client)) {
        socket.close(1008, "Enrollment authorization is no longer active");
        return;
      }
      if (registered) registered.client.lastSeenAt = Date.now();
      const bridgeEvent = isBridgeEvent(raw);
      const durableEvent = parseBoundDurableMovementEvent(raw, registered.client);
      if (bridgeEvent && hasBridgeEventDelivery(raw) && !durableEvent) return;
      if (bridgeEvent && registered.client.lane !== "gm" && !durableEvent) return;
      for (const listener of this.messageListeners) {
        listener(clientId, raw);
      }
    });

    socket.on("close", () => {
      clearTimeout(negotiationTimer);
      const clientId = this.socketClientIds.get(socket);
      if (!clientId) return;
      this.socketClientIds.delete(socket);
      const registered = this.clients.get(clientId);
      if (!registered || registered.socket !== socket) return;
      this.clients.delete(clientId);
      if (registered.client.lane !== "gm") this.enrollmentStore.invalidateClient(clientId);
      this.notifyConnectionLost(registered.client);
    });

    socket.on("error", () => {
      console.error("[bridge] socket error");
    });
  }

  private acceptAdministrativeHello(socket: WebSocket, raw: string): void {
    let hello: BridgeHelloMessage;
    try {
      hello = JSON.parse(raw) as BridgeHelloMessage;
    } catch {
      socket.close(1002, "Bridge hello required");
      return;
    }
    if (
      !isBridgeHello(hello) ||
      hello.versions.protocolVersion !== BRIDGE_PROTOCOL_VERSION ||
      !hello.identity.isGM ||
      hello.identity.lane !== "gm"
    ) {
      this.rejectNegotiation(socket, "ENROLLMENT_PROTOCOL_MISMATCH");
      return;
    }
    this.registerClient(socket, hello);
  }

  private acceptEnrollmentHello(socket: WebSocket, raw: string): void {
    let message: BridgeEnrollmentHelloMessage;
    try {
      message = JSON.parse(raw) as BridgeEnrollmentHelloMessage;
    } catch {
      this.rejectNegotiation(socket, "ENROLLMENT_INVALID");
      return;
    }
    if (!isEnrollmentHello(message)) {
      this.rejectNegotiation(socket, "ENROLLMENT_INVALID");
      return;
    }
    const { hello } = message;
    const redeemed = this.enrollmentStore.redeem({
      credential: message.credential,
      userId: hello.identity.userId,
      lane: hello.identity.lane,
      protocolVersion: hello.versions.protocolVersion,
      moduleVersion: hello.versions.moduleVersion,
      path: "/bridge",
      clientId: hello.identity.clientId,
      consent: hello.identity.optedIn,
    });
    if (!redeemed.ok) {
      this.rejectNegotiation(socket, mapEnrollmentRejection(redeemed.code));
      return;
    }
    this.registerClient(socket, hello, redeemed.authorization.allowedCommands);
  }

  private registerClient(
    socket: WebSocket,
    hello: BridgeHelloMessage,
    allowedCommands?: readonly string[],
  ): void {
    const now = Date.now();
    const client: ConnectedBridgeClient = {
      ...hello.identity,
      ...hello.versions,
      capabilities: [
        ...new Set(
          allowedCommands
            ? hello.capabilities.filter((capability) => allowedCommands.includes(capability))
            : hello.capabilities,
        ),
      ].sort(),
      connectedAt: now,
      lastSeenAt: now,
    };
    const stale = this.clients.get(client.clientId);
    this.clients.set(client.clientId, { socket, client });
    this.socketClientIds.set(socket, client.clientId);
    if (stale && stale.socket !== socket) {
      stale.socket.close(1008, "Client identity replaced");
    }
    this.sendNegotiation(socket, true, null);
    this.notifyConnectionEstablished(client);
  }

  private rejectNegotiation(socket: WebSocket, errorCode: BridgeEnrollmentErrorCode): void {
    this.sendNegotiation(socket, false, errorCode);
    socket.close(1008, "Bridge negotiation rejected");
  }

  private sendNegotiation(
    socket: WebSocket,
    accepted: boolean,
    errorCode: BridgeEnrollmentErrorCode | null,
  ): void {
    const message: BridgeNegotiationMessage = {
      kind: "negotiation",
      accepted,
      at: new Date().toISOString(),
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      moduleVersion: "0.1.0",
      errorCode,
    };
    socket.send(JSON.stringify(message));
  }

  private resolveConnection(selector?: BridgeClientSelector): RegisteredConnection | null {
    const candidates = [...this.clients.values()].filter(
      ({ socket, client }) =>
        socket.readyState === WebSocket.OPEN &&
        client.optedIn &&
        this.isClientCurrentlyAuthorized(client),
    );
    const matching = candidates.filter(({ client }) => {
      if (selector?.clientId && client.clientId !== selector.clientId) return false;
      if (selector?.userId && client.userId !== selector.userId) return false;
      const lane = selector?.lane ?? (selector?.userId || selector?.clientId ? undefined : "gm");
      return lane ? client.lane === lane : true;
    });
    matching.sort(
      (a, b) =>
        a.client.connectedAt - b.client.connectedAt ||
        a.client.clientId.localeCompare(b.client.clientId),
    );
    return matching[0] ?? null;
  }

  private isClientCurrentlyAuthorized(client: ConnectedBridgeClient): boolean {
    return (
      client.lane === "gm" ||
      this.enrollmentStore.isClientAuthorized(client.clientId, client.userId, client.lane)
    );
  }

  private notifyConnectionLost(client: ConnectedBridgeClient): void {
    for (const listener of this.connectionLostListeners) {
      listener(client);
    }
  }

  private notifyConnectionEstablished(client: ConnectedBridgeClient): void {
    for (const listener of this.connectionEstablishedListeners) {
      listener(client);
    }
  }
}

function isBridgeHello(value: unknown): value is BridgeHelloMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<BridgeHelloMessage>;
  return (
    candidate.kind === "hello" &&
    typeof candidate.identity?.clientId === "string" &&
    candidate.identity.clientId.length > 0 &&
    candidate.identity.clientId.length <= 128 &&
    typeof candidate.identity.userId === "string" &&
    candidate.identity.userId.length > 0 &&
    candidate.identity.userId.length <= 128 &&
    typeof candidate.identity.userName === "string" &&
    candidate.identity.userName.length > 0 &&
    candidate.identity.userName.length <= 128 &&
    typeof candidate.identity.isGM === "boolean" &&
    (candidate.identity.lane === "gm" ||
      candidate.identity.lane === "player" ||
      candidate.identity.lane === "tv") &&
    (candidate.identity.isGM
      ? candidate.identity.lane === "gm"
      : candidate.identity.lane !== "gm") &&
    typeof candidate.identity.optedIn === "boolean" &&
    typeof candidate.versions?.protocolVersion === "number" &&
    typeof candidate.versions.foundryVersion === "string" &&
    typeof candidate.versions.systemId === "string" &&
    typeof candidate.versions.systemVersion === "string" &&
    typeof candidate.versions.moduleVersion === "string" &&
    candidate.versions.transport === "websocket" &&
    Array.isArray(candidate.capabilities) &&
    candidate.capabilities.length <= 1024 &&
    candidate.capabilities.every(
      (capability) => typeof capability === "string" && capability.length <= 128,
    )
  );
}

function isEnrollmentHello(value: unknown): value is BridgeEnrollmentHelloMessage & {
  hello: BridgeHelloMessage & { identity: { lane: "player" | "tv"; isGM: false } };
} {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<BridgeEnrollmentHelloMessage>;
  return (
    candidate.kind === "enrollment" &&
    typeof candidate.credential === "string" &&
    candidate.credential.length >= 32 &&
    candidate.credential.length <= 256 &&
    isBridgeHello(candidate.hello) &&
    candidate.hello.identity.isGM === false &&
    (candidate.hello.identity.lane === "player" || candidate.hello.identity.lane === "tv")
  );
}

function bridgeRequestType(raw: string): string | null {
  try {
    const value = JSON.parse(raw) as { id?: unknown; type?: unknown };
    return typeof value.id === "string" && typeof value.type === "string" ? value.type : null;
  } catch {
    return null;
  }
}

function isBridgeEvent(raw: string): boolean {
  try {
    return (JSON.parse(raw) as { kind?: unknown }).kind === "event";
  } catch {
    return false;
  }
}

function hasBridgeEventDelivery(raw: string): boolean {
  try {
    const value = JSON.parse(raw) as { kind?: unknown; delivery?: unknown };
    return value.kind === "event" && value.delivery !== undefined;
  } catch {
    return false;
  }
}

function parseBoundDurableMovementEvent(
  raw: string,
  client: ConnectedBridgeClient,
): { deliveryId: string } | null {
  try {
    const value = JSON.parse(raw) as {
      kind?: unknown;
      event?: unknown;
      payload?: { eventId?: unknown; userId?: unknown };
      delivery?: {
        deliveryId?: unknown;
        attempt?: unknown;
        sender?: { clientId?: unknown; userId?: unknown; lane?: unknown };
      };
    };
    const eventId = value.payload?.eventId;
    const deliveryId = value.delivery?.deliveryId;
    if (
      value.kind !== "event" ||
      value.event !== "foundry-local-api.movement" ||
      client.lane !== "gm" ||
      !client.isGM ||
      typeof eventId !== "string" ||
      eventId.length < 1 ||
      eventId.length > 256 ||
      typeof value.payload?.userId !== "string" ||
      value.payload.userId.length < 1 ||
      value.payload.userId.length > 128 ||
      typeof deliveryId !== "string" ||
      deliveryId !== `movement:${client.userId}:${eventId}` ||
      !Number.isSafeInteger(value.delivery?.attempt) ||
      Number(value.delivery?.attempt) < 1 ||
      value.delivery?.sender?.clientId !== client.clientId ||
      value.delivery.sender.userId !== client.userId ||
      value.delivery.sender.lane !== client.lane
    ) {
      return null;
    }
    return { deliveryId };
  } catch {
    return null;
  }
}

function mapEnrollmentRejection(code: EnrollmentRejectionCode): BridgeEnrollmentErrorCode {
  switch (code) {
    case "credential_expired":
      return "ENROLLMENT_EXPIRED";
    case "credential_replayed":
      return "ENROLLMENT_REPLAYED";
    case "credential_reused_by_second_client":
      return "ENROLLMENT_CLIENT_MISMATCH";
    case "credential_invalidated":
      return "ENROLLMENT_REVOKED";
    case "wrong_user":
      return "ENROLLMENT_USER_MISMATCH";
    case "wrong_lane":
      return "ENROLLMENT_LANE_MISMATCH";
    case "wrong_protocol_version":
      return "ENROLLMENT_PROTOCOL_MISMATCH";
    case "wrong_module_version":
      return "ENROLLMENT_MODULE_MISMATCH";
    case "wrong_scope":
      return "ENROLLMENT_PATH_MISMATCH";
    case "consent_required":
      return "CONSENT_REQUIRED";
    case "duplicate_client":
      return "DUPLICATE_CLIENT";
    case "invalid_credential":
    default:
      return "ENROLLMENT_INVALID";
  }
}
