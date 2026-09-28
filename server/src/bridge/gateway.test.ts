import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, describe, it } from "node:test";

import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeEnrollmentHelloMessage,
  type BridgeHelloMessage,
} from "@foundry-local-api/shared";
import { WebSocket } from "ws";

import { BridgeGateway } from "./gateway.js";
import { EnrollmentStore } from "./enrollment-store.js";

const sockets: WebSocket[] = [];
const gateways: BridgeGateway[] = [];
const servers: http.Server[] = [];

function hello(clientId: string, userId: string, lane: "gm" | "player" | "tv"): BridgeHelloMessage {
  return {
    kind: "hello",
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
  administrative = false,
): Promise<WebSocket> {
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/bridge${administrative ? "?apiKey=test-key" : ""}`,
  );
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  socket.send(JSON.stringify(message));
  return socket;
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
    const gateway = new BridgeGateway(server, { apiKey: "test-key", enrollmentStore: enrollments });
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
    const gateway = new BridgeGateway(server, { apiKey: "test-key", enrollmentStore: enrollments });
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
    const gateway = new BridgeGateway(server, { apiKey: "test-key", enrollmentStore: enrollments });
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
    const gateway = new BridgeGateway(server, { apiKey: "test-key", enrollmentStore: enrollments });
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
});
