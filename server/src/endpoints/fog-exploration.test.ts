import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FoundryClient } from "../bridge/foundry-client.js";
import { fogExplorationEndpointDescriptors } from "./fog-exploration.js";

const gm = {
  clientId: "gm-client",
  userId: "gm",
  userName: "GM",
  isGM: true,
  lane: "gm" as const,
  optedIn: true,
  protocolVersion: 2,
  foundryVersion: "14.368",
  systemId: "dnd5e",
  systemVersion: "6.0.3",
  moduleVersion: "0.1.0",
  transport: "websocket" as const,
  connectedAt: 1,
  lastSeenAt: 1,
  capabilities: [],
};

function client(call: FoundryClient["call"], clients = [gm]): FoundryClient {
  return {
    call,
    getCapabilityReport: () => ({
      generatedAt: 1,
      serverVersion: "1",
      protocolVersion: 2,
      clients,
      capabilities: [],
    }),
  } as unknown as FoundryClient;
}

void describe("fog exploration endpoints", () => {
  void it("routes read and revisioned replace through the exact GM lane", async () => {
    const calls: Array<{ type: string; payload: unknown; options: unknown }> = [];
    const foundryClient = client(((type: string, payload: unknown, options: unknown) => {
      calls.push({ type, payload, options });
      return Promise.resolve(
        type === "fogExplorationGet" ? { revision: "fog-1" } : { replayed: false },
      );
    }) as FoundryClient["call"]);
    await fogExplorationEndpointDescriptors[0]!.handler(
      { sceneId: "scene", userId: "player" },
      { foundryClient },
    );
    await fogExplorationEndpointDescriptors[1]!.handler(
      {
        sceneId: "scene",
        userId: "player",
        mode: "replace",
        state: { explored: null, positions: {} },
        expectedRevision: "fog-1",
        idempotencyKey: "fog-endpoint-0001",
      },
      { foundryClient },
    );
    assert.deepEqual(
      calls.map(({ type }) => type),
      ["fogExplorationGet", "fogExplorationUpdate"],
    );
    assert.equal((calls[0]?.options as { clientId: string }).clientId, "gm-client");
  });

  void it("accepts an optional Scene Level and rejects unknown fields", () => {
    const schema = fogExplorationEndpointDescriptors[0]!.inputSchema!;
    assert.deepEqual(schema.parse({ sceneId: "scene", userId: "player", level: "level-a" }), {
      sceneId: "scene",
      userId: "player",
      level: "level-a",
    });
    assert.equal(
      schema.safeParse({ sceneId: "scene", userId: "player", level: "" }).success,
      false,
    );
    assert.equal(
      schema.safeParse({ sceneId: "scene", userId: "player", floor: "level-a" }).success,
      false,
    );
    const updateSchema = fogExplorationEndpointDescriptors[1]!.inputSchema!;
    assert.equal(
      updateSchema.safeParse({
        sceneId: "scene",
        userId: "player",
        level: "level-a",
        mode: "replace",
        state: {},
        expectedRevision: "fog-1",
        idempotencyKey: "fog-endpoint-0002",
      }).success,
      true,
    );
  });

  void it("fails explicitly without a connected GM", async () => {
    await assert.rejects(
      async () =>
        fogExplorationEndpointDescriptors[0]!.handler(
          { sceneId: "scene", userId: "player" },
          { foundryClient: client((() => Promise.resolve({})) as FoundryClient["call"], []) },
        ),
      (error: unknown) => (error as { code?: string }).code === "NOT_CONNECTED",
    );
  });
});
