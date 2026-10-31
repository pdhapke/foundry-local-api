import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import express from "express";
import type { BridgeGateway } from "../bridge/gateway.js";
import type { FoundryClient } from "../bridge/foundry-client.js";
import { createApp } from "../app.js";
import { ApiExtensionHost, parseExtensionUrls } from "./host.js";

function fixture(failDisposal = false) {
  let registered = 0;
  const gateway = {
    getClient: () => null,
    getVerifiedFoundryIdentity: () => null,
    send: () => false,
    registerPrivateChannel: () => {
      registered++;
      return () => {
        registered--;
        if (failDisposal) throw new Error("synthetic disposal failure");
      };
    },
    onConnectionEstablished: () => () => undefined,
    onConnectionLost: () => () => undefined,
  } as unknown as BridgeGateway;
  const host = new ApiExtensionHost({
    gateway,
    foundryClient: { call: async () => ({}) } as unknown as FoundryClient,
    runtimeRoot: new URL("file:///C:/synthetic/runtime/"),
    moduleRoot: new URL("file:///C:/synthetic/module/"),
    movement: {
      path: "synthetic",
      getStore: () => undefined,
      diagnose: () => ({
        configured: false,
        runtimeAvailable: false,
        readable: false,
        valid: false,
        version: null,
        generation: null,
        eventCount: null,
        nextSequence: null,
        issueCodes: ["STORE_NOT_CONFIGURED"],
      }),
      reloadStore: () => undefined,
      onRecord: () => () => undefined,
    },
    bindHost: "127.0.0.1",
    administrativeCredentialSha256: "a".repeat(64),
  });
  return { host, registered: () => registered };
}
const options = {
  apiKey: "synthetic-only",
  isDevelopment: false,
  corsAllowedOrigins: [],
  rateLimitWindowMs: 60000,
  rateLimitMax: 10,
  requestLogger: () => undefined,
};

void test("extension configuration is opt-in, bounded and restricted to unique local file URLs", () => {
  assert.deepEqual(parseExtensionUrls(undefined), []);
  assert.deepEqual(parseExtensionUrls('["file:///C:/synthetic/extension.js"]'), [
    "file:///C:/synthetic/extension.js",
  ]);
  for (const value of [
    "{}",
    '["https://example.org/code.js"]',
    '["file://remote/share/code.js"]',
    '["file:///C:/code.js?x=1"]',
    '["file:///C:/code.js","file:///C:/code.js"]',
  ])
    assert.throws(() => parseExtensionUrls(value));
});
void test("standalone API serves ordinary health and does not mount extension routes", async () => {
  const { host } = fixture();
  let imports = 0;
  await host.load(undefined, async () => {
    imports++;
    return {};
  });
  assert.equal(imports, 0);
  assert.deepEqual(host.routeSnapshot(), []);
  const app = createApp({ ...options, extensionRoutes: host.routeSnapshot() });
  await request(app).get("/health").expect(200);
  await request(app).post("/domain/private").send({}).expect(404);
  await host.shutdown();
});
void test("failed extension startup revokes earlier routes, events, channels and calls", async () => {
  const { host, registered } = fixture();
  let stopped = 0;
  await assert.rejects(
    host.load('["file:///C:/synthetic/one.js","file:///C:/synthetic/two.js"]', async (url) => {
      if (url.endsWith("two.js")) throw new Error("synthetic private error");
      return {
        registerExtension: (context: typeof host.context) => {
          context.registerPrivateChannel("private-fixture", async () => undefined);
          context.registerEventHandler("fixture.event", () => undefined);
          context.registerRoute("/domain/private", (_req, res) => {
            res.json({ ok: true });
          });
          context.onShutdown(() => {
            stopped++;
          });
        },
      };
    }),
    { message: "Configured API extension could not be loaded." },
  );
  assert.equal(registered(), 0);
  assert.equal(stopped, 1);
  assert.deepEqual(host.routeSnapshot(), []);
  assert.equal(
    host.consumeEvent("fixture.event", {}, { clientId: "client", userId: "gm", lane: "gm" }),
    false,
  );
  assert.throws(() => host.context.call("read", {}, {}), /closed/);
});
void test("private extension routes own their parser before shared parser and are revoked on shutdown", async () => {
  const { host } = fixture();
  const router = express.Router();
  router.use(express.json({ limit: "1kb" }));
  router.post("/domain/private", (_req, res) => {
    res.json({ ok: true });
  });
  host.context.registerRoute("/domain/private", router);
  for (const path of ["/api", "/mcp/subpath", "/health", "/bridge", "/domain?x", "/domain/*"])
    assert.throws(() => host.context.registerRoute(path, router));
  const app = createApp({ ...options, extensionRoutes: host.routeSnapshot() });
  await request(app).post("/domain/private").send({ field: "short" }).expect(200);
  await request(app)
    .post("/domain/private")
    .send({ field: "x".repeat(2048) })
    .expect(500);
  await host.shutdown();
  await request(app).post("/domain/private").send({}).expect(503);
});

void test("shutdown revokes ingress first while allowing native cleanup before the bridge closes", async () => {
  const { host } = fixture();
  let cleanup = false;
  host.context.registerEventHandler("fixture.event", () => undefined);
  host.context.onShutdown(async () => {
    assert.equal(
      host.consumeEvent("fixture.event", {}, { clientId: "client", userId: "gm", lane: "gm" }),
      false,
    );
    await host.context.call("fixtureUnbind", {}, { clientId: "client", userId: "gm", lane: "gm" });
    cleanup = true;
  });
  await host.shutdown();
  assert.equal(cleanup, true);
  assert.throws(() => host.context.call("fixtureUnbind", {}, {}), /closed/);
});

void test("one registration cleanup failure cannot skip extension-owned shutdown", async () => {
  const { host, registered } = fixture(true);
  let stopped = false;
  host.context.registerPrivateChannel("fixture.private", async () => undefined);
  host.context.onShutdown(() => {
    stopped = true;
  });
  await assert.rejects(host.shutdown(), { message: "Extension shutdown incomplete." });
  assert.equal(registered(), 0);
  assert.equal(stopped, true);
  assert.throws(() => host.context.call("fixtureUnbind", {}, {}), /closed/);
});

void test("event observers see forwarded events without consuming them", async () => {
  const { host } = fixture();
  const metadata = { clientId: "client", userId: "gm", lane: "gm" as const };
  const seen: string[] = [];
  const stopFirst = host.context.observeEvent("createChatMessage", (payload) => {
    seen.push(`first:${String((payload as { id?: string }).id)}`);
  });
  host.context.observeEvent("createChatMessage", () => {
    throw new Error("synthetic observer failure");
  });
  host.context.observeEvent("createChatMessage", (payload) => {
    seen.push(`second:${String((payload as { id?: string }).id)}`);
  });
  host.notifyObservers("createChatMessage", { id: "m1" }, metadata);
  assert.deepEqual(seen, ["first:m1", "second:m1"]);
  // Observing never claims the event, so the event bus still publishes it.
  assert.equal(host.consumeEvent("createChatMessage", { id: "m1" }, metadata), false);
  stopFirst();
  host.notifyObservers("createChatMessage", { id: "m2" }, metadata);
  assert.deepEqual(seen, ["first:m1", "second:m1", "second:m2"]);
  assert.throws(() => host.context.observeEvent("bad name!", () => undefined), /invalid/);
  await host.shutdown();
  host.notifyObservers("createChatMessage", { id: "m3" }, metadata);
  assert.equal(seen.length, 3);
});
