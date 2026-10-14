import assert from "node:assert/strict";
import http, { type IncomingMessage } from "node:http";
import { afterEach, describe, it } from "node:test";

import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeEnrollmentHelloMessage,
  type BridgeHelloMessage,
} from "@foundry-local-api/shared";
import { WebSocket } from "ws";

import { BridgeGateway } from "./gateway.js";
import { EnrollmentStore } from "./enrollment-store.js";
import type { FoundrySessionVerifier } from "./foundry-session-verifier.js";

const sockets: WebSocket[] = [];
const gateways: BridgeGateway[] = [];
const servers: http.Server[] = [];
const testSessionVerifier: FoundrySessionVerifier = {
  async verify(request) {
    const match = /(?:^|;\s*)session=([A-Za-z0-9._:-]+)\.([A-Za-z0-9._:-]+)/.exec(
      request.headers.cookie ?? "",
    );
    if (!match?.[1] || !match[2]) return { ok: false, code: "unauthenticated" };
    return {
      ok: true,
      identity: {
        userId: match[1],
        userName: match[1],
        worldId: match[2],
        role: 4,
        isGM: true,
      },
    };
  },
};

function hello(
  clientId: string,
  userId: string,
  lane: "gm" | "player" | "tv",
  browserSessionId = `session-${clientId}`,
  identityHandoffProof?: string,
): BridgeHelloMessage {
  return {
    kind: "hello",
    browserSessionId,
    ...(identityHandoffProof ? { identityHandoffProof } : {}),
    ...(lane === "gm" ? { worldId: "world-1" } : {}),
    identity: {
      clientId,
      userId,
      userName: userId,
      isGM: lane === "gm",
      lane,
      optedIn: true,
    },
    versions: {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      foundryVersion: "14.368",
      systemId: "dnd5e",
      systemVersion: "6.0.3",
      moduleVersion: "0.1.0",
      transport: "websocket",
    },
    capabilities: ["status", "playerStatus"],
  };
}

async function connect(
  port: number,
  message: BridgeHelloMessage | BridgeEnrollmentHelloMessage,
  _administrative = false,
  origin?: string,
): Promise<WebSocket> {
  const bridgeHello = message.kind === "enrollment" ? message.hello : message;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`, {
    origin: origin ?? "http://localhost:30000",
    headers: {
      Cookie: `session=${bridgeHello.identity.userId}.${bridgeHello.worldId ?? "world-1"}`,
    },
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  socket.send(JSON.stringify(message));
  return socket;
}

function negotiation(socket: WebSocket): Promise<{ accepted: boolean; errorCode: string | null }> {
  return new Promise((resolve) =>
    socket.once("message", (raw) =>
      resolve(JSON.parse(raw.toString()) as { accepted: boolean; errorCode: string | null }),
    ),
  );
}

/** Keeps a superseded server-side socket alive long enough to exercise the replacement race. */
function suppressRegisteredSocketClose(gateway: BridgeGateway, clientId: string): void {
  const clients = (
    gateway as unknown as {
      clients: Map<string, { socket: WebSocket }>;
    }
  ).clients;
  const registered = clients.get(clientId);
  assert.ok(registered, `Expected ${clientId} to be registered`);
  registered.socket.close = () => undefined;
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

void describe("Track 0 multi-client BridgeGateway", () => {
  void it("keeps GM and player lanes connected and routes explicitly without newest-wins eviction", async () => {
    const server = http.createServer();
    servers.push(server);
    const enrollments = new EnrollmentStore({
      laneCommandAllowlist: { player: ["playerStatus"] },
    });
    const gateway = new BridgeGateway(server, {
      foundrySessionVerifier: testSessionVerifier,
      enrollmentStore: enrollments,
      bindHost: "127.0.0.1",
      allowedFoundryOrigins: ["http://localhost:30000"],
    });
    gateways.push(gateway);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    const gm = await connect(address.port, hello("client-gm", "user-gm", "gm"), true);
    const issued = enrollments.issue({
      issuer: { userId: "user-gm", clientId: "client-gm", isGM: true, connected: true },
      expectedUserId: "user-player",
      expectedClientId: "client-player",
      lane: "player",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      moduleVersion: { kind: "exact", version: "0.1.0" },
    });
    const player = await connect(address.port, {
      kind: "enrollment",
      credential: issued.credential,
      hello: hello("client-player", "user-player", "player"),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(
      gateway.listClients().map((client) => client.clientId),
      ["client-gm", "client-player"],
    );
    assert.deepEqual(
      gateway.listClients().find((client) => client.clientId === "client-player")?.capabilities,
      ["playerStatus"],
    );
    const received: string[] = [];
    gm.on("message", (value) => {
      const raw = value.toString();
      if ((JSON.parse(raw) as { id?: string }).id) received.push(`gm:${raw}`);
    });
    player.on("message", (value) => {
      const raw = value.toString();
      if ((JSON.parse(raw) as { id?: string }).id) received.push(`player:${raw}`);
    });
    const gmCommand = JSON.stringify({ id: "gm-call", type: "gmCommand" });
    const playerCommand = JSON.stringify({ id: "player-call", type: "playerStatus" });
    assert.equal(gateway.send(gmCommand), true);
    assert.equal(gateway.send(playerCommand, { userId: "user-player" }), true);
    assert.equal(
      gateway.send(JSON.stringify({ id: "denied", type: "gmCommand" }), {
        userId: "user-player",
      }),
      false,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(received.sort(), [`gm:${gmCommand}`, `player:${playerCommand}`]);
  });

  void it("enrolls a TV lane and reports only client-advertised allowlisted capabilities", async () => {
    const server = http.createServer();
    servers.push(server);
    const enrollments = new EnrollmentStore({
      laneCommandAllowlist: { tv: ["playerStatus", "tvOnly"] },
    });
    const gateway = new BridgeGateway(server, {
      foundrySessionVerifier: testSessionVerifier,
      enrollmentStore: enrollments,
      bindHost: "127.0.0.1",
      allowedFoundryOrigins: ["http://localhost:30000"],
    });
    gateways.push(gateway);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await connect(address.port, hello("client-gm", "user-gm", "gm"), true);
    const issued = enrollments.issue({
      issuer: { userId: "user-gm", clientId: "client-gm", isGM: true, connected: true },
      expectedUserId: "user-tv",
      expectedClientId: "client-tv",
      lane: "tv",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      moduleVersion: { kind: "exact", version: "0.1.0" },
    });
    await connect(address.port, {
      kind: "enrollment",
      credential: issued.credential,
      hello: hello("client-tv", "user-tv", "tv"),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const tv = gateway.listClients().find((client) => client.clientId === "client-tv");
    assert.equal(tv?.lane, "tv");
    assert.deepEqual(tv?.capabilities, ["playerStatus"]);
  });

  void it("accepts player movement only from the authenticated GM reporter and acknowledges it", async () => {
    const server = http.createServer();
    servers.push(server);
    const enrollments = new EnrollmentStore({
      laneCommandAllowlist: { player: ["playerStatus"] },
    });
    const gateway = new BridgeGateway(server, {
      foundrySessionVerifier: testSessionVerifier,
      enrollmentStore: enrollments,
      bindHost: "127.0.0.1",
      allowedFoundryOrigins: ["http://localhost:30000"],
    });
    gateways.push(gateway);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    const gmSocket = await connect(address.port, hello("client-gm", "user-gm", "gm"), true);
    const issued = enrollments.issue({
      issuer: { userId: "user-gm", clientId: "client-gm", isGM: true, connected: true },
      expectedUserId: "user-player",
      expectedClientId: "client-player",
      lane: "player",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      moduleVersion: { kind: "exact", version: "0.1.0" },
    });
    const player = await connect(address.port, {
      kind: "enrollment",
      credential: issued.credential,
      hello: hello("client-player", "user-player", "player"),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const inbound: Array<{ clientId: string; raw: string }> = [];
    gateway.onMessage((clientId, raw) => inbound.push({ clientId, raw }));
    const invalidOrdinaryEvent = JSON.stringify({
      kind: "event",
      event: "updateActor",
      payload: {},
    });
    const spoofedMovement = JSON.stringify({
      kind: "event",
      event: "foundry-local-api.movement",
      payload: { eventId: "move-spoofed", userId: "user-player" },
      delivery: {
        deliveryId: "movement:user-player:move-spoofed",
        attempt: 1,
        sender: { clientId: "another-client", userId: "user-player", lane: "player" },
      },
    });
    const playerSelfReport = JSON.stringify({
      kind: "event",
      event: "foundry-local-api.movement",
      payload: { eventId: "move-1", userId: "user-player" },
      delivery: {
        deliveryId: "movement:user-player:move-1",
        attempt: 1,
        sender: { clientId: "client-player", userId: "user-player", lane: "player" },
      },
    });
    const validMovement = JSON.stringify({
      kind: "event",
      event: "foundry-local-api.movement",
      payload: { eventId: "move-1", userId: "user-player" },
      delivery: {
        deliveryId: "movement:user-gm:move-1",
        attempt: 1,
        sender: { clientId: "client-gm", userId: "user-gm", lane: "gm" },
      },
    });
    player.send(invalidOrdinaryEvent);
    player.send(spoofedMovement);
    player.send(playerSelfReport);
    gmSocket.send(validMovement);
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(inbound, [{ clientId: "client-gm", raw: validMovement }]);

    const outbound: string[] = [];
    gmSocket.on("message", (value) => outbound.push(value.toString()));
    assert.equal(gateway.acknowledgeEvent("movement:user-gm:move-1", "client-gm"), true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(
      outbound.map((raw) => JSON.parse(raw)),
      [
        {
          kind: "event-ack",
          deliveryId: "movement:user-gm:move-1",
          accepted: true,
          clientId: "client-gm",
        },
      ],
    );
    assert.equal(gmSocket.readyState, WebSocket.OPEN);
  });

  void it("makes a rotated enrollment incapable of commands and durable events", async () => {
    const server = http.createServer();
    servers.push(server);
    const enrollments = new EnrollmentStore({
      laneCommandAllowlist: { player: ["playerStatus"] },
    });
    const gateway = new BridgeGateway(server, {
      foundrySessionVerifier: testSessionVerifier,
      enrollmentStore: enrollments,
      bindHost: "127.0.0.1",
      allowedFoundryOrigins: ["http://localhost:30000"],
    });
    gateways.push(gateway);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await connect(address.port, hello("client-gm", "user-gm", "gm"), true);
    const request = {
      issuer: { userId: "user-gm", clientId: "client-gm", isGM: true, connected: true },
      expectedUserId: "user-player",
      expectedClientId: "client-player",
      lane: "player" as const,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      moduleVersion: { kind: "exact" as const, version: "0.1.0" },
    };
    const issued = enrollments.issue(request);
    const player = await connect(address.port, {
      kind: "enrollment",
      credential: issued.credential,
      hello: hello("client-player", "user-player", "player"),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(gateway.isConnected({ clientId: "client-player" }), true);

    enrollments.rotate(request);
    assert.equal(gateway.isConnected({ clientId: "client-player" }), false);
    assert.equal(
      gateway.send(JSON.stringify({ id: "stale-call", type: "playerStatus" }), {
        clientId: "client-player",
      }),
      false,
    );

    const inbound: string[] = [];
    gateway.onMessage((_clientId, raw) => inbound.push(raw));
    const closed = new Promise<void>((resolve) => player.once("close", () => resolve()));
    player.send(
      JSON.stringify({
        kind: "event",
        event: "foundry-local-api.movement",
        payload: { eventId: "stale-move", userId: "user-player" },
        delivery: {
          deliveryId: "movement:user-player:stale-move",
          attempt: 1,
          sender: { clientId: "client-player", userId: "user-player", lane: "player" },
        },
      }),
    );
    await closed;
    assert.deepEqual(inbound, []);
    assert.equal(
      gateway.listClients().some((client) => client.clientId === "client-player"),
      false,
    );
  });

  void it("rejects concurrent reuse of a verified GM session on another socket", async () => {
    const server = http.createServer();
    servers.push(server);
    const gateway = new BridgeGateway(server, {
      foundrySessionVerifier: testSessionVerifier,
      bindHost: "127.0.0.1",
      allowedFoundryOrigins: ["http://localhost:30000"],
    });
    gateways.push(gateway);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    const current = await connect(address.port, hello("client-gm", "user-gm", "gm"), true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const replay = await connect(address.port, hello("client-gm", "user-gm", "gm"), true);
    const result = await negotiation(replay);
    assert.equal(result.accepted, false);
    assert.equal(result.errorCode, "DUPLICATE_CLIENT");

    const inbound: string[] = [];
    gateway.onMessage((_clientId, raw) => inbound.push(raw));
    const currentEvent = JSON.stringify({ kind: "event", event: "current-gm-event", payload: {} });
    current.send(currentEvent);
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(inbound, [currentEvent]);
  });

  void it("revalidates the Foundry session after a GM reconnect", async () => {
    let verifications = 0;
    const verifier: FoundrySessionVerifier = {
      async verify() {
        verifications += 1;
        return {
          ok: true,
          identity: {
            worldId: "world-1",
            userId: "user-gm",
            userName: "Alice",
            role: 4,
            isGM: true,
          },
        };
      },
    };
    const server = http.createServer();
    servers.push(server);
    const gateway = new BridgeGateway(server, {
      foundrySessionVerifier: verifier,
      bindHost: "127.0.0.1",
      allowedFoundryOrigins: ["http://localhost:30000"],
    });
    gateways.push(gateway);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    const first = await connect(address.port, hello("client-gm", "user-gm", "gm"));
    assert.equal((await negotiation(first)).accepted, true);
    const closed = new Promise<void>((resolve) => first.once("close", () => resolve()));
    first.close();
    await closed;
    const second = await connect(address.port, hello("client-gm", "user-gm", "gm"));
    assert.equal((await negotiation(second)).accepted, true);
    assert.equal(verifications, 2);
  });

  void it("drops responses from a superseded enrolled socket with the same stable client ID", async () => {
    const server = http.createServer();
    servers.push(server);
    const enrollments = new EnrollmentStore({
      laneCommandAllowlist: { player: ["playerStatus"] },
    });
    const gateway = new BridgeGateway(server, {
      foundrySessionVerifier: testSessionVerifier,
      enrollmentStore: enrollments,
      bindHost: "127.0.0.1",
      allowedFoundryOrigins: ["http://localhost:30000"],
    });
    gateways.push(gateway);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await connect(address.port, hello("client-gm", "user-gm", "gm"), true);
    const request = {
      issuer: { userId: "user-gm", clientId: "client-gm", isGM: true, connected: true },
      expectedUserId: "user-player",
      expectedClientId: "client-player",
      lane: "player" as const,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      moduleVersion: { kind: "exact" as const, version: "0.1.0" },
    };
    const initial = enrollments.issue(request);
    const stale = await connect(address.port, {
      kind: "enrollment",
      credential: initial.credential,
      hello: hello("client-player", "user-player", "player"),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    suppressRegisteredSocketClose(gateway, "client-player");

    const replacement = enrollments.rotate(request);
    const current = await connect(address.port, {
      kind: "enrollment",
      credential: replacement.credential,
      hello: hello("client-player", "user-player", "player"),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const inbound: string[] = [];
    gateway.onMessage((_clientId, raw) => inbound.push(raw));
    const staleResponse = JSON.stringify({ id: "stale-response", ok: true, result: "stale" });
    const currentResponse = JSON.stringify({
      id: "current-response",
      ok: true,
      result: "current",
    });
    stale.send(staleResponse);
    current.send(currentResponse);
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(inbound, [currentResponse]);
  });

  void it("refuses a connection while its client identity is reserved for adoption", async () => {
    const server = http.createServer();
    servers.push(server);
    const gateway = new BridgeGateway(server, {
      foundrySessionVerifier: testSessionVerifier,
      bindHost: "127.0.0.1",
      allowedFoundryOrigins: ["http://localhost:30000"],
    });
    gateways.push(gateway);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    await connect(address.port, hello("current-gm", "user-gm", "gm", "session-owner"), true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const binding = { expectedUserId: "user-gm", expectedLane: "gm" as const, ttlMs: 60_000 };
    const proof = gateway.reserveClientIdentity("desired-gm", "current-gm", binding);
    assert.match(proof ?? "", /^[A-Za-z0-9_-]{43}$/);
    const socket = await connect(address.port, hello("desired-gm", "wrong-user", "gm"), true);
    const rejectedWrongUser = await negotiation(socket);
    assert.equal(rejectedWrongUser.accepted, false);
    assert.equal(rejectedWrongUser.errorCode, "DUPLICATE_CLIENT");
    assert.equal(
      gateway.listClients().some((client) => client.clientId === "desired-gm"),
      false,
    );

    const sameUserRace = await connect(
      address.port,
      hello("desired-gm", "user-gm", "gm", "session-racer", proof ?? undefined),
      true,
    );
    const raced = await negotiation(sameUserRace);
    assert.equal(raced.accepted, false);

    const wrongProof = await connect(
      address.port,
      hello(
        "desired-gm",
        "user-gm",
        "gm",
        "session-owner",
        "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      ),
      true,
    );
    assert.equal((await negotiation(wrongProof)).accepted, false);

    const matching = await connect(
      address.port,
      hello("desired-gm", "user-gm", "gm", "session-owner", proof ?? undefined),
      true,
    );
    const accepted = await negotiation(matching);
    assert.equal(accepted.accepted, true);

    const replay = await connect(
      address.port,
      hello("desired-gm", "user-gm", "gm", "session-owner", proof ?? undefined),
      true,
    );
    const replayed = await negotiation(replay);
    assert.equal(replayed.accepted, false);
    gateway.releaseClientIdentity("desired-gm", "current-gm");
  });

  void it("expires an identity handoff proof without opening an unreserved claim path", async () => {
    const server = http.createServer();
    servers.push(server);
    const gateway = new BridgeGateway(server, {
      foundrySessionVerifier: testSessionVerifier,
      bindHost: "127.0.0.1",
      allowedFoundryOrigins: ["http://localhost:30000"],
    });
    gateways.push(gateway);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    await connect(address.port, hello("current-gm", "user-gm", "gm", "session-owner"), true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const proof = gateway.reserveClientIdentity("expired-gm", "current-gm", {
      expectedUserId: "user-gm",
      expectedLane: "gm",
      ttlMs: 1_000,
    });
    assert.ok(proof);
    const reservations = (
      gateway as unknown as { identityReservations: Map<string, { expiresAt: number }> }
    ).identityReservations;
    reservations.get("expired-gm")!.expiresAt = Date.now() - 1;

    const socket = await connect(
      address.port,
      hello("expired-gm", "user-gm", "gm", "session-owner", proof),
      true,
    );
    const rejected = await negotiation(socket);
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.errorCode, "DUPLICATE_CLIENT");
    assert.equal(
      gateway.listClients().some((client) => client.clientId === "expired-gm"),
      false,
    );
  });

  void it("accepts an exact Foundry-confirmed role-4 GM identity", async () => {
    const server = http.createServer();
    servers.push(server);
    const gateway = new BridgeGateway(server, {
      foundrySessionVerifier: testSessionVerifier,
      bindHost: "127.0.0.1",
      allowedFoundryOrigins: ["http://localhost:30000"],
    });
    gateways.push(gateway);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const authenticated = await connect(address.port, hello("gm-a", "user-a", "gm"));
    assert.equal((await negotiation(authenticated)).accepted, true);
  });

  void it("scrubs Cookie material from accepted and rejected upgrade requests", async () => {
    const captured: IncomingMessage[] = [];
    const verifier: FoundrySessionVerifier = {
      async verify(request) {
        captured.push(request);
        return request.headers.cookie?.includes("reject")
          ? { ok: false, code: "unauthenticated" }
          : {
              ok: true,
              identity: {
                worldId: "world-1",
                userId: "user-a",
                userName: "Alice",
                role: 4,
                isGM: true,
              },
            };
      },
    };
    const server = http.createServer();
    servers.push(server);
    const gateway = new BridgeGateway(server, {
      foundrySessionVerifier: verifier,
      bindHost: "127.0.0.1",
      allowedFoundryOrigins: ["http://localhost:30000"],
    });
    gateways.push(gateway);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    assert.equal(
      (await negotiation(await connect(address.port, hello("gm-a", "user-a", "gm")))).accepted,
      true,
    );
    const rejected = await connect(address.port, hello("gm-reject", "reject", "gm"));
    assert.equal((await negotiation(rejected)).accepted, false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(captured.length, 2);
    for (const request of captured) {
      assert.equal(request.headers.cookie, undefined);
      assert.equal(
        request.rawHeaders.some((value) => /cookie|session=/i.test(value)),
        false,
      );
    }
  });

  void it("refuses wrong-world, player, TV-named, and wrong-origin GM claims", async () => {
    const server = http.createServer();
    servers.push(server);
    const identities = new Map<
      string,
      { worldId: string; userId: string; userName: string; role: number }
    >([
      ["user-a", { worldId: "world-1", userId: "user-a", userName: "Alice", role: 4 }],
      ["user-player", { worldId: "world-1", userId: "user-player", userName: "Player", role: 1 }],
      ["user-tv", { worldId: "world-1", userId: "user-tv", userName: "TV", role: 4 }],
      ["user-tv-lower", { worldId: "world-1", userId: "user-tv-lower", userName: "tv", role: 4 }],
      ["user-tv-mixed", { worldId: "world-1", userId: "user-tv-mixed", userName: "Tv", role: 4 }],
      ["claimed", { worldId: "world-1", userId: "actual", userName: "Alice", role: 4 }],
    ]);
    const verifier: FoundrySessionVerifier = {
      async verify(request) {
        const userId = /session=([A-Za-z0-9-]+)/.exec(request.headers.cookie ?? "")?.[1];
        const identity = userId ? identities.get(userId) : undefined;
        return identity
          ? { ok: true, identity: { ...identity, isGM: identity.role === 4 } }
          : { ok: false, code: "unauthenticated" };
      },
    };
    const gateway = new BridgeGateway(server, {
      foundrySessionVerifier: verifier,
      bindHost: "127.0.0.1",
      allowedFoundryOrigins: ["http://localhost:30000"],
    });
    gateways.push(gateway);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const wrongWorldHello = { ...hello("gm-wrong-world", "user-a", "gm"), worldId: "other" };
    assert.equal(
      (await negotiation(await connect(address.port, wrongWorldHello))).errorCode,
      "FOUNDRY_IDENTITY_MISMATCH",
    );
    assert.equal(
      (await negotiation(await connect(address.port, hello("gm-player", "user-player", "gm"))))
        .errorCode,
      "FOUNDRY_IDENTITY_MISMATCH",
    );
    assert.equal(
      (await negotiation(await connect(address.port, hello("gm-wrong-user", "claimed", "gm"))))
        .errorCode,
      "FOUNDRY_IDENTITY_MISMATCH",
    );
    for (const userId of ["user-tv", "user-tv-lower", "user-tv-mixed"]) {
      assert.equal(
        (await negotiation(await connect(address.port, hello(`gm-${userId}`, userId, "gm"))))
          .errorCode,
        "FOUNDRY_IDENTITY_MISMATCH",
      );
    }

    const wrongOrigin = await connect(
      address.port,
      hello("gm-wrong-origin", "user-a", "gm"),
      false,
      "http://127.0.0.1:30000",
    );
    assert.equal((await negotiation(wrongOrigin)).accepted, false);
  });

  void it("fails closed at construction for a remote bridge bind", () => {
    const server = http.createServer();
    servers.push(server);
    assert.throws(
      () =>
        new BridgeGateway(server, {
          foundrySessionVerifier: testSessionVerifier,
          bindHost: "0.0.0.0",
          allowedFoundryOrigins: ["http://localhost:30000"],
        }),
      /loopback/,
    );
  });

  void it("rejects a remote WebSocket peer before session verification", async () => {
    let verifications = 0;
    const verifier: FoundrySessionVerifier = {
      async verify() {
        verifications += 1;
        return { ok: false, code: "unauthenticated" };
      },
    };
    const server = http.createServer();
    servers.push(server);
    const gateway = new BridgeGateway(server, {
      foundrySessionVerifier: verifier,
      bindHost: "127.0.0.1",
      allowedFoundryOrigins: ["http://localhost:30000"],
    });
    gateways.push(gateway);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const trustedCheck = (
      gateway as unknown as { isTrustedFoundryLoopback: (request: IncomingMessage) => boolean }
    ).isTrustedFoundryLoopback.bind(gateway);
    const remoteRequest = {
      headers: { origin: "http://localhost:30000", cookie: "session=secret" },
      rawHeaders: ["Cookie", "session=secret"],
      socket: { remoteAddress: "192.0.2.10" },
    } as IncomingMessage;
    assert.equal(trustedCheck(remoteRequest), false);
    assert.equal(verifications, 0);
  });

  void it("does not accept the administrative API key as WebSocket authentication", async () => {
    const server = http.createServer();
    servers.push(server);
    const gateway = new BridgeGateway(server, {
      foundrySessionVerifier: testSessionVerifier,
      bindHost: "127.0.0.1",
      allowedFoundryOrigins: ["http://localhost:30000"],
    });
    gateways.push(gateway);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/bridge?apiKey=test-key`, {
      origin: "http://localhost:30000",
      headers: { Cookie: "session=user-gm.world-1" },
    });
    sockets.push(socket);
    const status = await new Promise<number>((resolve, reject) => {
      socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      socket.once("open", () => reject(new Error("API key unexpectedly opened the bridge")));
      socket.once("error", () => undefined);
    });
    assert.equal(status, 403);
    assert.equal(gateway.listClients().length, 0);
  });

  void it("rejects a tunneled WebSocket upgrade before session verification", async () => {
    let verifications = 0;
    const verifier: FoundrySessionVerifier = {
      async verify() {
        verifications += 1;
        return { ok: false, code: "unauthenticated" };
      },
    };
    const server = http.createServer();
    servers.push(server);
    const gateway = new BridgeGateway(server, {
      foundrySessionVerifier: verifier,
      bindHost: "127.0.0.1",
      allowedFoundryOrigins: ["http://localhost:30000"],
    });
    gateways.push(gateway);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/bridge`, {
      origin: "http://localhost:30000",
      headers: {
        Cookie: "session=user-gm.world-1",
        "X-Forwarded-For": "203.0.113.10",
      },
    });
    sockets.push(socket);
    const status = await new Promise<number>((resolve, reject) => {
      socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      socket.once("open", () => reject(new Error("tunneled upgrade opened the bridge")));
      socket.once("error", () => undefined);
    });
    assert.equal(status, 403);
    assert.equal(verifications, 0);
    assert.equal(gateway.listClients().length, 0);
  });
});
