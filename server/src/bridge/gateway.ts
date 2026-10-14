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
import { createHash, randomBytes } from "node:crypto";

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
import type {
  FoundrySessionIdentity,
  FoundrySessionVerificationErrorCode,
  FoundrySessionVerifier,
} from "./foundry-session-verifier.js";

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

export type PrivateBridgeHandler = (
  payload: unknown,
  sender: { clientId: string; userId: string; lane: string },
  current: () => boolean,
) => Promise<void>;

export interface BridgeClientSelector {
  clientId?: string;
  userId?: string;
  lane?: BridgeClientLane;
}

interface RegisteredConnection {
  socket: WebSocket;
  client: ConnectedBridgeClient;
  browserSessionId: string;
  /** Obtained from the independent session verifier, never from hello payloads. */
  verifiedFoundryIdentity?: FoundrySessionIdentity;
}

export interface BridgeGatewayOptions {
  /** Independently validates the upgrade request's Foundry session for GM clients. */
  foundrySessionVerifier: FoundrySessionVerifier;
  enrollmentStore?: EnrollmentStore;
  bindHost?: string;
  allowedFoundryOrigins?: readonly string[];
  negotiationTimeoutMs?: number;
}

export class BridgeGateway {
  private readonly wss: WebSocketServer;
  private readonly foundrySessionVerifier: FoundrySessionVerifier;
  private readonly enrollmentStore: EnrollmentStore;
  private readonly bindHost: string;
  private readonly allowedFoundryOrigins: ReadonlySet<string>;
  private readonly identityReservations = new Map<
    string,
    {
      ownerClientId: string;
      expectedUserId: string;
      expectedLane: "gm" | "player" | "tv";
      expectedBrowserSessionId: string;
      proofHash: string;
      expiresAt: number;
    }
  >();
  private readonly negotiationTimeoutMs: number;
  private readonly clients = new Map<string, RegisteredConnection>();
  private readonly socketClientIds = new Map<WebSocket, string>();
  private readonly pendingGmSockets = new WeakSet<WebSocket>();
  private readonly messageListeners = new Set<BridgeMessageListener>();
  private readonly connectionLostListeners = new Set<BridgeConnectionLostListener>();
  private readonly connectionEstablishedListeners = new Set<BridgeConnectionEstablishedListener>();
  private readonly privateChannels = new Map<string, PrivateBridgeHandler>();

  /** Sensitive frames are consumed before ordinary listeners, even without a handler. */
  registerPrivateChannel(kind: string, handler: PrivateBridgeHandler): () => void {
    if (
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(kind) ||
      ["event", "hello", "enrollment", "private", "extension-private", "negotiation"].includes(
        kind,
      ) ||
      this.privateChannels.has(kind)
    )
      throw new Error("Private bridge channel is invalid or duplicated.");
    this.privateChannels.set(kind, handler);
    return () => {
      if (this.privateChannels.get(kind) === handler) this.privateChannels.delete(kind);
    };
  }

  constructor(httpServer: HttpServer, options: BridgeGatewayOptions) {
    if (!isLoopbackHost(options.bindHost ?? "")) {
      throw new Error("The bridge must bind to an explicit loopback interface.");
    }
    this.foundrySessionVerifier = options.foundrySessionVerifier;
    this.enrollmentStore = options.enrollmentStore ?? new EnrollmentStore();
    this.bindHost = options.bindHost ?? "";
    this.allowedFoundryOrigins = new Set(options.allowedFoundryOrigins ?? []);
    this.negotiationTimeoutMs = options.negotiationTimeoutMs ?? 5_000;
    this.wss = new WebSocketServer({
      server: httpServer,
      path: "/bridge",
      verifyClient: (info: { req: IncomingMessage }, callback) => {
        if (this.isUpgradeAllowed(info.req)) {
          callback(true);
          return;
        }
        console.warn("[bridge] rejected connection attempt: invalid bridge request");
        callback(false, 403, "Forbidden");
      },
    });
    this.wss.on("connection", (socket: WebSocket, req: IncomingMessage) =>
      this.handleConnection(socket, req),
    );
  }

  private isUpgradeAllowed(req: IncomingMessage): boolean {
    const url = new URL(req.url ?? "", "http://localhost");
    return url.pathname === "/bridge" && url.search === "";
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

  /** Exact current socket's independently verified GM identity; no cookie/token is retained. */
  getVerifiedFoundryIdentity(selector: BridgeClientSelector): FoundrySessionIdentity | null {
    const registration = this.resolveConnection(selector);
    if (!registration || registration.client.lane !== "gm" || !registration.verifiedFoundryIdentity)
      return null;
    return { ...registration.verifiedFoundryIdentity };
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

  /** Temporarily reserves an absent client ID while an authenticated client adopts it. */
  reserveClientIdentity(
    desiredClientId: string,
    ownerClientId: string,
    binding: {
      expectedUserId: string;
      expectedLane: "gm" | "player" | "tv";
      ttlMs: number;
    },
  ): string | null {
    const existing = this.identityReservations.get(desiredClientId);
    const owner = this.clients.get(ownerClientId);
    if (
      !desiredClientId ||
      !ownerClientId ||
      !binding.expectedUserId ||
      !Number.isSafeInteger(binding.ttlMs) ||
      binding.ttlMs < 1_000 ||
      binding.ttlMs > 120_000 ||
      (!existing && this.identityReservations.size >= 100) ||
      this.clients.has(desiredClientId) ||
      (existing && existing.expiresAt > Date.now()) ||
      !owner ||
      owner.client.userId !== binding.expectedUserId ||
      owner.client.lane !== binding.expectedLane
    ) {
      return null;
    }
    const proof = randomBytes(32).toString("base64url");
    this.identityReservations.set(desiredClientId, {
      ownerClientId,
      expectedUserId: binding.expectedUserId,
      expectedLane: binding.expectedLane,
      expectedBrowserSessionId: owner.browserSessionId,
      proofHash: createHash("sha256").update(proof).digest("hex"),
      expiresAt: Date.now() + binding.ttlMs,
    });
    return proof;
  }

  releaseClientIdentity(desiredClientId: string, ownerClientId: string): void {
    if (this.identityReservations.get(desiredClientId)?.ownerClientId === ownerClientId) {
      this.identityReservations.delete(desiredClientId);
    }
  }

  /** Registers a listener invoked with the raw text of every inbound message from the active connection. */
  onMessage(listener: BridgeMessageListener): void {
    this.messageListeners.add(listener);
  }

  /** Registers a listener invoked whenever the active connection is lost (closed or replaced). */
  onConnectionLost(listener: BridgeConnectionLostListener): () => void {
    this.connectionLostListeners.add(listener);
    return () => {
      this.connectionLostListeners.delete(listener);
    };
  }

  /** Registers a listener invoked whenever a new connection becomes the active one. See `BridgeConnectionEstablishedListener`'s doc comment above. */
  onConnectionEstablished(listener: BridgeConnectionEstablishedListener): () => void {
    this.connectionEstablishedListeners.add(listener);
    return () => {
      this.connectionEstablishedListeners.delete(listener);
    };
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

  private handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const requestContext: { current: IncomingMessage | undefined } = { current: request };
    const releaseRequest = (): void => {
      const current = requestContext.current;
      if (!current) return;
      scrubCookieHeaders(current);
      requestContext.current = undefined;
    };
    const negotiationTimer = setTimeout(() => {
      if (!this.socketClientIds.has(socket)) {
        releaseRequest();
        socket.close(1008, "Negotiation timeout");
      }
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
        if (this.pendingGmSockets.has(socket)) return;
        const currentRequest = requestContext.current;
        if (!currentRequest) {
          this.rejectNegotiation(socket, "ENROLLMENT_INVALID");
          return;
        }
        this.acceptUnregisteredHello(socket, raw, currentRequest, releaseRequest);
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
      // Never fan credential-bearing setup frames into FoundryClient, event
      // buses, audit sinks, latency traces, outboxes or diagnostics.
      let privateMessage: unknown;
      try {
        privateMessage = JSON.parse(raw);
      } catch {
        // JSON parser errors can include fragments of a malformed credential
        // frame. Never forward those bytes to diagnostic parsers/listeners.
        if (Buffer.isBuffer(data)) data.fill(0);
        return;
      }
      const frame =
        privateMessage && typeof privateMessage === "object"
          ? (privateMessage as Record<string, unknown>)
          : undefined;
      const kind = frame?.["kind"];
      // Registered legacy kinds remain compatible; reserved private envelopes
      // fail closed for absent extensions, unknown channels and non-GM senders.
      const envelope = kind === "private" || kind === "extension-private";
      if (envelope || (typeof kind === "string" && kind !== "event")) {
        const channel = envelope ? frame?.["channel"] : kind;
        const handler = typeof channel === "string" ? this.privateChannels.get(channel) : undefined;
        const payload = envelope ? frame?.["payload"] : privateMessage;
        if (
          Buffer.byteLength(raw, "utf8") <= 16384 &&
          registered.client.lane === "gm" &&
          registered.verifiedFoundryIdentity &&
          handler
        ) {
          const sender = { clientId, userId: registered.client.userId, lane: "gm" };
          void handler(
            payload,
            sender,
            () => this.clients.get(clientId) === registered && socket.readyState === WebSocket.OPEN,
          ).catch(() => undefined);
        }
        // The handler synchronously owns any data it needs before this returns.
        if (Buffer.isBuffer(data)) data.fill(0);
        return;
      }
      // The ordinary lane accepts only event envelopes and correlated command
      // responses. Unrecognized shapes cannot become raw diagnostic input.
      if (
        kind !== "event" &&
        !(typeof frame?.["id"] === "string" && typeof frame?.["ok"] === "boolean")
      ) {
        if (Buffer.isBuffer(data)) data.fill(0);
        return;
      }
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
      releaseRequest();
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

  private acceptUnregisteredHello(
    socket: WebSocket,
    raw: string,
    request: IncomingMessage,
    releaseRequest: () => void,
  ): void {
    let candidate: unknown;
    try {
      candidate = JSON.parse(raw) as unknown;
    } catch {
      releaseRequest();
      this.rejectNegotiation(socket, "ENROLLMENT_INVALID");
      return;
    }
    if (isBridgeHello(candidate) && candidate.identity.isGM && candidate.identity.lane === "gm") {
      this.pendingGmSockets.add(socket);
      void this.acceptGmSessionHello(socket, candidate, request).finally(() => {
        releaseRequest();
        this.pendingGmSockets.delete(socket);
      });
      return;
    }
    releaseRequest();
    this.acceptEnrollmentHello(socket, raw);
  }

  private async acceptGmSessionHello(
    socket: WebSocket,
    hello: BridgeHelloMessage,
    request: IncomingMessage,
  ): Promise<void> {
    if (
      hello.versions.protocolVersion !== BRIDGE_PROTOCOL_VERSION ||
      !hello.worldId ||
      !this.isTrustedFoundryLoopback(request)
    ) {
      this.rejectNegotiation(socket, "ENROLLMENT_INVALID");
      return;
    }
    const result = await this.foundrySessionVerifier.verify(request);
    if (socket.readyState !== WebSocket.OPEN) return;
    if (!result.ok) {
      this.rejectNegotiation(socket, mapSessionVerificationError(result.code));
      return;
    }
    if (!matchesGmHello(result.identity, hello)) {
      this.rejectNegotiation(socket, "FOUNDRY_IDENTITY_MISMATCH");
      return;
    }
    if (this.hasConflictingGmSession(socket, result.identity, hello)) {
      this.rejectNegotiation(socket, "DUPLICATE_CLIENT");
      return;
    }
    this.registerClient(
      socket,
      {
        ...hello,
        identity: { ...hello.identity, userName: result.identity.userName, isGM: true, lane: "gm" },
      },
      undefined,
      result.identity,
    );
  }

  private hasConflictingGmSession(
    socket: WebSocket,
    identity: FoundrySessionIdentity,
    hello: BridgeHelloMessage,
  ): boolean {
    const reservation = this.identityReservations.get(hello.identity.clientId);
    if (reservation?.ownerClientId) return false;
    return [...this.clients.values()].some(
      (registered) =>
        registered.socket !== socket &&
        registered.socket.readyState === WebSocket.OPEN &&
        registered.client.lane === "gm" &&
        registered.client.userId === identity.userId,
    );
  }

  private isTrustedFoundryLoopback(request: IncomingMessage): boolean {
    if (!isLoopbackHost(this.bindHost) || !isLoopbackAddress(request.socket.remoteAddress)) {
      return false;
    }
    const origin = request.headers.origin;
    return typeof origin === "string" && this.allowedFoundryOrigins.has(origin);
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
    verifiedFoundryIdentity?: FoundrySessionIdentity,
  ): void {
    const reservation = this.identityReservations.get(hello.identity.clientId);
    if (reservation) {
      const proofHash = hello.identityHandoffProof
        ? createHash("sha256").update(hello.identityHandoffProof).digest("hex")
        : "";
      const matches =
        reservation.expiresAt > Date.now() &&
        hello.identity.userId === reservation.expectedUserId &&
        hello.identity.lane === reservation.expectedLane &&
        hello.identity.isGM === (reservation.expectedLane === "gm") &&
        hello.browserSessionId === reservation.expectedBrowserSessionId &&
        timingSafeEqualStrings(proofHash, reservation.proofHash);
      if (!matches) {
        this.rejectNegotiation(socket, "DUPLICATE_CLIENT");
        return;
      }
      this.identityReservations.delete(hello.identity.clientId);
    } else if (hello.identityHandoffProof !== undefined) {
      this.rejectNegotiation(socket, "DUPLICATE_CLIENT");
      return;
    }
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
    if (stale && stale.browserSessionId !== hello.browserSessionId) {
      this.rejectNegotiation(socket, "DUPLICATE_CLIENT");
      return;
    }
    this.clients.set(client.clientId, {
      socket,
      client,
      browserSessionId: hello.browserSessionId,
      ...(verifiedFoundryIdentity
        ? { verifiedFoundryIdentity: { ...verifiedFoundryIdentity } }
        : {}),
    });
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
    typeof candidate.browserSessionId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(candidate.browserSessionId) &&
    (candidate.identityHandoffProof === undefined ||
      (typeof candidate.identityHandoffProof === "string" &&
        /^[A-Za-z0-9_-]{43}$/.test(candidate.identityHandoffProof))) &&
    (candidate.worldId === undefined ||
      (typeof candidate.worldId === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(candidate.worldId))) &&
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

function matchesGmHello(identity: FoundrySessionIdentity, hello: BridgeHelloMessage): boolean {
  return (
    identity.worldId === hello.worldId &&
    identity.userId === hello.identity.userId &&
    identity.isGM &&
    identity.role === 4 &&
    identity.userName.toLowerCase() !== "tv"
  );
}

function mapSessionVerificationError(
  code: FoundrySessionVerificationErrorCode,
): BridgeEnrollmentErrorCode {
  switch (code) {
    case "missing_cookie":
    case "malformed_cookie":
      return "FOUNDRY_SESSION_REQUIRED";
    case "unavailable":
    case "timeout":
    case "redirect":
    case "malformed_response":
      return "FOUNDRY_SESSION_UNAVAILABLE";
    case "unauthenticated":
    case "not_in_world":
    default:
      return "FOUNDRY_SESSION_REJECTED";
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function scrubCookieHeaders(request: IncomingMessage): void {
  delete request.headers.cookie;
  const sanitized: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "cookie") continue;
    sanitized.push(request.rawHeaders[index] ?? "", request.rawHeaders[index + 1] ?? "");
  }
  request.rawHeaders = sanitized;
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
