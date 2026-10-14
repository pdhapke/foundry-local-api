import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { WebSocket } from "ws";
import { BRIDGE_PROTOCOL_VERSION } from "@foundry-local-api/shared";
import { BridgeGateway } from "../bridge/gateway.js";

void test("private frames require a verified current GM, stay bounded and never fan out without an extension", async () => {
  const server = http.createServer();
  const gateway = new BridgeGateway(server, {
    foundrySessionVerifier: {
      verify: async () => ({
        ok: true,
        identity: { worldId: "fixture-world", userId: "gm", userName: "GM", role: 4, isGM: true },
      }),
    },
    bindHost: "127.0.0.1",
    allowedFoundryOrigins: ["http://localhost:30000"],
  });
  let sensitive = 0,
    ordinary = 0,
    current: (() => boolean) | undefined;
  const dispose = gateway.registerPrivateChannel(
    "fixture.private",
    async (payload, sender, isCurrent) => {
      assert.equal(sender.clientId, "client");
      assert.equal(sender.userId, "gm");
      assert.equal(sender.lane, "gm");
      assert.deepEqual(payload, { kind: "fixture.private", value: "synthetic-only" });
      current = isCurrent;
      assert.equal(current(), true);
      sensitive++;
    },
  );
  let complete!: () => void;
  const handled = new Promise<void>((resolve) => {
    complete = resolve;
  });
  gateway.onMessage((_client, raw) => {
    assert.ok(!raw.includes("synthetic-only"));
    ordinary++;
    complete();
  });
  let socket: WebSocket | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    socket = new WebSocket(`ws://127.0.0.1:${address.port}/bridge`, {
      origin: "http://localhost:30000",
    });
    await new Promise<void>((resolve, reject) => {
      socket!.once("open", resolve);
      socket!.once("error", reject);
    });
    const negotiated = new Promise<{ accepted: boolean }>((resolve) =>
      socket!.once("message", (raw) =>
        resolve(JSON.parse(raw.toString()) as { accepted: boolean }),
      ),
    );
    socket.send(
      JSON.stringify({
        kind: "hello",
        browserSessionId: "browser-session",
        worldId: "fixture-world",
        identity: {
          clientId: "client",
          userId: "gm",
          userName: "GM",
          isGM: true,
          lane: "gm",
          optedIn: true,
        },
        versions: {
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          foundryVersion: "14.368",
          systemId: "fixture",
          systemVersion: "1",
          moduleVersion: "0.1.0",
          transport: "websocket",
        },
        capabilities: [],
      }),
    );
    assert.equal((await negotiated).accepted, true);
    socket.send('{"kind":"extension-private","payload":"synthetic-only');
    socket.send(
      JSON.stringify({
        kind: "extension-private",
        channel: "not-installed",
        payload: { value: "synthetic-only" },
      }),
    );
    socket.send(
      JSON.stringify({
        kind: "extension-private",
        channel: "fixture.private",
        payload: { kind: "fixture.private", value: "x".repeat(17000) },
      }),
    );
    socket.send(
      JSON.stringify({
        kind: "extension-private",
        channel: "fixture.private",
        payload: { kind: "fixture.private", value: "synthetic-only" },
      }),
    );
    socket.send(JSON.stringify({ kind: "event", event: "fixture.marker", payload: {} }));
    await handled;
    assert.equal(sensitive, 1);
    assert.equal(ordinary, 1);
    dispose();
    socket.send(
      JSON.stringify({
        kind: "extension-private",
        channel: "fixture.private",
        payload: { kind: "fixture.private", value: "synthetic-only" },
      }),
    );
    socket.send(JSON.stringify({ kind: "event", event: "fixture.marker", payload: {} }));
    await new Promise<void>((resolve) => {
      const check = () => {
        if (ordinary === 2) resolve();
        else setImmediate(check);
      };
      check();
    });
    assert.equal(sensitive, 1);
  } finally {
    socket?.terminate();
    await gateway.close();
    assert.equal(current?.(), false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
