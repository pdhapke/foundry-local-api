import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { WebSocket } from "ws";
import { BRIDGE_PROTOCOL_VERSION } from "@foundry-local-api/shared";
import { BridgeGateway } from "./gateway.js";

void test("dot identity accessor uses the verifier snapshot, copies it, and revokes on disconnect", async () => {
  const server = http.createServer();
  const identity = { userId: "gm", userName: "Verified GM", worldId: "world", role: 4, isGM: true };
  const gateway = new BridgeGateway(server, { foundrySessionVerifier: { verify: async () => ({ ok: true, identity }) }, bindHost: "127.0.0.1", allowedFoundryOrigins: ["http://localhost:30000"] });
  let socket: WebSocket | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    socket = new WebSocket(`ws://127.0.0.1:${address.port}/bridge`, { origin: "http://localhost:30000", headers: { Cookie: "synthetic-session=unused" } });
    await new Promise<void>((resolve, reject) => { socket!.once("open", resolve); socket!.once("error", reject); });
    const negotiated = new Promise<{ accepted: boolean }>(resolve => socket!.once("message", raw => resolve(JSON.parse(raw.toString()) as { accepted: boolean })));
    socket.send(JSON.stringify({ kind: "hello", browserSessionId: "browser-session", worldId: "world", identity: { clientId: "client", userId: "gm", userName: "Untrusted browser label", isGM: true, lane: "gm", optedIn: true }, versions: { protocolVersion: BRIDGE_PROTOCOL_VERSION, foundryVersion: "14.368", systemId: "dnd5e", systemVersion: "6.0.3", moduleVersion: "0.1.0", transport: "websocket" }, capabilities: ["dotBind"] }));
    assert.equal((await negotiated).accepted, true);
    const selector = { clientId: "client", userId: "gm", lane: "gm" as const };
    assert.deepEqual(gateway.getVerifiedFoundryIdentity(selector), identity);
    const snapshot = gateway.getVerifiedFoundryIdentity(selector)!; snapshot.worldId = "forged"; identity.userName = "Changed after verification";
    assert.equal(gateway.getVerifiedFoundryIdentity(selector)!.worldId, "world");
    assert.equal(gateway.getVerifiedFoundryIdentity(selector)!.userName, "Verified GM");
    assert.equal(gateway.getVerifiedFoundryIdentity({ ...selector, userId: "other" }), null);
    assert.equal(gateway.getVerifiedFoundryIdentity({ ...selector, lane: "player" }), null);
    const closed = new Promise<void>(resolve => socket!.once("close", () => resolve())); socket.close(); await closed;
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(gateway.getVerifiedFoundryIdentity(selector), null);
  } finally { socket?.terminate(); await gateway.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
