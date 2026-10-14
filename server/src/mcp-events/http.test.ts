import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { Request, Response } from "express";
import { z } from "zod";
import { createMcpEventsHandler, mountMcpEvents, type McpEventsHttpOptions } from "./http.js";
import express from "express";
import request from "supertest";
import { MCP_EVENTS_PROTOCOL_VERSION } from "./contract.js";
import {
  fixtureFilters,
  fixtureOwner,
  fixtureService,
  fixtureSubscription,
} from "./test-support.js";

const meta = {
  "io.modelcontextprotocol/protocolVersion": MCP_EVENTS_PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientCapabilities": {},
};
const tool = {
  name: "fixture_read_record",
  description: "Reads current scoped state.",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};
const fixtureResultSchema = z
  .object({
    result: z
      .object({
        resultType: z.literal("complete"),
        supportedVersions: z.array(z.string()).optional(),
        capabilities: z.record(z.string(), z.unknown()).optional(),
        tools: z.array(z.object({ name: z.string() }).passthrough()).optional(),
        structuredContent: z.record(z.string(), z.unknown()).optional(),
        isError: z.boolean().optional(),
        events: z.array(z.object({ name: z.string() }).passthrough()).optional(),
        id: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();
const fixtureErrorSchema = z
  .object({ error: z.object({ code: z.number().int() }).passthrough() })
  .passthrough();
function options(): McpEventsHttpOptions {
  return {
    events: fixtureService().service,
    authenticate: async () => fixtureOwner,
    scopeForPrincipal: () => fixtureFilters,
    tools: { list: async () => [tool], call: async (owner) => ({ fixture: true, owner }) },
  };
}
void test("dynamic slot is disabled until explicit publication and immediately revokes future requests", async () => {
  const app = express();
  let selected: McpEventsHttpOptions | undefined;
  let authenticated = 0;
  mountMcpEvents(app, "/fixture/mcp", () => selected);
  const rpc = { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: meta } };
  const send = () =>
    request(app)
      .post("/fixture/mcp")
      .set("Mcp-Protocol-Version", MCP_EVENTS_PROTOCOL_VERSION)
      .set("Mcp-Method", "server/discover")
      .send(rpc);
  assert.equal((await send()).status, 503);
  assert.equal(authenticated, 0);
  selected = {
    ...options(),
    authenticate: async () => {
      authenticated++;
      return fixtureOwner;
    },
  };
  assert.equal((await send()).status, 200);
  assert.equal(authenticated, 1);
  selected = undefined;
  assert.equal((await send()).status, 503);
  assert.equal(authenticated, 1);
  assert.equal((await request(app).get("/fixture/mcp")).status, 405);
});
async function invoke(
  method: string,
  params: Record<string, unknown> = {},
  overrides: Partial<McpEventsHttpOptions> = {},
  headers: Record<string, string | undefined> = {},
) {
  const request = {
    body: { jsonrpc: "2.0", id: 1, method, params: { _meta: meta, ...params } },
    header(name: string) {
      return {
        "mcp-protocol-version": MCP_EVENTS_PROTOCOL_VERSION,
        "mcp-method": method,
        "mcp-name": params["name"] as string,
        ...headers,
      }[name];
    },
  } as Request;
  let status = 200;
  let body: unknown;
  let done!: () => void;
  const completed = new Promise<void>((resolve) => {
    done = resolve;
  });
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    setHeader() {},
    status(value: number) {
      status = value;
      return response;
    },
    json(value: unknown) {
      body = value;
      response.writableEnded = true;
      done();
      return response;
    },
  });
  createMcpEventsHandler({ ...options(), ...overrides })(
    request,
    response as unknown as Response,
    () => {},
  );
  await completed;
  return {
    status,
    body,
    result: () => fixtureResultSchema.parse(body).result,
    error: () => fixtureErrorSchema.parse(body).error,
  };
}
void test("modern discovery is stateless, reports events and does not expose administrative tools", async () => {
  const result = await invoke("server/discover");
  assert.equal(result.status, 200);
  assert.equal(result.result().resultType, "complete");
  assert.deepEqual(result.result().supportedVersions, [MCP_EVENTS_PROTOCOL_VERSION]);
  assert.deepEqual(result.result().capabilities, { tools: {}, events: {} });
  const catalog = await invoke("tools/list");
  assert.equal(catalog.result().tools!.length, 1);
  assert.equal(catalog.result().tools![0]!.name, tool.name);
});
void test("missing auth/scope callbacks fail closed and client metadata never supplies principal identity", async () => {
  assert.throws(() => createMcpEventsHandler({} as McpEventsHttpOptions));
  assert.equal(
    (await invoke("server/discover", {}, { authenticate: async () => null })).status,
    401,
  );
  assert.equal(
    (await invoke("server/discover", {}, { scopeForPrincipal: () => null })).status,
    403,
  );
  assert.equal(
    (await invoke("server/discover", {}, {}, { origin: "https://unapproved.example.com" })).status,
    403,
  );
});
void test("required metadata and matching HTTP routing headers are validated", async () => {
  const mismatch = await invoke("server/discover", {}, {}, { "mcp-method": "tools/list" });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.error().code, -32020);
  const missing = await invoke("server/discover", { _meta: {} });
  assert.equal(missing.status, 400);
  assert.equal(missing.error().code, -32602);
  assert.equal(
    (await invoke("server/discover", {}, {}, { "mcp-protocol-version": undefined })).error().code,
    -32020,
  );
});
void test("tool calls require allowlisted names and matching encoded headers", async () => {
  const allowed = await invoke("tools/call", { name: tool.name, arguments: {} });
  assert.equal(allowed.result().structuredContent!["owner"], fixtureOwner);
  const unknown = await invoke("tools/call", { name: "foundry_execute_macro", arguments: {} });
  assert.equal(unknown.error().code, -32602);
  assert.equal(
    (
      await invoke("tools/call", { name: tool.name, arguments: {} }, {}, { "mcp-name": "other" })
    ).error().code,
    -32020,
  );
  const encoded = `=?base64?${Buffer.from(tool.name).toString("base64")}?=`;
  assert.equal(
    (
      await invoke("tools/call", { name: tool.name, arguments: {} }, {}, { "mcp-name": encoded })
    ).result().isError,
    false,
  );
});
void test("subscription lifecycle is available on the same scoped endpoint", async () => {
  const fixture = fixtureService();
  const listed = await invoke("events/list", {}, { events: fixture.service });
  assert.equal(listed.result().events![0]!.name, "fixture.record_updated");
  const subscribed = await invoke("events/subscribe", fixtureSubscription(), {
    events: fixture.service,
  });
  assert.match(subscribed.result().id!, /^sub-/);
  const { secret: _secret, ...delivery } = fixtureSubscription().delivery;
  const stopped = await invoke(
    "events/unsubscribe",
    { name: "fixture.record_updated", arguments: fixtureFilters, delivery },
    { events: fixture.service },
  );
  assert.equal(stopped.result().resultType, "complete");
  assert.equal(fixture.store.read().subscriptions[0]!.status, "stopped");
});

void test("authenticated unsubscribe remains available after controller scope is revoked", async () => {
  const fixture = fixtureService();
  await fixture.service.subscribe(
    fixtureOwner,
    fixtureSubscription(),
    new AbortController().signal,
  );
  fixture.setAuthorized(false);
  const { secret: _secret, ...delivery } = fixtureSubscription().delivery;
  const stopped = await invoke(
    "events/unsubscribe",
    { name: "fixture.record_updated", arguments: fixtureFilters, delivery },
    { events: fixture.service, scopeForPrincipal: () => null },
  );
  assert.equal(stopped.status, 200);
  assert.equal(stopped.result().resultType, "complete");
  assert.equal(fixture.store.read().subscriptions[0]!.status, "stopped");
});
void test("internal errors, unsupported methods and unexpected fields return safe failures", async () => {
  const error = await invoke(
    "tools/list",
    {},
    {
      tools: {
        list: async () => {
          throw new Error("SYNTHETIC_SENSITIVE_DETAIL");
        },
        call: async () => ({}),
      },
    },
  );
  assert.equal(error.error().code, -32603);
  assert.ok(!JSON.stringify(error.body).includes("SYNTHETIC_SENSITIVE_DETAIL"));
  assert.equal((await invoke("initialize")).error().code, -32601);
  assert.equal((await invoke("server/discover", { extra: true })).error().code, -32602);
});
