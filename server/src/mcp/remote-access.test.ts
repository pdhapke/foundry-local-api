import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";

import request from "supertest";
import { WebSocket } from "ws";

import { createApp } from "../app.js";
import type { FoundryClient } from "../bridge/foundry-client.js";
import type { IntegrationChangeListener, IntegrationManager } from "../integrations/manager.js";
import type { Integration } from "../integrations/types.js";
import { createPublicMcpApp, createPublicMcpServer } from "./public-app.js";

const ADMIN_KEY = "admin-api-key-0123456789abcdef";
const REMOTE_KEY = "remote-mcp-key-0123456789abcdef";

const FAKE_CLIENT = {
  call: (command: string, payload: unknown) =>
    Promise.resolve({ command, payload: payload ?? null }),
} as unknown as FoundryClient;

class FakeIntegrationManager {
  getActive(): Integration[] {
    return [];
  }

  onChange(listener: IntegrationChangeListener): () => void {
    void listener;
    return () => undefined;
  }
}

const MANAGER = new FakeIntegrationManager() as unknown as IntegrationManager;

const ACCEPT = "application/json, text/event-stream";
const INITIALIZE_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "remote-access-test", version: "1.0.0" },
  },
};

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function localApp(
  overrides: Partial<Parameters<typeof createApp>[0]> = {},
): ReturnType<typeof createApp> {
  const app = createApp({
    isDevelopment: false,
    requestLogger: () => undefined,
    apiKey: ADMIN_KEY,
    corsAllowedOrigins: [],
    rateLimitWindowMs: 60_000,
    rateLimitMax: 100,
    mcpApiKeys: [REMOTE_KEY],
    mcp: { foundryClient: FAKE_CLIENT, integrationManager: MANAGER },
    ...overrides,
  });
  app.locals["foundryClient"] = FAKE_CLIENT;
  return app;
}

function publicApp(
  overrides: Partial<Parameters<typeof createPublicMcpApp>[0]> = {},
): ReturnType<typeof createPublicMcpApp> {
  return createPublicMcpApp({
    isDevelopment: false,
    requestLogger: () => undefined,
    remoteApiKey: REMOTE_KEY,
    corsAllowedOrigins: [],
    allowedHosts: [],
    rateLimitWindowMs: 60_000,
    rateLimitMax: 100,
    foundryClient: FAKE_CLIENT,
    integrationManager: MANAGER,
    ...overrides,
  });
}

function mcpPost(app: ReturnType<typeof createApp> | ReturnType<typeof createPublicMcpApp>) {
  return request(app).post("/mcp").set("Accept", ACCEPT).set("Content-Type", "application/json");
}

void describe("local listener tunnel guard", () => {
  void it("keeps direct local routes on their existing auth rules", async () => {
    const app = localApp();

    assert.equal((await request(app).get("/health")).status, 200);
    assert.equal(app.get("trust proxy"), false);

    const adminApi = await request(app).get("/api/status").set("X-Api-Key", ADMIN_KEY);
    assert.equal(adminApi.status, 200);

    const remoteOnApi = await request(app)
      .get("/api/status")
      .set("Authorization", `Bearer ${REMOTE_KEY}`);
    assert.equal(remoteOnApi.status, 401);

    const remoteOnMcp = await mcpPost(app).set("Authorization", `Bearer ${REMOTE_KEY}`).send({});
    assert.equal(remoteOnMcp.status, 400);
    assert.equal(remoteOnMcp.body.error.code, "BAD_REQUEST");

    const adminOnMcp = await mcpPost(app).set("X-Api-Key", ADMIN_KEY).send({});
    assert.equal(adminOnMcp.status, 400);
  });

  void it("rejects every proxied path, including /mcp and extension routes", async () => {
    let extensionHits = 0;
    const app = localApp({
      extensionRoutes: [
        {
          path: "/extension-private",
          handler: (_req, res) => {
            extensionHits += 1;
            res.json({ ok: true });
          },
        },
      ],
    });

    for (const header of [
      ["X-Forwarded-For", "203.0.113.5"],
      ["X-Forwarded-Host", "tunnel.example"],
      ["X-Forwarded-Proto", "https"],
      ["Forwarded", "for=203.0.113.5"],
      ["CF-Connecting-IP", "203.0.113.5"],
      ["CF-Ray", "abc"],
      ["True-Client-IP", "203.0.113.5"],
      ["X-Real-IP", "203.0.113.5"],
    ] as const) {
      const health = await request(app).get("/health").set(header[0], header[1]);
      assert.equal(health.status, 403, header[0]);
      assert.equal(health.body.error.code, "TUNNEL_FORBIDDEN");
    }

    const api = await request(app)
      .get("/api/status")
      .set("X-Api-Key", ADMIN_KEY)
      .set("X-Forwarded-For", "203.0.113.5");
    assert.equal(api.status, 403);

    const mcp = await mcpPost(app)
      .set("Authorization", `Bearer ${REMOTE_KEY}`)
      .set("X-Forwarded-For", "203.0.113.5")
      .send(INITIALIZE_BODY);
    assert.equal(mcp.status, 403);
    assert.equal(mcp.body.error.code, "TUNNEL_FORBIDDEN");

    const extension = await request(app)
      .get("/extension-private")
      .set("X-Forwarded-For", "203.0.113.5");
    assert.equal(extension.status, 403);
    assert.equal(extensionHits, 0);

    const directExtension = await request(app).get("/extension-private");
    assert.equal(directExtension.status, 200);
    assert.equal(extensionHits, 1);
  });

  void it("enforces loopback Host only when asked, including *.localhost", async () => {
    const open = localApp();
    const evilWhenOpen = await request(open).get("/health").set("Host", "evil.example");
    assert.equal(evilWhenOpen.status, 200);

    const guarded = localApp({ enforceLoopbackHost: true });
    for (const host of ["127.0.0.1:3939", "localhost", "foundry.localhost", "[::1]:3939"]) {
      const response = await request(guarded).get("/health").set("Host", host);
      assert.equal(response.status, 200, host);
    }
    const rejected = await request(guarded).get("/health").set("Host", "evil.example");
    assert.equal(rejected.status, 403);
    assert.equal(rejected.body.error.code, "HOST_NOT_ALLOWED");
    const lookalike = await request(guarded).get("/health").set("Host", "localhost.evil.example");
    assert.equal(lookalike.status, 403);
  });
});

void describe("public MCP listener", () => {
  void it("serves only /mcp and only the remote key, including Bearer", async () => {
    const app = publicApp();
    assert.equal(app.get("trust proxy"), false);
    assert.equal((await request(app).get("/health")).status, 404);
    assert.equal((await request(app).get("/api/status").set("X-Api-Key", ADMIN_KEY)).status, 404);
    assert.equal((await request(app).get("/bridge")).status, 404);

    const admin = await mcpPost(app)
      .set("Authorization", `Bearer ${ADMIN_KEY}`)
      .send(INITIALIZE_BODY);
    assert.equal(admin.status, 401);

    const bearer = await mcpPost(app)
      .set("Authorization", `Bearer ${REMOTE_KEY}`)
      .send(INITIALIZE_BODY);
    assert.equal(bearer.status, 200);
    assert.equal(typeof bearer.headers["mcp-session-id"], "string");

    const headerKey = await mcpPost(app).set("X-Api-Key", REMOTE_KEY).send(INITIALIZE_BODY);
    assert.equal(headerKey.status, 200);
  });

  void it("rejects WebSocket upgrades", async () => {
    const server = createPublicMcpServer({
      isDevelopment: false,
      requestLogger: () => undefined,
      remoteApiKey: REMOTE_KEY,
      corsAllowedOrigins: [],
      allowedHosts: [],
      rateLimitWindowMs: 60_000,
      rateLimitMax: 100,
      foundryClient: FAKE_CLIENT,
      integrationManager: MANAGER,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    for (const path of ["/bridge", "/mcp"]) {
      const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
        headers: { Authorization: `Bearer ${REMOTE_KEY}` },
      });
      const status = await new Promise<number>((resolve, reject) => {
        socket.once("unexpected-response", (_request, response) =>
          resolve(response.statusCode ?? 0),
        );
        socket.once("open", () => reject(new Error(`${path} upgrade was accepted`)));
        socket.once("error", () => undefined);
      });
      socket.terminate();
      assert.equal(status, 403, path);
    }
  });

  void it("rate limits by the rightmost forwarded address without trust proxy", async () => {
    const app = publicApp({ rateLimitMax: 2, rateLimitWindowMs: 60_000 });
    assert.equal(app.get("trust proxy"), false);

    const hit = (xff?: string, extra?: Record<string, string>) => {
      const req = mcpPost(app).send({});
      if (xff) req.set("X-Forwarded-For", xff);
      if (extra) {
        for (const [name, value] of Object.entries(extra)) req.set(name, value);
      }
      return req;
    };

    assert.equal((await hit()).status, 401);
    assert.equal((await hit()).status, 401);
    assert.equal((await hit()).status, 429);
    assert.equal((await hit()).body.error.code, "RATE_LIMITED");

    assert.equal(
      (
        await hit("1.1.1.1, 203.0.113.9", {
          "CF-Connecting-IP": "198.51.100.7",
          Forwarded: "for=198.51.100.8",
        })
      ).status,
      401,
    );
    assert.equal((await hit("8.8.8.8, 203.0.113.9")).status, 401);
    const limited = await hit("9.9.9.9, 203.0.113.9");
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, "RATE_LIMITED");

    assert.equal((await hit("203.0.113.10")).status, 401);
  });

  void it("applies the Host allowlist to Host and X-Forwarded-Host", async () => {
    const app = publicApp({ allowedHosts: ["foundry-mcp.example.com", "*.trycloudflare.com"] });
    const allowed = await mcpPost(app)
      .set("Host", "foundry-mcp.example.com")
      .set("Authorization", `Bearer ${REMOTE_KEY}`)
      .send({});
    assert.equal(allowed.status, 400);

    const wildcard = await request(app).get("/health").set("Host", "random-name.trycloudflare.com");
    assert.equal(wildcard.status, 404);

    const nested = await request(app).get("/health").set("Host", "a.b.trycloudflare.com");
    assert.equal(nested.status, 403);
    assert.equal(nested.body.error.code, "HOST_NOT_ALLOWED");

    const forwarded = await request(app)
      .get("/health")
      .set("Host", "foundry-mcp.example.com")
      .set("X-Forwarded-Host", "evil.example");
    assert.equal(forwarded.status, 403);
  });
});

void describe("MCP session limits", () => {
  void it("refuses initialize once the cap is reached", async () => {
    const app = localApp({ mcpMaxSessions: 1 });
    const first = await mcpPost(app).set("X-Api-Key", ADMIN_KEY).send(INITIALIZE_BODY);
    assert.equal(first.status, 200);
    const second = await mcpPost(app).set("X-Api-Key", ADMIN_KEY).send(INITIALIZE_BODY);
    assert.equal(second.status, 503);
    assert.equal(second.body.error.code, "MCP_SESSION_LIMIT");
  });

  void it("expires an idle session and then accepts a new one", async () => {
    const app = localApp({ mcpMaxSessions: 1, mcpSessionIdleMs: 100 });
    const first = await mcpPost(app).set("X-Api-Key", ADMIN_KEY).send(INITIALIZE_BODY);
    assert.equal(first.status, 200);
    const sessionId = first.headers["mcp-session-id"];
    assert.equal(typeof sessionId, "string");

    await new Promise((resolve) => setTimeout(resolve, 400));

    const stale = await mcpPost(app)
      .set("X-Api-Key", ADMIN_KEY)
      .set("Mcp-Session-Id", String(sessionId))
      .send({ jsonrpc: "2.0", id: 2, method: "ping" });
    assert.equal(stale.status, 400);

    const replacement = await mcpPost(app).set("X-Api-Key", ADMIN_KEY).send(INITIALIZE_BODY);
    assert.equal(replacement.status, 200);
  });
});
