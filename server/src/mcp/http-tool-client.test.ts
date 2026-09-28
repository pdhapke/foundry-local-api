import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AnyEndpointDescriptor } from "../endpoints/types.js";
import { callRestEndpoint, registerHttpMcpTools } from "./http-tool-client.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

void describe("callRestEndpoint", () => {
  void it("uses the integration route base, fills path params, and sends auth", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(input);
      requestInit = init;
      return Promise.resolve(Response.json({ ok: true }));
    }) as typeof fetch;

    const descriptor: AnyEndpointDescriptor = {
      name: "trails_get_actor_sheet",
      description: "test",
      method: "get",
      path: "/trails-of-destiny/actors/:id/sheet",
      handler: () => ({ ok: true }),
    };

    const result = await callRestEndpoint(
      descriptor,
      { id: "actor / one", include: "summary" },
      { baseUrl: "http://127.0.0.1:3939", apiKey: "secret" },
      "/api/integrations",
    );

    assert.deepEqual(result, { ok: true });
    assert.equal(
      requestUrl,
      "http://127.0.0.1:3939/api/integrations/trails-of-destiny/actors/actor%20%2F%20one/sheet?include=summary",
    );
    assert.equal(new Headers(requestInit?.headers).get("x-api-key"), "secret");
  });

  void it("keeps core endpoint forwarding under /api by default", async () => {
    let requestUrl = "";
    globalThis.fetch = ((input: string | URL | Request) => {
      requestUrl = String(input);
      return Promise.resolve(Response.json({ id: "dnd5e" }));
    }) as typeof fetch;

    await callRestEndpoint(
      {
        name: "foundry_get_system",
        description: "test",
        method: "get",
        path: "/system",
        handler: () => ({ id: "dnd5e" }),
      },
      {},
      { baseUrl: "http://127.0.0.1:3939", apiKey: "secret" },
    );

    assert.equal(requestUrl, "http://127.0.0.1:3939/api/system");
  });
});

void describe("registerHttpMcpTools", () => {
  void it("enforces descriptor refinements before issuing an HTTP request", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      return Promise.resolve(Response.json({ ok: true }));
    }) as typeof fetch;
    let callback: ((args: unknown) => Promise<unknown>) | undefined;
    const server = {
      registerTool: (_name: string, _config: unknown, toolCallback: typeof callback) => {
        callback = toolCallback;
        return {};
      },
    } as unknown as McpServer;
    const descriptor: AnyEndpointDescriptor = {
      name: "foundry_refined_remote",
      description: "test",
      method: "post",
      path: "/refined",
      inputSchema: z
        .object({ family: z.enum(["Tile", "RegionBehavior"]), sceneId: z.string().optional() })
        .superRefine((input, context) => {
          if (input.family === "RegionBehavior" && !input.sceneId) {
            context.addIssue({ code: "custom", path: ["sceneId"], message: "required" });
          }
        }),
      handler: () => ({ ok: true }),
    };

    registerHttpMcpTools(server, [descriptor], {
      baseUrl: "http://127.0.0.1:3939",
      apiKey: "secret",
    });
    await assert.rejects(() => callback!({ family: "RegionBehavior" }), /required/);
    assert.equal(fetchCalls, 0);
  });
});
