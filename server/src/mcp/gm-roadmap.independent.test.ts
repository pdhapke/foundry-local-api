import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import "../app.js";
import { createMcpServer } from "./create-mcp-server.js";
import type { FoundryClient } from "../bridge/foundry-client.js";
import type { IntegrationManager } from "../integrations/manager.js";

void test("independent real MCP transport discovers lookup and invokes native recipe without duplicate spend", async () => {
  let gp = 0,
    spends = 0;
  const nativeReceipts = new Map<string, Record<string, unknown>>();
  const owner = {
    clientId: "gm-client",
    userId: "gm",
    isGM: true,
    lane: "gm",
    optedIn: true,
    connectedAt: 1,
    capabilities: ["gmCharacterRead", "gmCharacterApply", "gmReceiptRead"],
  };
  const foundry = {
    getCapabilityReport: () => ({ clients: [owner] }),
    async call(command: string, payload: Record<string, any>, options: Record<string, unknown>) {
      assert.equal(options.clientId, owner.clientId);
      assert.equal(options.userId, owner.userId);
      if (command === "status") return { worldId: "world", userId: "gm" };
      if (command === "user") return { isGM: true, active: true };
      if (command === "gmReceiptRead")
        return nativeReceipts.has(payload.action.idempotencyKey)
          ? { status: "terminal", receipt: nativeReceipts.get(payload.action.idempotencyKey) }
          : { status: "missing", idempotencyKey: payload.action.idempotencyKey };
      if (command === "gmCharacterRead") return { actorId: "actor", currency: { gp } };
      assert.equal(command, "gmCharacterApply");
      assert.equal(options.requireDurableAudit, true);
      assert.deepEqual(payload.expectedState, { actorId: "actor", currency: { gp } });
      const before = { actorId: "actor", currency: { gp } };
      gp = payload.action.value;
      spends++;
      const receipt = {
        ...payload,
        outcome: "confirmed",
        before,
        after: { actorId: "actor", currency: { gp } },
        data: { nativeApplied: true },
      };
      nativeReceipts.set(payload.idempotencyKey, receipt);
      return receipt;
    },
  } as unknown as FoundryClient;
  const manager = {
    getActive: () => [],
    onChange: () => () => {},
  } as unknown as IntegrationManager;
  const server = createMcpServer(foundry, manager);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "independent-roadmap-review", version: "1.0.0" });
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const text = (result.content as Array<{ type: string; text?: string }>).find(
      (v) => v.type === "text",
    )?.text;
    assert.ok(text);
    return JSON.parse(text) as Record<string, any>;
  };
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    for (const name of [
      "foundry_gm_recipe_list",
      "foundry_gm_recipe_search",
      "foundry_gm_recipe_read",
      "foundry_gm_recipe_invoke",
      "foundry_gm_combat_state",
      "foundry_gm_combat_apply",
      "foundry_gm_activity_state",
      "foundry_gm_activity_apply",
      "foundry_gm_character_state",
      "foundry_gm_character_apply",
      "foundry_gm_receipt_read",
      "foundry_tv_control",
    ])
      assert.ok(names.has(name), `Missing actual MCP tool ${name}`);
    const catalog = await invoke("foundry_gm_recipe_list", {});
    assert.ok(catalog.recipes.every((r: Record<string, unknown>) => r.markedForLookup));
    const search = await invoke("foundry_gm_recipe_search", { query: "currency", limit: 1 });
    assert.equal(search.recipes[0].id, "inventory-rewards");
    const recipe = await invoke("foundry_gm_recipe_read", { recipeId: "inventory-rewards" });
    assert.deepEqual(recipe.requiredTools, [
      "foundry_gm_character_state",
      "foundry_gm_character_apply",
      "foundry_gm_receipt_read",
    ]);
    const action = {
      kind: "actor.currency",
      tokenId: "pc",
      actorId: "actor",
      denomination: "gp",
      value: 5,
    };
    const request = {
      schemaVersion: "gm-actions-v1",
      worldId: "world",
      userId: "gm",
      sceneId: "scene",
      recipeId: "inventory-rewards",
      idempotencyKey: "review-recipe",
      correlationId: "review-correlation",
      expectedInitialState: { actorId: "actor", currency: { gp: 0 } },
      steps: [{ stepId: "grant", action }],
    };
    const receipt = await invoke("foundry_gm_recipe_invoke", request);
    assert.equal(receipt.outcome, "confirmed");
    assert.equal(receipt.receipts.length, 1);
    assert.equal(gp, 5);
    assert.deepEqual(await invoke("foundry_gm_recipe_invoke", request), receipt);
    assert.equal(spends, 1);
    // A roll/check may leave its authoritative actor snapshot unchanged. A fresh
    // endpoint instance must inspect the durable first-step key before continuing.
    const unchanged = {
      ...request,
      idempotencyKey: "unchanged-state",
      expectedInitialState: { actorId: "actor", currency: { gp: 5 } },
    };
    assert.equal((await invoke("foundry_gm_recipe_invoke", unchanged)).outcome, "confirmed");
    assert.equal(spends, 2);
    const restartedFoundry = { ...foundry } as FoundryClient;
    const restartedServer = createMcpServer(restartedFoundry, manager);
    const [restartedClientTransport, restartedServerTransport] =
      InMemoryTransport.createLinkedPair();
    const restartedClient = new Client({ name: "review-after-restart", version: "1.0.0" });
    try {
      await restartedServer.connect(restartedServerTransport);
      await restartedClient.connect(restartedClientTransport);
      const restartedResult = await restartedClient.callTool({
        name: "foundry_gm_recipe_invoke",
        arguments: unchanged,
      });
      const body = (restartedResult.content as Array<{ type: string; text?: string }>).find(
        (v) => v.type === "text",
      )?.text;
      assert.ok(body);
      assert.notEqual(
        JSON.parse(body).outcome,
        "confirmed",
        "fresh endpoint must not resume a durable unchanged-state workflow",
      );
      assert.equal(spends, 2);
    } finally {
      await restartedClient.close();
      await restartedServer.close();
    }
  } finally {
    await client.close();
    await server.close();
  }
});
