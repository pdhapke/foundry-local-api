import assert from "node:assert/strict";
import { describe, it } from "node:test";

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import request from "supertest";

import {
  SCHEMA_DISCOVERY_COMMANDS,
  type SchemaDiscoveryResult,
  type SchemaValidationBatchResult,
  type SchemaValidationResult,
} from "@foundry-local-api/shared";

// Initialize the app-owned endpoint cycle before importing the registry (see
// the same workaround in integrations/dnd5e/endpoints.test.ts).
import "../app.js";
import type { FoundryClient } from "../bridge/foundry-client.js";
import { mountRestEndpoints, registerMcpTools } from "./registry.js";
import { schemaDiscoveryEndpointDescriptors } from "./schema-discovery.js";

function buildApp(call: FoundryClient["call"]) {
  const app = express();
  app.use(express.json());
  app.locals["foundryClient"] = { call } as unknown as FoundryClient;
  const router = express.Router();
  mountRestEndpoints(router, schemaDiscoveryEndpointDescriptors);
  app.use("/api", router);
  app.use(
    (
      error: Error & { status?: number },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => res.status(error.status ?? 500).json({ error: { message: error.message } }),
  );
  return app;
}

void describe("MCP-REQ-003 schema REST/MCP endpoints", () => {
  const versionLock = {
    expectedFoundryVersion: "14.368",
    expectedSystemId: "dnd5e",
    expectedSystemVersion: "6.0.3",
  } as const;

  void it("routes discovery with core, embedded, subtype, and version context", async () => {
    const expected: SchemaDiscoveryResult = {
      context: {
        foundryVersion: "14.368",
        systemId: "dnd5e",
        systemVersion: "6.0.3",
        moduleVersion: "0.1.0",
        documentType: "Item",
        parentDocumentType: "Actor",
        embedded: true,
        subtype: "weapon",
        systemModel: "WeaponData",
      },
      fields: [],
      limitations: [],
      readOnly: true,
    };
    const app = buildApp(((command: string, input: unknown) => {
      assert.equal(command, SCHEMA_DISCOVERY_COMMANDS.DISCOVER);
      assert.deepEqual(input, {
        documentType: "Item",
        parentDocumentType: "Actor",
        subtype: "weapon",
        ...versionLock,
      });
      return Promise.resolve(expected);
    }) as FoundryClient["call"]);

    const response = await request(app)
      .get("/api/schemas/discover")
      .query({
        documentType: "Item",
        parentDocumentType: "Actor",
        subtype: "weapon",
        ...versionLock,
      })
      .expect(200);
    assert.deepEqual(response.body, expected);
  });

  void it("routes a no-persist validation result and rejects malformed input before bridge dispatch", async () => {
    let calls = 0;
    const candidate: SchemaValidationResult = {
      context: {
        foundryVersion: "14.368",
        systemId: "dnd5e",
        systemVersion: "6.0.3",
        moduleVersion: "0.1.0",
        documentType: "Actor",
        embedded: false,
      },
      mode: "create" as const,
      valid: false,
      index: 0,
      normalized: { type: "invalid" },
      errors: [
        {
          severity: "error",
          code: "INVALID_ENUM",
          path: "type",
          message: "invalid enum",
        },
      ],
      warnings: [],
      inputUnchanged: true,
      persisted: false,
      migrationWarnings: [],
      limitations: [],
    };
    const expected: SchemaValidationBatchResult = {
      context: candidate.context,
      mode: "create",
      results: [candidate],
      validCount: 0,
      invalidCount: 1,
      complete: true,
      persisted: false,
    };
    const app = buildApp(((command: string, input: unknown) => {
      calls += 1;
      assert.equal(command, SCHEMA_DISCOVERY_COMMANDS.VALIDATE);
      assert.deepEqual(input, {
        documentType: "Actor",
        mode: "create",
        data: { type: "invalid" },
        ...versionLock,
      });
      return Promise.resolve(expected);
    }) as FoundryClient["call"]);
    const response = await request(app)
      .post("/api/schemas/validate")
      .send({ documentType: "Actor", mode: "create", data: { type: "invalid" }, ...versionLock })
      .expect(200);
    assert.deepEqual(response.body, expected);
    assert.equal(calls, 1);

    await request(app)
      .post("/api/schemas/validate")
      .send({ documentType: "Actor", mode: "wrong", data: {}, ...versionLock })
      .expect(400);
    assert.equal(calls, 1);
  });

  void it("registers both descriptors as callable read-only MCP tools", () => {
    const client = { call: () => Promise.resolve({}) } as unknown as FoundryClient;
    const server = new McpServer({ name: "schema-test", version: "1" });
    const tools = registerMcpTools(server, schemaDiscoveryEndpointDescriptors, client);
    assert.equal(tools.length, 2);
    assert.ok(
      schemaDiscoveryEndpointDescriptors.every(
        (descriptor) => descriptor.annotations?.readOnlyHint === true,
      ),
    );
  });
});
