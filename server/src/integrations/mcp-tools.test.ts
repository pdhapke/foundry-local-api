// Phase 32 — unit tests for applyActiveIntegrationTools, using the same
// fake-McpServer pattern as server/src/endpoints/registry.test.ts's
// makeFakeMcpServer, extended so `registerTool`'s return value has a working
// `.remove()` (observable via the fake's own tracked `tools` map) and the
// fake McpServer exposes a `sendToolListChanged` call counter.
//
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";

// Side-effect-only import, and deliberately first — same pre-existing
// circular-import workaround as server/src/integrations/router.test.ts (see
// its comment for the full chain): `./mcp-tools.js` (below) transitively
// imports `../endpoints/registry.js` -> `../bridge/errors.js` -> `../app.js`,
// so `../app.js` needs to finish evaluating first.
import "../app.js";
import type { FoundryClient } from "../bridge/foundry-client.js";
import type { AnyEndpointDescriptor } from "../endpoints/types.js";
import type { IntegrationManager } from "./manager.js";
import {
  applyActiveIntegrationTools,
  bindActiveIntegrationTools,
  cleanupActiveIntegrationTools,
} from "./mcp-tools.js";
import { trailsOfDestinyIntegration } from "./trails-of-destiny/index.js";
import type { Integration } from "./types.js";

const FAKE_CLIENT = {} as unknown as FoundryClient;

function makeFakeMcpServer(): {
  mcpServer: McpServer;
  tools: Map<string, unknown>;
  registerToolCallCount: () => number;
  sendToolListChangedCallCount: () => number;
} {
  const tools = new Map<string, unknown>();
  let registerToolCalls = 0;
  let sendToolListChangedCalls = 0;
  const fake = {
    registerTool: (name: string, config: unknown, callback: unknown): RegisteredTool => {
      registerToolCalls++;
      tools.set(name, { config, callback });
      return {
        remove: () => tools.delete(name),
      } as unknown as RegisteredTool;
    },
    sendToolListChanged: () => {
      sendToolListChangedCalls++;
    },
  };
  return {
    mcpServer: fake as unknown as McpServer,
    tools,
    registerToolCallCount: () => registerToolCalls,
    sendToolListChangedCallCount: () => sendToolListChangedCalls,
  };
}

function makeIntegration(id: string): Integration {
  const endpoint: AnyEndpointDescriptor = {
    name: `${id}_tool`,
    description: "test",
    handler: () => ({ ok: true }),
  };
  return { id, kind: "system", detect: () => true, endpoints: [endpoint] };
}

void describe("applyActiveIntegrationTools", () => {
  void it("registers the initial snapshot without notifying", () => {
    const integration = makeIntegration("apply-active-1");
    const { mcpServer, tools, sendToolListChangedCallCount } = makeFakeMcpServer();

    applyActiveIntegrationTools(mcpServer, [integration], FAKE_CLIENT);

    assert.ok(tools.has("apply-active-1_tool"));
    assert.equal(sendToolListChangedCallCount(), 0);
  });

  void it("removes tools and sends exactly one notification for a post-initialization change", () => {
    const integration = makeIntegration("apply-active-2");
    const { mcpServer, tools, sendToolListChangedCallCount } = makeFakeMcpServer();

    applyActiveIntegrationTools(mcpServer, [integration], FAKE_CLIENT);
    assert.ok(tools.has("apply-active-2_tool"));
    assert.equal(sendToolListChangedCallCount(), 0);

    applyActiveIntegrationTools(mcpServer, [], FAKE_CLIENT);

    assert.equal(tools.has("apply-active-2_tool"), false);
    assert.equal(sendToolListChangedCallCount(), 1);
  });

  void it("does not call sendToolListChanged or re-register tools when applying the same active set twice", () => {
    const integration = makeIntegration("apply-active-3");
    const { mcpServer, registerToolCallCount, sendToolListChangedCallCount } = makeFakeMcpServer();

    applyActiveIntegrationTools(mcpServer, [integration], FAKE_CLIENT);
    assert.equal(registerToolCallCount(), 1);
    assert.equal(sendToolListChangedCallCount(), 0);

    applyActiveIntegrationTools(mcpServer, [integration], FAKE_CLIENT);

    assert.equal(
      registerToolCallCount(),
      1,
      "should not re-register an already-tracked integration's tools",
    );
    assert.equal(sendToolListChangedCallCount(), 0, "should not notify when nothing changed");
  });

  void it("applying an empty active set with nothing previously tracked is a no-op (no notification)", () => {
    const { mcpServer, sendToolListChangedCallCount } = makeFakeMcpServer();

    applyActiveIntegrationTools(mcpServer, [], FAKE_CLIENT);

    assert.equal(sendToolListChangedCallCount(), 0);
  });

  void it("omits every registered trails_* tool while the Trails system is inactive", () => {
    const { mcpServer, tools, registerToolCallCount } = makeFakeMcpServer();

    applyActiveIntegrationTools(mcpServer, [], FAKE_CLIENT);

    const trailsToolNames = trailsOfDestinyIntegration.endpoints.map((endpoint) => endpoint.name);
    assert.equal(trailsToolNames.length, 13);
    assert.ok(trailsToolNames.every((name) => name.startsWith("trails_")));
    assert.ok(trailsToolNames.every((name) => !tools.has(name)));
    assert.equal(registerToolCallCount(), 0);
  });

  void it("registers and removes the real 13-tool trails_* catalog with one notification", () => {
    const fake = makeFakeMcpServer();
    const expectedNames = trailsOfDestinyIntegration.endpoints.map(({ name }) => name).sort();

    applyActiveIntegrationTools(fake.mcpServer, [trailsOfDestinyIntegration], FAKE_CLIENT);
    assert.deepEqual([...fake.tools.keys()].sort(), expectedNames);
    assert.ok(expectedNames.every((name) => name.startsWith("trails_")));
    assert.equal(fake.sendToolListChangedCallCount(), 0);

    applyActiveIntegrationTools(fake.mcpServer, [], FAKE_CLIENT);
    assert.equal(fake.tools.size, 0);
    assert.equal(fake.sendToolListChangedCallCount(), 1);
  });

  void it("tracks the same integration independently on two MCP servers", () => {
    const integration = makeIntegration("shared");
    const first = makeFakeMcpServer();
    const second = makeFakeMcpServer();

    applyActiveIntegrationTools(first.mcpServer, [integration], FAKE_CLIENT);
    applyActiveIntegrationTools(second.mcpServer, [integration], FAKE_CLIENT);

    assert.ok(first.tools.has("shared_tool"));
    assert.ok(second.tools.has("shared_tool"));
    assert.equal(first.registerToolCallCount(), 1);
    assert.equal(second.registerToolCallCount(), 1);

    applyActiveIntegrationTools(first.mcpServer, [], FAKE_CLIENT);

    assert.equal(first.tools.has("shared_tool"), false);
    assert.ok(second.tools.has("shared_tool"));
    assert.equal(first.sendToolListChangedCallCount(), 1);
    assert.equal(second.sendToolListChangedCallCount(), 0);
  });

  void it("cleanup removes only the target server's dynamic tools", () => {
    const integration = makeIntegration("cleanup");
    const first = makeFakeMcpServer();
    const second = makeFakeMcpServer();
    applyActiveIntegrationTools(first.mcpServer, [integration], FAKE_CLIENT);
    applyActiveIntegrationTools(second.mcpServer, [integration], FAKE_CLIENT);

    cleanupActiveIntegrationTools(first.mcpServer);

    assert.equal(first.tools.size, 0);
    assert.ok(second.tools.has("cleanup_tool"));
    assert.equal(first.sendToolListChangedCallCount(), 0);
    assert.equal(second.sendToolListChangedCallCount(), 0);
  });

  void it("bind initializes, synchronizes real changes, and disposes its subscription", () => {
    const integration = makeIntegration("bound");
    let active = [integration];
    let listener: ((next: Integration[]) => void) | undefined;
    let unsubscribeCalls = 0;
    const manager = {
      getActive: () => active,
      onChange: (nextListener: (next: Integration[]) => void) => {
        listener = nextListener;
        return () => {
          unsubscribeCalls++;
          listener = undefined;
        };
      },
    } as unknown as IntegrationManager;
    const fake = makeFakeMcpServer();

    const dispose = bindActiveIntegrationTools(fake.mcpServer, manager, FAKE_CLIENT);
    assert.ok(fake.tools.has("bound_tool"));
    assert.equal(fake.sendToolListChangedCallCount(), 0);

    active = [];
    listener?.(active);
    assert.equal(fake.tools.size, 0);
    assert.equal(fake.sendToolListChangedCallCount(), 1);

    dispose();
    assert.equal(unsubscribeCalls, 1);
    assert.equal(fake.tools.size, 0);
  });
});
