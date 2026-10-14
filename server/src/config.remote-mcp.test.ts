import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConfigError, loadConfig } from "./config.js";

const ENV_KEYS = [
  "API_KEY",
  "PORT",
  "HOST",
  "MCP_REMOTE_API_KEY",
  "MCP_PUBLIC_PORT",
  "MCP_ALLOWED_HOSTS",
  "MCP_REMOTE_RATE_LIMIT_WINDOW_MS",
  "MCP_REMOTE_RATE_LIMIT_MAX",
  "MCP_MAX_SESSIONS",
  "MCP_SESSION_IDLE_MS",
  "ALLOW_REMOTE_BIND",
] as const;

function withEnv(values: Record<string, string | undefined>, run: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const ADMIN = "admin-api-key-0123456789abcdef";
const REMOTE = "remote-mcp-key-0123456789abcdef";

void describe("remote MCP configuration", { concurrency: 1 }, () => {
  void it("leaves the public listener off unless a distinct remote key is set", () => {
    withEnv({ API_KEY: ADMIN }, () => {
      const config = loadConfig();
      assert.equal(config.mcpRemote, null);
      assert.equal(config.enforceLoopbackHost, false);
      assert.deepEqual(config.mcpAllowedHosts, []);
      assert.equal(config.mcpMaxSessions, 0);
      assert.equal(config.mcpSessionIdleMs, 0);
    });

    withEnv(
      { API_KEY: ADMIN, MCP_ALLOWED_HOSTS: "*.TryCloudflare.com, foundry-mcp.example.com" },
      () => {
        const config = loadConfig();
        assert.equal(config.mcpRemote, null);
        assert.equal(config.enforceLoopbackHost, true);
        assert.deepEqual(config.mcpAllowedHosts, [
          "*.trycloudflare.com",
          "foundry-mcp.example.com",
        ]);
      },
    );

    withEnv({ API_KEY: ADMIN, MCP_REMOTE_API_KEY: REMOTE }, () => {
      const config = loadConfig();
      assert.ok(config.mcpRemote);
      assert.equal(config.mcpRemote?.apiKey, REMOTE);
      assert.equal(config.mcpRemote?.port, 3945);
      assert.equal(config.mcpRemote?.rateLimitWindowMs, 60_000);
      assert.equal(config.mcpRemote?.rateLimitMax, 120);
      assert.equal(config.enforceLoopbackHost, true);
      assert.equal(config.apiKey, ADMIN);
    });
  });

  void it("rejects a remote key that reuses or weakens the admin key, and a colliding port", () => {
    const secret = "remote-secret-value-should-stay-out-of-the-message";
    withEnv({ API_KEY: secret, MCP_REMOTE_API_KEY: secret }, () => {
      assert.throws(
        () => loadConfig(),
        (error: unknown) => {
          assert.ok(error instanceof ConfigError);
          assert.equal(error.message.includes(secret), false);
          assert.match(error.message, /MCP_REMOTE_API_KEY must be different from API_KEY/);
          return true;
        },
      );
    });

    withEnv({ API_KEY: ADMIN, MCP_REMOTE_API_KEY: "short-key" }, () => {
      assert.throws(() => loadConfig(), /MCP_REMOTE_API_KEY is too short/);
    });

    withEnv(
      { API_KEY: ADMIN, PORT: "3939", MCP_REMOTE_API_KEY: REMOTE, MCP_PUBLIC_PORT: "3939" },
      () => {
        assert.throws(() => loadConfig(), /must be different from PORT/);
      },
    );

    withEnv({ API_KEY: ADMIN, MCP_PUBLIC_PORT: "nope" }, () => {
      assert.throws(() => loadConfig(), /Invalid MCP_PUBLIC_PORT/);
    });

    withEnv({ API_KEY: ADMIN, MCP_ALLOWED_HOSTS: "https://evil.example" }, () => {
      assert.throws(() => loadConfig(), /Invalid MCP_ALLOWED_HOSTS/);
    });

    withEnv({ API_KEY: ADMIN, MCP_MAX_SESSIONS: "0" }, () => {
      assert.throws(() => loadConfig(), /MCP_MAX_SESSIONS/);
    });

    withEnv(
      {
        API_KEY: ADMIN,
        MCP_REMOTE_API_KEY: REMOTE,
        MCP_PUBLIC_PORT: "3950",
        MCP_REMOTE_RATE_LIMIT_MAX: "30",
        MCP_MAX_SESSIONS: "4",
        MCP_SESSION_IDLE_MS: "5000",
      },
      () => {
        const config = loadConfig();
        assert.equal(config.mcpRemote?.port, 3950);
        assert.equal(config.mcpRemote?.rateLimitMax, 30);
        assert.equal(config.mcpMaxSessions, 4);
        assert.equal(config.mcpSessionIdleMs, 5000);
      },
    );
  });
});
