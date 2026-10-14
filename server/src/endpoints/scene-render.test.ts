import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SCENE_RENDER_COMMANDS, SCENE_RENDER_LIMITS } from "@foundry-local-api/shared";
import type { FoundryClient } from "../bridge/foundry-client.js";
import { FoundryBridgeError } from "../bridge/errors.js";
import { sceneRenderEndpointDescriptors, sceneRenderSchema } from "./scene-render.js";

const baseClient = {
  userName: "x",
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
const gm = { ...baseClient, clientId: "gm-client", userId: "gm", isGM: true, lane: "gm" as const };
const player = {
  ...baseClient,
  clientId: "player-client",
  userId: "player",
  isGM: false,
  lane: "player" as const,
};
function fake(call: FoundryClient["call"], clients = [gm, player]): FoundryClient {
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

const input = { sceneId: "scene", effectiveUserId: "player", tokenId: "token" };

void describe("scene render endpoints", () => {
  void it("routes only to the selected player client and exact Token without GM fallback", async () => {
    let command: string | undefined;
    let payload: unknown;
    let options: any;
    const otherPlayer = { ...player, clientId: "newer-player-client", connectedAt: 2 };
    const foundryClient = fake(
      ((type: string, value: unknown, callOptions: unknown) => {
        command = type;
        payload = value;
        options = callOptions;
        return Promise.resolve({ ...input, status: "complete", observation:{version:1,worldId:"world",sceneId:"scene",userId:"player",tokenId:"token",isGM:false,optedIn:true} });
      }) as FoundryClient["call"],
      [gm, player, otherPlayer],
    );
    await sceneRenderEndpointDescriptors[0]!.handler(
      { ...input, clientId: "player-client" },
      { foundryClient },
    );
    assert.equal(command, SCENE_RENDER_COMMANDS.SNAPSHOT);
    assert.deepEqual(payload, input);
    assert.equal(options.clientId, "player-client");
    assert.equal(options.userId, "player");
    assert.equal(options.requestingUserId, "gm");
  });

  void it("returns typed disconnected cases and never sends to the available GM", async () => {
    let calls = 0;
    const foundryClient = fake(
      (() => {
        calls += 1;
        return Promise.resolve({});
      }) as FoundryClient["call"],
      [gm],
    );
    await assert.rejects(
      async () => sceneRenderEndpointDescriptors[1]!.handler(input, { foundryClient }),
      (error: unknown) =>
        error instanceof FoundryBridgeError && error.code === "NOT_CONNECTED" && error.retryable,
    );
    assert.equal(calls, 0);
  });

  void it("preserves typed bridge timeout cases", async () => {
    const foundryClient = fake((() =>
      Promise.reject(
        new FoundryBridgeError("TIMEOUT", "Selected client did not answer in time.", {
          retryable: true,
        }),
      )) as FoundryClient["call"]);
    await assert.rejects(
      async () => sceneRenderEndpointDescriptors[1]!.handler(input, { foundryClient }),
      (error: unknown) =>
        error instanceof FoundryBridgeError && error.code === "TIMEOUT" && error.retryable,
    );
  });

  void it("requires user and Token context and bounds every caller-controlled collection", () => {
    assert.equal(sceneRenderSchema.safeParse(input).success, true);
    assert.equal(
      sceneRenderSchema.safeParse({ sceneId: "scene", effectiveUserId: "player" }).success,
      false,
    );
    assert.equal(
      sceneRenderSchema.safeParse({
        ...input,
        maxImageBytes: SCENE_RENDER_LIMITS.maxImageBytes + 1,
      }).success,
      false,
    );
    assert.equal(
      sceneRenderSchema.safeParse({
        ...input,
        queryPoints: Array.from({ length: SCENE_RENDER_LIMITS.maxQueryPoints + 1 }, (_, index) => ({
          id: String(index),
          x: index,
          y: index,
        })),
      }).success,
      false,
    );
    assert.equal(
      sceneRenderSchema.safeParse({ ...input, requestingUserId: "spoofed-gm" }).success,
      false,
    );
  });
});
