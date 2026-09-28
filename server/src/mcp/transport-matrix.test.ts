import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

// Preserve the repository's established app/endpoints import order.
import { createApp } from "../app.js";
import type { FoundryClient } from "../bridge/foundry-client.js";
import type { IntegrationChangeListener, IntegrationManager } from "../integrations/manager.js";
import { trailsOfDestinyIntegration } from "../integrations/trails-of-destiny/index.js";
import type { Integration } from "../integrations/types.js";
import { bindHttpIntegrationTools, createHttpMcpServer } from "./create-http-mcp-server.js";
import { createMcpServer } from "./create-mcp-server.js";

const API_KEY = "transport-matrix-test-key";
const TOOL_NAME = "trails_get_config";
const DIRECT_RESULT = {
  command: "trails-of-destiny.get-config",
  payload: null,
  source: "bridge",
};
const REMOTE_RESULT = { source: "remote-http" };
const TRAILS_TOOL_NAMES = trailsOfDestinyIntegration.endpoints.map(({ name }) => name).sort();
const RESOURCE_SNAPSHOT = {
  durability: { value: 1, max: 2 },
  health: { value: 1, max: 2 },
  vigor: { value: 1, max: 2 },
  mana: { value: 1, max: 2 },
  energy: { value: 1, max: 2 },
};
const TRAILS_TOOL_ARGUMENTS: Record<string, Record<string, unknown>> = {
  trails_get_config: {},
  trails_get_actor_sheet: { id: "actor-1" },
  trails_get_actor_inventory: { id: "actor-1" },
  trails_list_catalogs: {},
  trails_get_catalog: { packId: "trails-of-destiny.character-options" },
  trails_evaluate_creation: { id: "actor-1" },
  trails_roll_action: {
    kind: "action",
    abilityId: "agi",
    skillId: "",
    abilityDice: 1,
    skillDice: 0,
    otherDice: 0,
    abilityChallenges: 0,
    challenges: 0,
    chances: 0,
    charges: 0,
    conditionalDice: [],
  },
  trails_preview_initiative: {
    participants: [{ id: "actor-1", bonusDice: 0, challenges: 0, charges: 0, sources: [] }],
  },
  trails_preview_threat_contest: {
    classification: "attack",
    actionTotal: 1,
    passiveDefense: 1,
  },
  trails_preview_damage: { durability: 2, health: 2, damage: 1 },
  trails_preview_recovery: {
    kind: "break",
    resources: RESOURCE_SNAPSHOT,
    eligibility: {
      durability: true,
      health: true,
      vigor: true,
      mana: true,
      energy: true,
    },
  },
  trails_get_experience_progress: { totalExperience: 42 },
  trails_preview_builder: { raw: "{}" },
};

class FakeIntegrationManager {
  private readonly listeners = new Set<IntegrationChangeListener>();

  constructor(private active: Integration[]) {}

  getActive(): Integration[] {
    return this.active;
  }

  onChange(listener: IntegrationChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setActive(active: Integration[]): void {
    this.active = active;
    for (const listener of this.listeners) listener(active);
  }
}

function makeClient(name: string, onToolsChanged: () => void): Client {
  return new Client(
    { name, version: "1.0.0" },
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
}

async function assertPresentAndCallable(
  client: Client,
  expectedSource: "bridge" | "remote-http",
): Promise<string[]> {
  const names = (await client.listTools()).tools
    .map(({ name }) => name)
    .filter((name) => name.startsWith("trails_"))
    .sort();
  assert.deepEqual(names, TRAILS_TOOL_NAMES);
  for (const name of TRAILS_TOOL_NAMES) {
    const result = await client.callTool({
      name,
      arguments: TRAILS_TOOL_ARGUMENTS[name] ?? assert.fail(`missing arguments for ${name}`),
    });
    const content = result.content as Array<{ type: string; text?: string }>;
    assert.equal(result.isError, undefined, name);
    assert.equal(content[0]?.type, "text", name);
    const parsed = JSON.parse(content[0]?.text ?? "") as { source?: string };
    assert.equal(parsed.source, expectedSource, name);
    if (name === TOOL_NAME && expectedSource === "bridge") {
      assert.deepEqual(parsed, DIRECT_RESULT);
    }
    if (name === TOOL_NAME && expectedSource === "remote-http") {
      assert.deepEqual(parsed, REMOTE_RESULT);
    }
  }
  return names;
}

async function assertAbsent(client: Client): Promise<void> {
  assert.equal(
    (await client.listTools()).tools.some(({ name }) => name.startsWith("trails_")),
    false,
  );
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail("Timed out waiting for tools/list_changed.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

void describe("optional integration MCP transport matrix", () => {
  void it("lists, calls, and removes the same real Trails catalog over in-process, Streamable HTTP, and remote forwarding", async () => {
    const foundryClient = {
      call: (command: string, payload: unknown) =>
        Promise.resolve({ command, payload: payload ?? null, source: "bridge" }),
    } as unknown as FoundryClient;
    const listedCatalogs: string[][] = [];

    // In-process registration (the same factory used by MCP_STDIO=true).
    const inProcessManager = new FakeIntegrationManager([trailsOfDestinyIntegration]);
    const inProcessServer = createMcpServer(
      foundryClient,
      inProcessManager as unknown as IntegrationManager,
    );
    const [inProcessClientTransport, inProcessServerTransport] =
      InMemoryTransport.createLinkedPair();
    const inProcessClient = makeClient("transport-matrix-in-process", () => undefined);
    await inProcessServer.connect(inProcessServerTransport);
    await inProcessClient.connect(inProcessClientTransport);

    try {
      listedCatalogs.push(await assertPresentAndCallable(inProcessClient, "bridge"));
      inProcessManager.setActive([]);
      await assertAbsent(inProcessClient);
    } finally {
      await inProcessClient.close();
    }

    // A real Streamable HTTP session mounted by createApp().
    const httpManager = new FakeIntegrationManager([trailsOfDestinyIntegration]);
    const app = createApp({
      isDevelopment: false,
      requestLogger: () => undefined,
      apiKey: API_KEY,
      corsAllowedOrigins: [],
      rateLimitWindowMs: 60_000,
      rateLimitMax: 100,
      mcp: {
        foundryClient,
        integrationManager: httpManager as unknown as IntegrationManager,
      },
    });
    const httpServer = http.createServer(app);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const { port } = httpServer.address() as AddressInfo;
    const httpTransport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } } },
    );
    let httpNotifications = 0;
    const httpClient = makeClient("transport-matrix-http", () => httpNotifications++);

    try {
      await httpClient.connect(httpTransport as unknown as Transport);
      listedCatalogs.push(await assertPresentAndCallable(httpClient, "bridge"));
      httpManager.setActive([]);
      await waitFor(() => httpNotifications > 0);
      await assertAbsent(httpClient);
      await httpTransport.terminateSession();
    } finally {
      await httpClient.close().catch(() => undefined);
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }

    // Remote stdio forwarding: discovery and invocation both cross the
    // authenticated REST boundary before returning through a real MCP client.
    const originalFetch = globalThis.fetch;
    let remoteActive = true;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      assert.equal(new Headers(init?.headers).get("x-api-key"), API_KEY);
      if (url.endsWith("/api/system")) {
        return Promise.resolve(
          Response.json({
            id: remoteActive ? "trails-of-destiny" : "other-system",
            title: "Test System",
            version: "0.1.0",
          }),
        );
      }
      if (url.endsWith("/api/modules")) return Promise.resolve(Response.json([]));
      if (url.includes("/api/integrations/trails-of-destiny/")) {
        return Promise.resolve(Response.json(REMOTE_RESULT));
      }
      return Promise.resolve(Response.json({ error: { message: "not found" } }, { status: 404 }));
    }) as typeof fetch;

    const remoteServer = createHttpMcpServer({ baseUrl: "http://remote.test", apiKey: API_KEY });
    const remoteBinding = await bindHttpIntegrationTools(remoteServer, {
      baseUrl: "http://remote.test",
      apiKey: API_KEY,
      integrations: [trailsOfDestinyIntegration],
      pollIntervalMs: false,
    });
    const [remoteClientTransport, remoteServerTransport] = InMemoryTransport.createLinkedPair();
    const remoteClient = makeClient("transport-matrix-remote", () => undefined);

    try {
      await remoteServer.connect(remoteServerTransport);
      await remoteClient.connect(remoteClientTransport);
      listedCatalogs.push(await assertPresentAndCallable(remoteClient, "remote-http"));
      assert.deepEqual(listedCatalogs, [TRAILS_TOOL_NAMES, TRAILS_TOOL_NAMES, TRAILS_TOOL_NAMES]);
      remoteActive = false;
      await remoteBinding.refresh();
      await assertAbsent(remoteClient);
    } finally {
      remoteBinding.dispose();
      await remoteClient.close().catch(() => undefined);
      globalThis.fetch = originalFetch;
    }
  });
});
