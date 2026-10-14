import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  GM_TV_COMMANDS,
  type TvControlInput,
  type TvControlResult,
} from "@foundry-local-api/shared";
import type { FoundryClient, FoundryCallOptions } from "../bridge/foundry-client.js";
import { registerMcpTools } from "./registry.js";
import { gmTvEndpointDescriptors, tvControlSchema } from "./gm-tv.js";
const input: TvControlInput = {
  version: "tv-controls-v1",
  worldId: "world-1",
  sceneId: "scene-1",
  tvUserId: "tv-user",
  tvClientId: "tv-client-1",
  requestingUserId: "gm-user",
  action: "inspect",
};
const receipt: TvControlResult = {
  version: input.version,
  worldId: input.worldId,
  tvUserId: input.tvUserId,
  tvClientId: input.tvClientId,
  action: input.action,
  camera: { sceneId: "scene-1", x: 100, y: 200, scale: 1 },
  vision: {
    mode: "native-pc-union",
    status: "verified",
    blockedReason: null,
    sourceCount: 2,
    nativeWallsFogDetection: true,
    permissionsChanged: false,
  },
  perspective: "native-top-down",
  calibration: { physicalVerified: false, rulerAcceptanceRequired: true },
  replayed: false,
};
function client(overrides: Record<string, unknown> = {}) {
  return {
    clientId: "tv-client-1",
    userId: "tv-user",
    userName: "TV",
    isGM: false,
    lane: "tv",
    optedIn: true,
    protocolVersion: 2,
    foundryVersion: "14.368",
    systemId: "dnd5e",
    systemVersion: "6.0.3",
    moduleVersion: "0.1.0",
    transport: "websocket",
    connectedAt: 100,
    lastSeenAt: 100,
    capabilities: [GM_TV_COMMANDS.EXECUTE],
    ...overrides,
  };
}
const gm = () =>
  client({
    clientId: "gm-client",
    userId: "gm-user",
    userName: "GM",
    isGM: true,
    lane: "gm",
    capabilities: ["status", "user"],
  });
function fake(clients = [gm(), client()], result: unknown = receipt) {
  const calls: { command: string; payload: unknown; options: FoundryCallOptions | undefined }[] =
    [];
  const audits: unknown[] = [];
  const foundryClient = {
    getCapabilityReport: () => ({ clients }),
    call: (command: string, payload: unknown, options?: FoundryCallOptions) => {
      calls.push({ command, payload, options });
      if (command === "status")
        return Promise.resolve({ worldId: input.worldId, userId: input.requestingUserId });
      if (command === "user") return Promise.resolve({ isGM: true, active: true });
      return Promise.resolve(result);
    },
    recordAudit: (r: unknown) => {
      audits.push(r);
      return Promise.resolve();
    },
  } as unknown as FoundryClient;
  return { foundryClient, calls, audits };
}
function run(f: ReturnType<typeof fake>, request = input) {
  return gmTvEndpointDescriptors[0]!.handler(request, { foundryClient: f.foundryClient });
}
void describe("TV REST/MCP boundary", () => {
  void it("registers actual scoped REST and MCP tooling", () => {
    const f = fake();
    const mcp = new McpServer({ name: "tv-test", version: "1" });
    assert.equal(registerMcpTools(mcp, gmTvEndpointDescriptors, f.foundryClient).length, 1);
    assert.equal(gmTvEndpointDescriptors[0]!.name, "foundry_tv_control");
    assert.equal(gmTvEndpointDescriptors[0]!.path, "/tv/control");
  });
  void it("routes to exactly the selected TV among two televisions and a player", async () => {
    const f = fake([
      gm(),
      client(),
      client({ clientId: "tv-client-2", userId: "tv-2", connectedAt: 900 }),
      client({ clientId: "player-client", userId: "player-1", lane: "player" }),
    ]);
    const result = await run(f);
    assert.equal(result.executingClient.clientId, input.tvClientId);
    assert.equal(result.requestingUserId, "gm-user");
    const tvCalls = f.calls.filter((c) => c.command === GM_TV_COMMANDS.EXECUTE);
    assert.equal(tvCalls.length, 1);
    assert.equal(tvCalls[0]?.options?.clientId, input.tvClientId);
    assert.equal(tvCalls[0]?.options?.lane, "tv");
    assert.equal(tvCalls[0]?.options?.requireDurableAudit, true);
    assert.equal(f.calls.filter((c) => c.command === "user").length, 2);
  });
  void it("never falls back to GM, other TV, player, missing capability or consent", async () => {
    for (const clients of [
      [gm()],
      [gm(), client({ clientId: "other-tv" })],
      [gm(), client({ lane: "player" })],
      [gm(), client({ isGM: true })],
      [gm(), client({ optedIn: false })],
      [gm(), client({ capabilities: [] })],
      [client()],
    ]) {
      const f = fake(clients);
      await assert.rejects(run(f));
      assert.equal(f.calls.length, 0);
    }
  });
  void it("requires exact state and rejects unbounded camera, apply options on inspection and authority injection", async () => {
    assert.equal(tvControlSchema.safeParse({ ...input, requestingIsGM: true }).success, false);
    assert.equal(
      tvControlSchema.safeParse({ ...input, action: "camera", camera: { x: 1, y: 1, scale: 1 } })
        .success,
      false,
    );
    assert.equal(
      tvControlSchema.safeParse({ ...input, idempotencyKey: "some-key" }).success,
      false,
    );
    const f = fake();
    await assert.rejects(run(f, { ...input, requestingUserId: "forged" } as TvControlInput), {
      code: "NOT_CONNECTED",
    });
    assert.equal(f.calls.length, 0);
  });
  void it("selects the exact authenticated GM requester in a multi-GM world", async () => {
    const f = fake([
      client({
        clientId: "earlier-gm",
        userId: "other-gm",
        userName: "GM 2",
        lane: "gm",
        isGM: true,
        connectedAt: 1,
      }),
      gm(),
      client(),
    ]);
    const result = await run(f);
    assert.equal(result.requestingUserId, "gm-user");
    assert.equal(f.calls[0]?.options?.requestingUserId, "gm-user");
    await assert.rejects(run(f, { ...input, requestingUserId: "tv-user" }), {
      code: "NOT_CONNECTED",
    });
    assert.equal(f.calls.filter((c) => c.command === GM_TV_COMMANDS.EXECUTE).length, 1);
  });
  void it("rejects wrong-client, cross-scene, secret-bearing and false physical-proof receipts", async () => {
    for (const result of [
      { ...receipt, tvClientId: "tv-client-2" },
      { ...receipt, camera: { ...receipt.camera, sceneId: "other-scene" } },
      { ...receipt, hiddenTokens: ["secret"] },
      { ...receipt, calibration: { physicalVerified: true, rulerAcceptanceRequired: false } },
    ])
      await assert.rejects(run(fake(undefined, result)), { code: "INCOMPLETE_RESULT" });
  });
  void it("inspection exposes bounded blocking reasons while apply cannot claim blocked success", async () => {
    const blocked = {
      ...receipt,
      vision: {
        ...receipt.vision,
        status: "blocked",
        sourceCount: 0,
        blockedReason: "Existing TV OBSERVER permission unavailable.",
      },
    };
    assert.equal((await run(fake(undefined, blocked))).vision.status, "blocked");
    const apply: TvControlInput = {
      ...input,
      action: "unionVision",
      expectedState: receipt.camera,
      idempotencyKey: "union-0001",
    };
    await assert.rejects(run(fake(undefined, { ...blocked, action: "unionVision" }), apply), {
      code: "INCOMPLETE_RESULT",
    });
  });
  void it("withholds receipts when the exact TV or GM is revoked, disconnected or replaced during dispatch", async () => {
    for (const changed of [
      [gm()],
      [gm(), client({ optedIn: false })],
      [gm(), client({ connectedAt: 999 })],
      [client()],
    ]) {
      const f = fake();
      let calls = 0;
      f.foundryClient.getCapabilityReport = (() => ({
        clients: ++calls <= 2 ? [gm(), client()] : changed,
      })) as FoundryClient["getCapabilityReport"];
      await assert.rejects(run(f), { code: "PERMISSION_DENIED" });
    }
  });
  void it("rejects duplicate GM tabs, missing native probes, wrong world and native role loss", async () => {
    for (const clients of [
      [gm(), gm(), client()],
      [{ ...gm(), capabilities: [] }, client()],
    ]) {
      const f = fake(clients);
      await assert.rejects(run(f));
      assert.equal(f.calls.filter((c) => c.command === GM_TV_COMMANDS.EXECUTE).length, 0);
    }
    for (const failCommand of ["status", "user"]) {
      const f = fake();
      const original = f.foundryClient.call;
      f.foundryClient.call = ((command: string, payload: unknown, options?: FoundryCallOptions) =>
        command === failCommand
          ? Promise.resolve(
              command === "status"
                ? { worldId: "other-world", userId: input.requestingUserId }
                : { isGM: false, active: true },
            )
          : original.call(f.foundryClient, command, payload, options)) as FoundryClient["call"];
      await assert.rejects(run(f), { code: "PERMISSION_DENIED" });
      assert.equal(f.calls.filter((c) => c.command === GM_TV_COMMANDS.EXECUTE).length, 0);
    }
  });
});
