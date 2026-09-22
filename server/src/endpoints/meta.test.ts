// Integration test for the Phase 6 core meta/introspection endpoints —
// this is the template PLAN.md's Phase 6 says every later phase copies.
//
// Builds a real Express app via createApp() and swaps in a fake
// FoundryClient on `app.locals["foundryClient"]` (exactly how
// server/src/index.ts wires the real one), then drives it with supertest.
// No real WebSocket/bridge/Foundry instance is involved.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import request from "supertest";

import type {
  ModuleInfo,
  SettingInfo,
  StatusResult,
  SystemInfo,
  UserInfo,
  WorldInfo,
} from "@foundry-local-api/shared";

import { createApp } from "../app.js";
import { FoundryBridgeError } from "../bridge/errors.js";
import type { FoundryClient } from "../bridge/foundry-client.js";
import { API_KEY_HEADER } from "../middleware/auth.js";

const API_KEY = "test-api-key-0123456789abcdef";

const FIXTURES: {
  status: StatusResult;
  world: WorldInfo;
  system: SystemInfo;
  user: UserInfo;
  users: UserInfo[];
  modules: ModuleInfo[];
  settings: SettingInfo[];
} = {
  status: { foundryVersion: "12.331", worldId: "my-world", systemId: "dnd5e", userId: "user1" },
  world: {
    id: "my-world",
    title: "My World",
    description: "A test world",
    system: "dnd5e",
    background: null,
  },
  system: { id: "dnd5e", title: "Dungeons & Dragons Fifth Edition", version: "3.3.1" },
  user: { id: "user1", name: "Gamemaster", role: 4, isGM: true, active: true },
  users: [
    { id: "user1", name: "Gamemaster", role: 4, isGM: true, active: true },
    { id: "user2", name: "Player One", role: 1, isGM: false, active: false },
  ],
  modules: [{ id: "foundry-local-api", title: "Foundry Local API", active: true, version: "0.0.1" }],
  settings: [
    {
      namespace: "core",
      key: "someSetting",
      name: "Some Setting",
      hint: null,
      scope: "world",
      config: true,
      typeName: "Boolean",
    },
  ],
};

/** Maps each REST path to the bridge command `type` it should trigger. */
const ENDPOINTS: { path: string; command: keyof typeof FIXTURES }[] = [
  { path: "/api/status", command: "status" },
  { path: "/api/world", command: "world" },
  { path: "/api/system", command: "system" },
  { path: "/api/user", command: "user" },
  { path: "/api/users", command: "users" },
  { path: "/api/modules", command: "modules" },
  { path: "/api/settings", command: "settings" },
];

function buildApp(call: FoundryClient["call"]) {
  const app = createApp({
    isDevelopment: false,
    apiKey: API_KEY,
    corsAllowedOrigins: [],
    rateLimitWindowMs: 60_000,
    rateLimitMax: 1000,
    requestLogger: () => {
      /* silence request logging in tests */
    },
  });
  const fakeFoundryClient = { call } as unknown as FoundryClient;
  app.locals["foundryClient"] = fakeFoundryClient;
  return app;
}

void describe("Phase 6 meta/introspection endpoints", () => {
  after(() => {
    // Nothing to tear down (no real server/socket was opened), kept for
    // symmetry with the shape later phases' integration tests will need
    // once they involve real timers/handles.
  });

  for (const { path, command } of ENDPOINTS) {
    void it(`GET ${path} returns 200 with the bridge result`, async () => {
      const app = buildApp(((type: string) => {
        assert.equal(type, command);
        return Promise.resolve(FIXTURES[command]);
      }) as FoundryClient["call"]);

      const res = await request(app).get(path).set(API_KEY_HEADER, API_KEY);

      assert.equal(res.status, 200);
      assert.deepEqual(res.body, FIXTURES[command]);
    });
  }

  void it("propagates a FoundryBridgeError as a normalized HTTP error (NOT_CONNECTED -> 503)", async () => {
    const app = buildApp((() =>
      Promise.reject(
        new FoundryBridgeError("NOT_CONNECTED", "No Foundry client is currently connected to the bridge."),
      )) as FoundryClient["call"]);

    const res = await request(app).get("/api/world").set(API_KEY_HEADER, API_KEY);

    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, "NOT_CONNECTED");
  });

  void it("rejects a request with a missing/incorrect API key with 401", async () => {
    const app = buildApp((() => Promise.resolve(FIXTURES.status)) as FoundryClient["call"]);

    const noKey = await request(app).get("/api/status");
    assert.equal(noKey.status, 401);

    const wrongKey = await request(app).get("/api/status").set(API_KEY_HEADER, "wrong-key");
    assert.equal(wrongKey.status, 401);
  });
});
