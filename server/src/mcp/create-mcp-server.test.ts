import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Preserve the repository's established app/endpoints import order.
import "../app.js";
import type { FoundryClient } from "../bridge/foundry-client.js";
import { allEndpointDescriptors } from "../endpoints/index.js";
import type { AnyEndpointDescriptor } from "../endpoints/types.js";
import type { IntegrationChangeListener, IntegrationManager } from "../integrations/manager.js";
import type { Integration } from "../integrations/types.js";
import { createMcpServer } from "./create-mcp-server.js";

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
    for (const listener of this.listeners) {
      listener(active);
    }
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

const endpoint: AnyEndpointDescriptor = {
  name: "factory_optional_status",
  description: "Test-only optional integration tool.",
  handler: () => ({ active: true }),
};

const integration: Integration = {
  id: "factory-optional",
  kind: "system",
  toolPrefix: "factory_optional_",
  detect: () => true,
  endpoints: [endpoint],
};

void describe("createMcpServer integration lifecycle", () => {
  void it("gives the stdio-shared factory an initial snapshot and live subscription", async () => {
    const manager = new FakeIntegrationManager([integration]);
    const mcpServer = createMcpServer(
      {} as FoundryClient,
      manager as unknown as IntegrationManager,
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let resolveToolsChanged!: () => void;
    const toolsChanged = new Promise<void>((resolve) => {
      resolveToolsChanged = resolve;
    });
    const client = new Client(
      { name: "in-process-factory-test", version: "1.0.0" },
      {
        listChanged: {
          tools: {
            autoRefresh: false,
            debounceMs: 0,
            onChanged: (error) => {
              assert.equal(error, null);
              resolveToolsChanged();
            },
          },
        },
      },
    );

    try {
      await mcpServer.connect(serverTransport);
      await client.connect(clientTransport);
      assert.equal(manager.listenerCount, 1);

      const initialNames = new Set((await client.listTools()).tools.map(({ name }) => name));
      assert.ok(initialNames.has(endpoint.name));
      assert.deepEqual(
        [...initialNames]
          .filter((name) => allEndpointDescriptors.some((descriptor) => descriptor.name === name))
          .sort(),
        allEndpointDescriptors.map(({ name }) => name).sort(),
      );

      manager.setActive([]);
      await toolsChanged;
      assert.equal(
        (await client.listTools()).tools.some(({ name }) => name === endpoint.name),
        false,
      );
    } finally {
      await client.close();
    }

    assert.equal(manager.listenerCount, 0, "closing the transport must unsubscribe the server");
  });
});
