import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";

// Preserve the established import order around the endpoint/app cycle.
import "../app.js";
import { trailsOfDestinyIntegration } from "../integrations/trails-of-destiny/index.js";
import { bindHttpIntegrationTools } from "./create-http-mcp-server.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeFakeMcpServer(): {
  server: McpServer;
  tools: Map<string, { callback: (args: Record<string, unknown>) => Promise<unknown> }>;
  notifications: () => number;
} {
  const tools = new Map<
    string,
    { callback: (args: Record<string, unknown>) => Promise<unknown> }
  >();
  let notificationCount = 0;
  const server = {
    registerTool: (
      name: string,
      _config: unknown,
      callback: (args: Record<string, unknown>) => Promise<unknown>,
    ): RegisteredTool => {
      tools.set(name, { callback });
      return { remove: () => tools.delete(name) } as unknown as RegisteredTool;
    },
    sendToolListChanged: () => {
      notificationCount++;
    },
  } as unknown as McpServer;
  return { server, tools, notifications: () => notificationCount };
}

void describe("bindHttpIntegrationTools", () => {
  void it("discovers with auth, forwards integration calls, diffs snapshots, and retains the last good catalog on errors", async () => {
    let systemId = "trails-of-destiny";
    let systemVersion = "0.1.0";
    let failDiscovery = false;
    const seen: Array<{ url: string; apiKey: string | null }> = [];
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, apiKey: new Headers(init?.headers).get("x-api-key") });
      if (failDiscovery && (url.endsWith("/api/system") || url.endsWith("/api/modules"))) {
        return Promise.reject(new Error("temporary outage"));
      }
      if (url.endsWith("/api/system")) {
        return Promise.resolve(
          Response.json({ id: systemId, title: "System", version: systemVersion }),
        );
      }
      if (url.endsWith("/api/modules")) return Promise.resolve(Response.json([]));
      if (url.endsWith("/api/integrations/trails-of-destiny/config")) {
        return Promise.resolve(Response.json({ packageVersion: "0.1.0" }));
      }
      return Promise.resolve(Response.json({ error: { message: "not found" } }, { status: 404 }));
    }) as typeof fetch;

    const fake = makeFakeMcpServer();
    const binding = await bindHttpIntegrationTools(fake.server, {
      baseUrl: "http://127.0.0.1:3939",
      apiKey: "secret",
      integrations: [trailsOfDestinyIntegration],
      pollIntervalMs: false,
    });

    const expectedNames = trailsOfDestinyIntegration.endpoints.map(({ name }) => name).sort();
    assert.deepEqual([...fake.tools.keys()].sort(), expectedNames);
    assert.ok(expectedNames.every((name) => name.startsWith("trails_")));
    assert.equal(fake.notifications(), 0);
    assert.ok(
      seen
        .filter(
          (request) => request.url.includes("/api/system") || request.url.includes("/api/modules"),
        )
        .every((request) => request.apiKey === "secret"),
    );

    await fake.tools.get("trails_get_config")?.callback({});
    assert.ok(
      seen.some(
        (request) =>
          request.url === "http://127.0.0.1:3939/api/integrations/trails-of-destiny/config",
      ),
    );

    failDiscovery = true;
    await assert.rejects(binding.refresh(), /temporary outage/);
    assert.ok(fake.tools.has("trails_get_config"), "transient failure must retain tools");
    assert.equal(fake.notifications(), 0);

    failDiscovery = false;
    systemVersion = "0.0.9";
    await binding.refresh();
    assert.equal(fake.tools.size, 0, "a Trails system below 0.1.0 must deactivate");
    assert.equal(fake.notifications(), 1);

    systemVersion = "0.1.1";
    await binding.refresh();
    assert.deepEqual([...fake.tools.keys()].sort(), expectedNames);
    assert.equal(fake.notifications(), 2);

    systemId = "trails";
    await binding.refresh();
    assert.equal(fake.tools.size, 0, "a similar but inexact system id must deactivate");
    assert.equal(fake.notifications(), 3);

    binding.dispose();
    assert.equal(fake.tools.size, 0);
    assert.equal(await binding.refresh(), false);
  });

  void it("stops its poll timer on disposal", async () => {
    let discoveryCalls = 0;
    globalThis.fetch = ((input: string | URL | Request) => {
      discoveryCalls++;
      const url = String(input);
      return Promise.resolve(
        Response.json(
          url.endsWith("/api/system") ? { id: "other", title: "Other", version: "1.0.0" } : [],
        ),
      );
    }) as typeof fetch;

    const fake = makeFakeMcpServer();
    const binding = await bindHttpIntegrationTools(fake.server, {
      baseUrl: "http://127.0.0.1:3939",
      apiKey: "secret",
      integrations: [trailsOfDestinyIntegration],
      pollIntervalMs: 10,
    });
    binding.dispose();
    const callsAtDispose = discoveryCalls;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(discoveryCalls, callsAtDispose);
  });
});
