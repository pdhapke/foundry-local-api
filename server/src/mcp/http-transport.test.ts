import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

// Keep app.ts first for the repository's pre-existing app/endpoints circular
// import ordering (see mcp-remote.ts and integrations/mcp-tools.test.ts).
import { createApp } from "../app.js";
import type { FoundryClient } from "../bridge/foundry-client.js";
import { allEndpointDescriptors } from "../endpoints/index.js";
import type { IntegrationChangeListener, IntegrationManager } from "../integrations/manager.js";
import { trailsOfDestinyIntegration } from "../integrations/trails-of-destiny/index.js";
import type { Integration } from "../integrations/types.js";

const API_KEY = "http-mcp-integration-test-key";
const FAKE_CLIENT = {
  call: (command: string, payload: unknown) =>
    Promise.resolve({ command, payload: payload ?? null, transport: "streamable-http" }),
} as unknown as FoundryClient;

class FakeIntegrationManager {
  private active: Integration[];
  private readonly listeners = new Set<IntegrationChangeListener>();

  constructor(active: Integration[]) {
    this.active = active;
  }

  getActive(): Integration[] {
    return this.active;
  }

  onChange(listener: IntegrationChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setActive(active: Integration[]): void {
    this.active = active;
    for (const listener of this.listeners) {
      listener(active);
    }
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

const trailsToolNames = trailsOfDestinyIntegration.endpoints.map(({ name }) => name).sort();

interface TestSession {
  client: Client;
  transport: StreamableHTTPClientTransport;
}

const openSessions: TestSession[] = [];
const openServers: http.Server[] = [];

afterEach(async () => {
  for (const { client } of openSessions.splice(0)) {
    await client.close().catch(() => undefined);
  }
  for (const server of openServers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function startMcpApp(manager: FakeIntegrationManager): Promise<URL> {
  const app = createApp({
    isDevelopment: false,
    requestLogger: () => undefined,
    apiKey: API_KEY,
    corsAllowedOrigins: [],
    rateLimitWindowMs: 60_000,
    rateLimitMax: 100,
    mcp: {
      foundryClient: FAKE_CLIENT,
      integrationManager: manager as unknown as IntegrationManager,
    },
  });
  const server = http.createServer(app);
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return new URL(`http://127.0.0.1:${port}/mcp`);
}

async function connectClient(url: URL, onToolsChanged: () => void): Promise<TestSession> {
  const client = new Client(
    { name: "http-transport-test", version: "1.0.0" },
    {
      listChanged: {
        tools: {
          autoRefresh: false,
          debounceMs: 0,
          onChanged: (error) => {
            assert.equal(error, null);
            onToolsChanged();
          },
        },
      },
    },
  );
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } },
  });
  const session = { client, transport };
  openSessions.push(session);
  // Same exactOptionalPropertyTypes mismatch documented for the server-side
  // Streamable transport in http-transport.ts; the SDK class implements the
  // Transport interface at runtime.
  await client.connect(transport as unknown as Transport);
  return session;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      assert.fail("Timed out waiting for asynchronous MCP notification.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

void describe("Streamable HTTP MCP integration lifecycle", () => {
  void it("snapshots, updates, and independently disposes every session", async () => {
    const manager = new FakeIntegrationManager([trailsOfDestinyIntegration]);
    const url = await startMcpApp(manager);
    let firstNotifications = 0;
    let secondNotifications = 0;
    const first = await connectClient(url, () => firstNotifications++);
    const second = await connectClient(url, () => secondNotifications++);

    assert.equal(manager.listenerCount, 2);
    const coreNames = new Set(allEndpointDescriptors.map(({ name }) => name));
    for (const session of [first, second]) {
      const names = new Set((await session.client.listTools()).tools.map(({ name }) => name));
      assert.deepEqual(
        [...names].filter((name) => name.startsWith("trails_")).sort(),
        trailsToolNames,
        "initial snapshot should include the complete real Trails catalog",
      );
      assert.deepEqual(
        [...names].filter((name) => coreNames.has(name)).sort(),
        [...coreNames].sort(),
        "the core tool catalog must remain unchanged",
      );
    }

    const callResult = await first.client.callTool({ name: "trails_get_config", arguments: {} });
    const callContent = callResult.content as Array<{ type: string; text?: string }>;
    assert.deepEqual(JSON.parse(callContent[0]?.text ?? ""), {
      command: "trails-of-destiny.get-config",
      payload: null,
      transport: "streamable-http",
    });

    manager.setActive([]);
    await waitFor(() => firstNotifications > 0 && secondNotifications > 0);
    assert.equal(
      (await first.client.listTools()).tools.some(({ name }) => name.startsWith("trails_")),
      false,
    );
    assert.equal(
      (await second.client.listTools()).tools.some(({ name }) => name.startsWith("trails_")),
      false,
    );

    await first.transport.terminateSession();
    await waitFor(() => manager.listenerCount === 1);

    manager.setActive([trailsOfDestinyIntegration]);
    await waitFor(() => secondNotifications > 1);
    assert.equal(manager.listenerCount, 1, "closed session must stay unsubscribed");
    assert.ok(
      (await second.client.listTools()).tools.some(({ name }) => name === "trails_get_config"),
      "remaining session should continue receiving activation changes",
    );

    await second.transport.terminateSession();
    await waitFor(() => manager.listenerCount === 0);
  });
});
