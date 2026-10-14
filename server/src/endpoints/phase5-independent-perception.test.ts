import assert from "node:assert/strict";
import { it } from "node:test";
import type { FoundryClient } from "../bridge/foundry-client.js";
import { sceneRenderEndpointDescriptors } from "./scene-render.js";

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

void it("independent post-dispatch connection/consent drift strips every claim and image", async () => {
  for (const change of [
    (v: any[]) => v.splice(1, 1),
    (v: any[]) => (v[1].optedIn = false),
    (v: any[]) => v[1].connectedAt++,
    (v: any[]) => (v[1].userId = "other"),
    (v: any[]) => (v[0].optedIn = false),
  ]) {
    const clients = structuredClone([gm, player]);
    const raw: any = {
      sceneId: "scene",
      effectiveUserId: "player",
      tokenId: "token",
      status: "complete",
      observation: {
        version: 1,
        worldId: "world",
        sceneId: "scene",
        userId: "player",
        tokenId: "token",
        isGM: false,
        optedIn: true,
        readiness: "ready",
      },
      visible: { tokens: ["visible"], notes: [], tiles: [] },
      regions: [{}],
      visibleBarriers: [{}],
      coveragePolygons: [{}],
      queryPoints: [{ id: "q", visible: true, regions: ["region"], blockerKeys: ["wall"] }],
      image: { dataUrl: "secret-image" },
    };
    const foundryClient = fake(
      (async () => {
        change(clients);
        return raw;
      }) as FoundryClient["call"],
      clients,
    );
    const out: any = await sceneRenderEndpointDescriptors[0]!.handler(input, { foundryClient });
    assert.equal(out.observation.readiness, "stale");
    assert.deepEqual(out.visible, { tokens: [], notes: [], tiles: [] });
    assert.deepEqual(out.regions, []);
    assert.deepEqual(out.visibleBarriers, []);
    assert.deepEqual(out.coveragePolygons, []);
    assert.equal(out.image, null);
    assert.equal(out.queryPoints[0].visible, false);
  }
});
void it("independent mismatched acknowledgement rejects rather than using another user", async () => {
  const raw: any = {
    sceneId: "scene",
    effectiveUserId: "player",
    tokenId: "token",
    observation: {
      version: 1,
      worldId: "world",
      sceneId: "scene",
      userId: "other",
      tokenId: "token",
      isGM: false,
      optedIn: true,
    },
  };
  const foundryClient = fake((async () => raw) as FoundryClient["call"]);
  await assert.rejects(
    sceneRenderEndpointDescriptors[1]!.handler(input, { foundryClient }),
    /mismatch/,
  );
});
