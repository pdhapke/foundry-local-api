import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { buildMovementEvent } from "@foundry-local-api/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BridgeGateway } from "../bridge/gateway.js";
import type { FoundryClient } from "../bridge/foundry-client.js";
import { MovementEventStore } from "../events/movement-event-store.js";
import { ApiExtensionHost, type ApiExtensionContext } from "../extensions/host.js";
import { extensionEndpoints } from "../extensions/endpoints.js";
import type { IntegrationManager } from "../integrations/manager.js";
import { allEndpointDescriptors } from "../endpoints/index.js";
import "../app.js";
import { createMcpServer } from "./create-mcp-server.js";

void test("review composed generic API and actual older DM preserve dynamic tool ownership and native GM recipe inventory", async (t) => {
  const extension = (await import(
    new URL("../../../../foundry-ai-dungeon-master/server/src/dot-extension.ts", import.meta.url)
      .href
  )) as {
    registerExtension(context: ApiExtensionContext): void;
  };
  const names = [
    "foundry_list_ai_gm_deliveries",
    "foundry_get_ai_gm_delivery",
    "foundry_rollover_movement_store_generation",
  ];
  for (const name of names)
    assert.equal(
      allEndpointDescriptors.some((d) => d.name === name),
      false,
      `${name} belongs to dynamic AI extension`,
    );
  const original = process.env["FOUNDRY_DOT_CONFIG"];
  delete process.env["FOUNDRY_DOT_CONFIG"];
  t.after(() => {
    if (original === undefined) delete process.env["FOUNDRY_DOT_CONFIG"];
    else process.env["FOUNDRY_DOT_CONFIG"] = original;
  });
  const directory = mkdtempSync(join(tmpdir(), "review-legacy-compose-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "movement-events.json");
  let store = new MovementEventStore(path);
  store.append(
    buildMovementEvent({
      eventId: "review-native-record",
      sceneId: "scene",
      tokenId: "token",
      userId: "gm",
      timestamp: 1,
      waypoints: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
      regions: [],
    }),
  );
  let nativeCalls = 0,
    listener = false;
  const channels = new Set<string>();
  const foundry = {
    call: async () => {
      nativeCalls++;
      throw new Error("No live game mutation in review");
    },
    getCapabilityReport: () => ({ clients: [] }),
  } as unknown as FoundryClient;
  const gateway = {
    getClient: () => null,
    getVerifiedFoundryIdentity: () => null,
    send: () => false,
    registerPrivateChannel: (kind: string) => {
      channels.add(kind);
      return () => channels.delete(kind);
    },
    onConnectionEstablished: () => () => {},
    onConnectionLost: () => () => {},
  } as unknown as BridgeGateway;
  const host = new ApiExtensionHost({
    gateway,
    foundryClient: foundry,
    runtimeRoot: pathToFileURL(directory + "/"),
    moduleRoot: new URL("file:///C:/synthetic/api/"),
    bindHost: "127.0.0.1",
    administrativeCredentialSha256: "0".repeat(64),
    movement: {
      path,
      getStore: () => store,
      diagnose: () => MovementEventStore.diagnose(path),
      reloadStore: () => {
        store = new MovementEventStore(path);
      },
      onRecord: () => {
        listener = true;
        return () => {
          listener = false;
        };
      },
    },
  });
  t.after(() => host.shutdown());
  extension.registerExtension(host.context);
  for (const name of names) {
    const matches = extensionEndpoints.snapshot().filter((d) => d.name === name);
    assert.equal(matches.length, 1);
    const schema = matches[0]!.outputSchema!.toJSONSchema();
    assert.equal(schema.type, "object");
    assert.ok(Object.keys(schema.properties ?? {}).length > 0);
  }
  const manager = {
    getActive: () => [],
    onChange: () => () => {},
  } as unknown as IntegrationManager;
  const server = createMcpServer(foundry, manager),
    client = new Client({ name: "review-composed", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(st);
    await client.connect(ct);
    const tools = (await client.listTools()).tools;
    assert.equal(new Set(tools.map((v) => v.name)).size, tools.length);
    for (const name of names) assert.equal(tools.filter((v) => v.name === name).length, 1);
    assert.equal(
      tools.filter((v) => v.name.startsWith("foundry_gm_") || v.name === "foundry_tv_control")
        .length,
      14,
    );
    const listed = await client.callTool({ name: names[0]!, arguments: {} });
    assert.equal(listed.isError, undefined);
    const items = (listed.structuredContent as { items: Array<{ id: string }> }).items;
    assert.equal(items.length, 1);
    const queuePath = join(directory, "ai-gm-deliveries.json"),
      saved = readFileSync(queuePath, "utf8");
    const detail = await client.callTool({
      name: names[1]!,
      arguments: { deliveryId: items[0]!.id },
    });
    assert.equal(detail.isError, undefined);
    assert.equal((detail.structuredContent as { id: string }).id, items[0]!.id);
    const catalog = await client.callTool({ name: "foundry_gm_recipe_list", arguments: {} });
    const text = (catalog.content as Array<{ type: string; text?: string }>).find(
      (v) => v.type === "text",
    )!.text!;
    assert.equal((JSON.parse(text) as { recipes: unknown[] }).recipes.length, 14);
    assert.equal(readFileSync(queuePath, "utf8"), saved);
    assert.equal(nativeCalls, 0);
    await host.shutdown();
    const remaining = (await client.listTools()).tools.map((v) => v.name);
    for (const name of names) assert.equal(remaining.includes(name), false);
    assert.equal(
      remaining.filter((v) => v.startsWith("foundry_gm_") || v === "foundry_tv_control").length,
      14,
    );
    assert.equal(channels.size, 0);
    assert.equal(listener, false);
  } finally {
    await client.close();
    await server.close();
  }
});
