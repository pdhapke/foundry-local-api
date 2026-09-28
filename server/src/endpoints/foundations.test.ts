import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import request from "supertest";

import { createApp } from "../app.js";
import type { FoundryClient } from "../bridge/foundry-client.js";
import { FixtureRegistry } from "../foundations/fixture-registry.js";
import { DurableIdempotencyStore } from "../foundations/idempotency-store.js";
import { registerMcpTools } from "./registry.js";
import { foundationEndpointDescriptors } from "./foundations.js";

const API_KEY = "track0-test-key";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "track0-endpoints-"));
  const report = {
    generatedAt: 1,
    serverVersion: "0.0.1",
    protocolVersion: 2,
    clients: [],
    capabilities: [],
  };
  const foundryClient = { getCapabilityReport: () => report } as unknown as FoundryClient;
  const foundations = {
    fixtures: new FixtureRegistry(join(dir, "fixtures.json")),
    idempotency: new DurableIdempotencyStore(join(dir, "idempotency.json")),
  };
  const app = createApp({
    isDevelopment: false,
    apiKey: API_KEY,
    corsAllowedOrigins: [],
    rateLimitWindowMs: 60_000,
    rateLimitMax: 100,
  });
  app.locals["foundryClient"] = foundryClient;
  app.locals["foundations"] = foundations;
  return { app, foundryClient, foundations, report };
}

void describe("Track 0 REST/MCP foundations", () => {
  void it("exposes capability negotiation and exact fixture lifecycle over REST", async () => {
    const { app, report } = harness();
    const capabilities = await request(app)
      .get("/api/capabilities")
      .set("x-api-key", API_KEY)
      .expect(200);
    assert.deepEqual(capabilities.body, report);

    const created = await request(app)
      .post("/api/fixtures/runs")
      .set("x-api-key", API_KEY)
      .send({ testRunId: "test-track0-rest-0001" })
      .expect(200);
    assert.equal(created.body.testRunId, "test-track0-rest-0001");

    await request(app)
      .post("/api/fixtures/runs/test-track0-rest-0001/documents")
      .set("x-api-key", API_KEY)
      .send({ document: { documentType: "Scene", id: "ExactSceneId" } })
      .expect(200);
    const plan = await request(app)
      .get("/api/fixtures/runs/test-track0-rest-0001/cleanup-plan")
      .set("x-api-key", API_KEY)
      .expect(200);
    assert.deepEqual(plan.body.documents, [{ documentType: "Scene", id: "ExactSceneId" }]);
  });

  void it("registers every foundation descriptor as an MCP tool", () => {
    const { foundryClient, foundations } = harness();
    const server = new McpServer({ name: "track0-test", version: "1" });
    const tools = registerMcpTools(
      server,
      foundationEndpointDescriptors,
      foundryClient,
      undefined,
      foundations,
    );
    assert.equal(tools.length, foundationEndpointDescriptors.length);
  });
});
