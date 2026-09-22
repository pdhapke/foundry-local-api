// Phase 31 — Unit tests for the descriptor->route/tool generator machinery
// itself (`mountRestEndpoints`/`registerMcpTools`), as distinct from every
// other `*.test.ts` in this directory, which exercises a *domain's*
// descriptors end-to-end and only indirectly proves the generator works.
//
// Uses small synthetic descriptors (not the real ~100 production ones)
// against:
//   - a bare Express app (not the full `createApp()` from app.ts — that
//     always mounts the real, fixed `apiRouter`/production descriptors, so
//     it can't be pointed at synthetic ones) wired with just enough
//     middleware (json body parsing + an error handler shaped like app.ts's
//     real one) to observe what `mountRestEndpoints` actually wires up.
//   - a fake/mock `McpServer` that just records `registerTool()` calls, in
//     the same "swap in a fake collaborator" spirit as every other test
//     file's mocked `FoundryClient` pattern.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import express from "express";
import request from "supertest";
import { z } from "zod";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { HttpError } from "../app.js";
import { FoundryBridgeError } from "../bridge/errors.js";
import type { FoundryClient } from "../bridge/foundry-client.js";
import type { FoundryEventBus } from "../events/event-bus.js";
import { mountRestEndpoints, registerMcpTools } from "./registry.js";
import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";

// --- REST-side test harness ------------------------------------------------
//
// Deliberately NOT `createApp()`: this builds the smallest app that
// reproduces what `registerRestRoute` actually depends on (json parsing,
// `app.locals["foundryClient"]`/`["eventBus"]` resolved at request time, and
// an error handler that turns a thrown `HttpError`/other error into a JSON
// body) without auth/CORS/rate-limiting noise that's irrelevant to the
// generator itself and already covered by every domain test file.
function buildTestApp(
  descriptors: AnyEndpointDescriptor[],
  foundryClient: FoundryClient,
  eventBus?: FoundryEventBus,
): express.Express {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  mountRestEndpoints(router, descriptors);
  app.use(router);
  app.locals["foundryClient"] = foundryClient;
  if (eventBus) {
    app.locals["eventBus"] = eventBus;
  }
  // Mirrors app.ts's centralized error handler's status/code/message
  // derivation exactly, minus the isDevelopment console-logging branch
  // (irrelevant here and would just be test noise).
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const status = err instanceof HttpError ? err.status : 500;
      const code = err instanceof HttpError ? err.code : undefined;
      const message =
        err instanceof HttpError || status < 500 ? (err as Error).message : "Internal server error";
      res.status(status).json({ error: { message, ...(code ? { code } : {}) } });
    },
  );
  return app;
}

const FAKE_CLIENT = {} as unknown as FoundryClient;

void describe("mountRestEndpoints", () => {
  void it("maps get/post/put/delete descriptors to the matching Express router method", async () => {
    // EndpointDescriptor['method'] is the closed union "get" | "post" |
    // "put" | "delete" (server/src/endpoints/types.ts) — there is no
    // "patch" case, and registerRestRoute's switch statement (registry.ts)
    // only has a branch for these four, so a "patch" descriptor is not
    // representable/would silently mount no route at all. This test covers
    // exactly the four methods the type system allows.
    const methods = ["get", "post", "put", "delete"] as const;
    const seen: string[] = [];
    const descriptors: AnyEndpointDescriptor[] = methods.map((method) => ({
      name: `test_${method}`,
      description: "test",
      method,
      path: `/${method}-thing`,
      handler: () => {
        seen.push(method);
        return { method };
      },
    }));
    const app = buildTestApp(descriptors, FAKE_CLIENT);

    for (const method of methods) {
      const res = await request(app)[method](`/${method}-thing`);
      assert.equal(res.status, 200, `${method} should return 200`);
      assert.deepEqual(res.body, { method });
    }
    assert.deepEqual(seen, [...methods]);
  });

  void it("skips a descriptor that omits method/path entirely (no route is mounted)", async () => {
    const descriptor: AnyEndpointDescriptor = {
      name: "no_rest_route",
      description: "MCP-only, like Phase 5's foundry_status",
      handler: () => ({ ok: true }),
    };
    const app = buildTestApp([descriptor], FAKE_CLIENT);

    const res = await request(app).get("/no-rest-route");
    assert.equal(res.status, 404);
  });

  void it("wires a GET descriptor's inputSchema through validateQuery, merging route params in", async () => {
    const schema = z.object({ id: z.string().min(1), limit: z.coerce.number().int().min(1) });
    let received: unknown;
    const descriptor: EndpointDescriptor<{ id: string; limit: number }, unknown> = {
      name: "test_query",
      description: "test",
      method: "get",
      path: "/items/:id",
      inputSchema: schema,
      handler: (input) => {
        received = input;
        return input;
      },
    };
    const app = buildTestApp([descriptor], FAKE_CLIENT);

    const bad = await request(app).get("/items/abc").query({ limit: "not-a-number" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "VALIDATION_ERROR");

    const good = await request(app).get("/items/abc").query({ limit: "3" });
    assert.equal(good.status, 200);
    assert.deepEqual(good.body, { id: "abc", limit: 3 });
    assert.deepEqual(received, { id: "abc", limit: 3 });
  });

  void it("wires a POST/PUT/DELETE descriptor's inputSchema through validateBody, merging route params in", async () => {
    const schema = z.object({ id: z.string().min(1), name: z.string().min(1) });
    const descriptor: EndpointDescriptor<{ id: string; name: string }, unknown> = {
      name: "test_body",
      description: "test",
      method: "post",
      path: "/things/:id",
      inputSchema: schema,
      handler: (input) => ({ received: input }),
    };
    const app = buildTestApp([descriptor], FAKE_CLIENT);

    const bad = await request(app).post("/things/abc").send({});
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "VALIDATION_ERROR");

    const good = await request(app).post("/things/abc").send({ name: "Fireball" });
    assert.equal(good.status, 200);
    assert.deepEqual(good.body, { received: { id: "abc", name: "Fireball" } });
  });

  void it("runs a handler with no inputSchema without any validation middleware", async () => {
    let receivedInput: unknown = "not-yet-called";
    const descriptor: AnyEndpointDescriptor = {
      name: "test_no_schema",
      description: "test",
      method: "post",
      path: "/no-schema",
      handler: (input) => {
        receivedInput = input;
        return { ok: true };
      },
    };
    const app = buildTestApp([descriptor], FAKE_CLIENT);

    const res = await request(app).post("/no-schema").send({ anything: "goes" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
    // No inputSchema -> no validateBody/validateQuery middleware -> the
    // handler receives `undefined`, not the raw (unvalidated) request body.
    assert.equal(receivedInput, undefined);
  });

  void it("converts a thrown FoundryBridgeError into its normalized HTTP status/code", async () => {
    const descriptor: AnyEndpointDescriptor = {
      name: "test_bridge_error",
      description: "test",
      method: "get",
      path: "/boom",
      handler: () => Promise.reject(new FoundryBridgeError("NOT_CONNECTED", "no client connected")),
    };
    const app = buildTestApp([descriptor], FAKE_CLIENT);

    const res = await request(app).get("/boom");
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, "NOT_CONNECTED");
  });

  void it("forwards a non-bridge error to next(err) so the app's own error handler formats it", async () => {
    const descriptor: AnyEndpointDescriptor = {
      name: "test_generic_error",
      description: "test",
      method: "get",
      path: "/oops",
      handler: () => {
        throw new Error("something unexpected");
      },
    };
    const app = buildTestApp([descriptor], FAKE_CLIENT);

    const res = await request(app).get("/oops");
    assert.equal(res.status, 500);
    assert.equal(res.body.error.message, "Internal server error");
  });

  void it("resolves foundryClient/eventBus off app.locals at request time", async () => {
    let seenClient: unknown;
    let seenBus: unknown;
    const descriptor: AnyEndpointDescriptor = {
      name: "test_ctx",
      description: "test",
      method: "get",
      path: "/ctx",
      handler: (_input, ctx) => {
        seenClient = ctx.foundryClient;
        seenBus = ctx.eventBus;
        return { ok: true };
      },
    };
    const marker = { marker: true } as unknown as FoundryClient;
    const busMarker = { marker: true } as unknown as FoundryEventBus;
    const app = buildTestApp([descriptor], marker, busMarker);

    const res = await request(app).get("/ctx");
    assert.equal(res.status, 200);
    assert.equal(seenClient, marker);
    assert.equal(seenBus, busMarker);
  });

  void it("leaves eventBus undefined when the app never set app.locals['eventBus']", async () => {
    let seenBus: unknown = "not-yet-set";
    const descriptor: AnyEndpointDescriptor = {
      name: "test_no_bus",
      description: "test",
      method: "get",
      path: "/no-bus",
      handler: (_input, ctx) => {
        seenBus = ctx.eventBus;
        return { ok: true };
      },
    };
    const app = buildTestApp([descriptor], FAKE_CLIENT);

    await request(app).get("/no-bus");
    assert.equal(seenBus, undefined);
  });
});

// --- MCP-side test harness --------------------------------------------------

interface CapturedTool {
  config: { description: string; inputSchema?: unknown; annotations?: unknown };
  callback: (args?: unknown) => Promise<{
    content: { type: "text"; text: string }[];
    isError?: boolean;
  }>;
}

function makeFakeMcpServer(): { mcpServer: McpServer; tools: Map<string, CapturedTool> } {
  const tools = new Map<string, CapturedTool>();
  const fake = {
    registerTool: (
      name: string,
      config: CapturedTool["config"],
      callback: CapturedTool["callback"],
    ) => {
      tools.set(name, { config, callback });
    },
  };
  return { mcpServer: fake as unknown as McpServer, tools };
}

void describe("registerMcpTools", () => {
  void it("registers one MCP tool per descriptor, carrying description and annotations through", async () => {
    const descriptor: AnyEndpointDescriptor = {
      name: "foundry_test_tool",
      description: "A test tool.",
      annotations: { destructiveHint: true, title: "Test Tool" },
      handler: () => ({ ok: true }),
    };
    const { mcpServer, tools } = makeFakeMcpServer();

    registerMcpTools(mcpServer, [descriptor], FAKE_CLIENT);

    const tool = tools.get("foundry_test_tool");
    assert.ok(tool, "tool should have been registered");
    assert.equal(tool?.config.description, "A test tool.");
    assert.deepEqual(tool?.config.annotations, { destructiveHint: true, title: "Test Tool" });
  });

  void it("omits the annotations key entirely when a descriptor doesn't supply any", () => {
    const descriptor: AnyEndpointDescriptor = {
      name: "foundry_no_annotations",
      description: "test",
      handler: () => ({ ok: true }),
    };
    const { mcpServer, tools } = makeFakeMcpServer();

    registerMcpTools(mcpServer, [descriptor], FAKE_CLIENT);

    const tool = tools.get("foundry_no_annotations");
    assert.ok(tool);
    assert.equal("annotations" in tool.config, false);
  });

  void it("passes a ZodObject inputSchema's raw shape (not the ZodObject itself) to registerTool", () => {
    const schema = z.object({ id: z.string(), count: z.number() });
    const descriptor: EndpointDescriptor<{ id: string; count: number }, unknown> = {
      name: "foundry_with_schema",
      description: "test",
      inputSchema: schema,
      handler: (input) => input,
    };
    const { mcpServer, tools } = makeFakeMcpServer();

    registerMcpTools(mcpServer, [descriptor], FAKE_CLIENT);

    const tool = tools.get("foundry_with_schema");
    assert.ok(tool);
    assert.ok(tool.config.inputSchema, "inputSchema should be present");
    assert.deepEqual(Object.keys(tool.config.inputSchema as object).sort(), ["count", "id"]);
    assert.equal(tool.config.inputSchema instanceof z.ZodObject, false);
  });

  void it("throws when a descriptor's inputSchema is not a flat ZodObject", () => {
    const descriptor: EndpointDescriptor<string, unknown> = {
      name: "foundry_bad_schema",
      description: "test",
      inputSchema: z.string(),
      handler: (input) => input,
    };
    const { mcpServer } = makeFakeMcpServer();

    assert.throws(
      () => registerMcpTools(mcpServer, [descriptor], FAKE_CLIENT),
      /must be a ZodObject/,
    );
  });

  void it("a registered tool's callback invokes the handler and wraps the result as MCP text content", async () => {
    const descriptor: EndpointDescriptor<{ id: string }, { greeting: string }> = {
      name: "foundry_greet",
      description: "test",
      inputSchema: z.object({ id: z.string() }),
      handler: ({ id }) => ({ greeting: `hello ${id}` }),
    };
    const { mcpServer, tools } = makeFakeMcpServer();
    registerMcpTools(mcpServer, [descriptor], FAKE_CLIENT);

    const result = await tools.get("foundry_greet")?.callback({ id: "world" });

    assert.deepEqual(result, {
      content: [{ type: "text", text: JSON.stringify({ greeting: "hello world" }) }],
    });
  });

  void it("a registered tool's callback calls the handler with undefined input when there's no inputSchema", async () => {
    let receivedInput: unknown = "not-yet-called";
    const descriptor: AnyEndpointDescriptor = {
      name: "foundry_no_input",
      description: "test",
      handler: (input) => {
        receivedInput = input;
        return { ok: true };
      },
    };
    const { mcpServer, tools } = makeFakeMcpServer();
    registerMcpTools(mcpServer, [descriptor], FAKE_CLIENT);

    await tools.get("foundry_no_input")?.callback();

    assert.equal(receivedInput, undefined);
  });

  void it("a FoundryBridgeError thrown by the handler surfaces as an MCP tool-call error, not a rejection", async () => {
    const descriptor: AnyEndpointDescriptor = {
      name: "foundry_will_fail",
      description: "test",
      handler: () => Promise.reject(new FoundryBridgeError("TIMEOUT", "took too long")),
    };
    const { mcpServer, tools } = makeFakeMcpServer();
    registerMcpTools(mcpServer, [descriptor], FAKE_CLIENT);

    const result = await tools.get("foundry_will_fail")?.callback();

    assert.equal(result?.isError, true);
    assert.equal(result?.content[0]?.text, "Foundry error (TIMEOUT): took too long");
  });

  void it("a non-bridge error thrown by the handler propagates as a rejected promise, not swallowed", async () => {
    const descriptor: AnyEndpointDescriptor = {
      name: "foundry_will_throw",
      description: "test",
      handler: () => {
        throw new Error("boom");
      },
    };
    const { mcpServer, tools } = makeFakeMcpServer();
    registerMcpTools(mcpServer, [descriptor], FAKE_CLIENT);

    await assert.rejects(() => tools.get("foundry_will_throw")!.callback(), /boom/);
  });

  void it("closure-captures the given foundryClient/eventBus into every tool's handler context", async () => {
    let seenClient: unknown;
    let seenBus: unknown;
    const descriptor: AnyEndpointDescriptor = {
      name: "foundry_ctx_check",
      description: "test",
      handler: (_input, ctx) => {
        seenClient = ctx.foundryClient;
        seenBus = ctx.eventBus;
        return { ok: true };
      },
    };
    const marker = { marker: true } as unknown as FoundryClient;
    const busMarker = { marker: true } as unknown as FoundryEventBus;
    const { mcpServer, tools } = makeFakeMcpServer();

    registerMcpTools(mcpServer, [descriptor], marker, busMarker);
    await tools.get("foundry_ctx_check")?.callback();

    assert.equal(seenClient, marker);
    assert.equal(seenBus, busMarker);
  });
});
