// Phase 32 — unit tests for applyActiveIntegrationTools, using the same
// fake-McpServer pattern as server/src/endpoints/registry.test.ts's
// makeFakeMcpServer, extended so `registerTool`'s return value has a working
// `.remove()` (observable via the fake's own tracked `tools` map) and the
// fake McpServer exposes a `sendToolListChanged` call counter.
//
// `trackedTools` in mcp-tools.ts is module-level state shared across every
// test in this process, so each test below uses integration ids unique to
// that test to avoid cross-test interference (a fresh fake McpServer per
// test already isolates the registerTool/sendToolListChanged call counts).
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
import { applyActiveIntegrationTools } from "./mcp-tools.js";
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
  // `trackedTools` in mcp-tools.ts is shared module-level state across every
  // test in this file's process — each test below that leaves an
  // integration active cleans it back up to the empty set at the end (even
  // though that cleanup call isn't itself asserted on), so the "nothing
  // previously tracked" test isn't order-dependent on running first.
  void it("registers an active integration's tools", () => {
    const integration = makeIntegration("apply-active-1");
    const { mcpServer, tools } = makeFakeMcpServer();

    applyActiveIntegrationTools(mcpServer, [integration], FAKE_CLIENT);

    assert.ok(tools.has("apply-active-1_tool"));

    applyActiveIntegrationTools(mcpServer, [], FAKE_CLIENT); // cleanup
  });

  void it("removes previously-registered tools and calls sendToolListChanged once when applying an empty set afterward", () => {
    const integration = makeIntegration("apply-active-2");
    const { mcpServer, tools, sendToolListChangedCallCount } = makeFakeMcpServer();

    applyActiveIntegrationTools(mcpServer, [integration], FAKE_CLIENT);
    assert.ok(tools.has("apply-active-2_tool"));
    assert.equal(sendToolListChangedCallCount(), 1);

    applyActiveIntegrationTools(mcpServer, [], FAKE_CLIENT);

    assert.equal(tools.has("apply-active-2_tool"), false);
    assert.equal(sendToolListChangedCallCount(), 2);
  });

  void it("does not call sendToolListChanged or re-register tools when applying the same active set twice", () => {
    const integration = makeIntegration("apply-active-3");
    const { mcpServer, registerToolCallCount, sendToolListChangedCallCount } = makeFakeMcpServer();

    applyActiveIntegrationTools(mcpServer, [integration], FAKE_CLIENT);
    assert.equal(registerToolCallCount(), 1);
    assert.equal(sendToolListChangedCallCount(), 1);

    applyActiveIntegrationTools(mcpServer, [integration], FAKE_CLIENT);

    assert.equal(
      registerToolCallCount(),
      1,
      "should not re-register an already-tracked integration's tools",
    );
    assert.equal(sendToolListChangedCallCount(), 1, "should not notify again when nothing changed");

    applyActiveIntegrationTools(mcpServer, [], FAKE_CLIENT); // cleanup
  });

  void it("applying an empty active set with nothing previously tracked is a no-op (no notification)", () => {
    const { mcpServer, sendToolListChangedCallCount } = makeFakeMcpServer();

    applyActiveIntegrationTools(mcpServer, [], FAKE_CLIENT);

    assert.equal(sendToolListChangedCallCount(), 0);
  });
});
