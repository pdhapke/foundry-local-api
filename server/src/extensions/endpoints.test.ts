import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { ProtocolError } from "@foundry-local-api/shared";
import type { AnyEndpointDescriptor } from "../endpoints/types.js";
import type { FoundryClient } from "../bridge/foundry-client.js";
import { createApp } from "../app.js";
import { ExtensionEndpointRegistry, extensionEndpoints } from "./endpoints.js";

void test("extension endpoints keep administrative auth and unregister REST tools", async () => {
  const app = createApp({
    apiKey: "synthetic-extension-key",
    isDevelopment: false,
    corsAllowedOrigins: [],
    rateLimitWindowMs: 60000,
    rateLimitMax: 10,
    requestLogger: () => undefined,
  });
  const dispose = extensionEndpoints.register([
    {
      name: "fixture_extension_read",
      path: "/fixture-extension",
      method: "get",
      description: "Fixture only",
      handler: () => ({ ok: true }),
    },
  ]);
  try {
    await request(app).get("/api/fixture-extension").expect(401);
    await request(app)
      .get("/api/fixture-extension")
      .set("x-api-key", "synthetic-extension-key")
      .expect(200, { ok: true });
    assert.throws(() =>
      extensionEndpoints.register([
        { name: "fixture_extension_read", description: "collision", handler: () => ({}) },
      ]),
    );
    assert.throws(() =>
      extensionEndpoints.register([
        { name: "foundry_get_world", description: "core collision", handler: () => ({}) },
      ]),
    );
    dispose();
    await request(app)
      .get("/api/fixture-extension")
      .set("x-api-key", "synthetic-extension-key")
      .expect(404);
  } finally {
    dispose();
  }
});

void test("extension REST accepts delivery named parameters while rejecting route patterns", async () => {
  const app = createApp({
    apiKey: "synthetic-param-key",
    isDevelopment: false,
    corsAllowedOrigins: [],
    rateLimitWindowMs: 60000,
    rateLimitMax: 20,
    requestLogger: () => undefined,
  });
  const dispose = extensionEndpoints.register([
    {
      name: "fixture_extension_delivery",
      description: "Fixture delivery",
      method: "get",
      path: "/ai-gm/deliveries/:deliveryId",
      inputSchema: z.object({ deliveryId: z.string() }).strict(),
      handler: (input: { deliveryId: string }) => ({ deliveryId: input.deliveryId }),
    },
  ]);
  try {
    await request(app).get("/api/ai-gm/deliveries/synthetic-delivery").expect(401);
    await request(app)
      .get("/api/ai-gm/deliveries/synthetic-delivery")
      .set("x-api-key", "synthetic-param-key")
      .expect(200, { deliveryId: "synthetic-delivery" });
    for (const path of [
      "/fixture/*wildcard",
      "/fixture/{optional}",
      "/fixture/:id?",
      "/fixture/:id(.*)",
      "/fixture//empty",
      "/fixture/:id/:id",
      "/fixture/:0id",
      "/fixture/" + "x".repeat(129),
    ]) {
      assert.throws(() =>
        extensionEndpoints.register([
          {
            name: "fixture_invalid_path",
            description: "Invalid",
            method: "get",
            path,
            handler: () => ({}),
          },
        ]),
      );
    }
    dispose();
    await request(app)
      .get("/api/ai-gm/deliveries/synthetic-delivery")
      .set("x-api-key", "synthetic-param-key")
      .expect(404);
  } finally {
    dispose();
  }
});

void test("synchronous extension protocol errors receive the same REST normalization as promises", async () => {
  const app = createApp({
    apiKey: "synthetic-error-key",
    isDevelopment: false,
    corsAllowedOrigins: [],
    rateLimitWindowMs: 60000,
    rateLimitMax: 10,
    requestLogger: () => undefined,
  });
  const dispose = extensionEndpoints.register([
    {
      name: "fixture_extension_missing_delivery",
      description: "Fixture missing delivery",
      method: "get",
      path: "/fixture-deliveries/:deliveryId",
      inputSchema: z.object({ deliveryId: z.string() }).strict(),
      handler: () => {
        throw new ProtocolError({
          code: "NOT_FOUND",
          message: "Fixture delivery was not found.",
          retryable: false,
          fieldPath: "deliveryId",
        });
      },
    },
  ]);
  try {
    const response = await request(app)
      .get("/api/fixture-deliveries/missing")
      .set("x-api-key", "synthetic-error-key")
      .expect(404);
    assert.equal(response.body.error.code, "NOT_FOUND");
    assert.equal(response.body.error.fieldPath, "deliveryId");
    assert.equal(response.body.error.retryable, false);
  } finally {
    dispose();
  }
});
void test("extension MCP tools update and revoke on already connected sessions", async () => {
  const registry = new ExtensionEndpointRegistry();
  const server = new McpServer({ name: "extension-fixture", version: "1" });
  const disposeGroup = registry.register([
    { name: "fixture_extension_mcp", description: "Fixture only", handler: () => ({ ok: true }) },
  ]);
  const unbind = registry.bindMcp(server, {} as FoundryClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "extension-test", version: "1" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    assert.ok(
      (await client.listTools()).tools.some((tool) => tool.name === "fixture_extension_mcp"),
    );
    assert.ok((await client.callTool({ name: "fixture_extension_mcp", arguments: {} })).content);
    disposeGroup();
    assert.ok(
      !(await client.listTools()).tools.some((tool) => tool.name === "fixture_extension_mcp"),
    );
  } finally {
    disposeGroup();
    unbind();
    await client.close();
    await server.close();
  }
});

void test("MCP accepts structural object schemas from a separate extension package", async () => {
  const input = z.object({ value: z.string() }).strict();
  const output = z.object({ echoed: z.string() }).strict();
  const schema = (source: typeof input | typeof output) => ({
    _zod: { def: { type: "object" } },
    shape: source.shape,
    parse: source.parse.bind(source),
  });
  const registry = new ExtensionEndpointRegistry();
  const server = new McpServer({ name: "extension-schema-fixture", version: "1" });
  const dispose = registry.register([
    {
      name: "fixture_extension_schema",
      description: "Fixture only",
      inputSchema: schema(input),
      outputSchema: schema(output),
      handler: (value: { value: string }) => ({ echoed: value.value }),
    } as unknown as AnyEndpointDescriptor,
  ]);
  const unbind = registry.bindMcp(server, {} as FoundryClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "extension-schema-test", version: "1" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "fixture_extension_schema",
      arguments: { value: "synthetic" },
    });
    assert.deepEqual(result.structuredContent, { echoed: "synthetic" });
    assert.equal(
      (
        await client.callTool({
          name: "fixture_extension_schema",
          arguments: { value: 42 },
        })
      ).isError,
      true,
    );
  } finally {
    dispose();
    unbind();
    await client.close();
    await server.close();
  }
});
