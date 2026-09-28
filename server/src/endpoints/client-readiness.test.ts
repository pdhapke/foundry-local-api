import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FoundryClient } from "../bridge/foundry-client.js";
import { clientReadinessEndpointDescriptors } from "./client-readiness.js";

const base = {
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
  capabilities: ["clientPreloadScene", "clientReadinessGet", "clientViewportApply", "clientReload"],
};
const gm = { ...base, clientId: "gm-client", userId: "gm", isGM: true, lane: "gm" as const };
const tv = { ...base, clientId: "tv-client", userId: "tv", isGM: false, lane: "tv" as const };
const acknowledgement = (correlationId: string) => ({
  correlationId,
  acknowledged: true as const,
  replayed: false,
  acknowledgedAt: "now",
  clientUserId: "tv",
  executingClientId: "tv-client",
  expectedSceneId: "scene",
  activeSceneId: "scene",
  scenePreloaded: true,
  activeSceneMatches: true,
  sceneReady: true,
  assets: [{ path: "/a.png", status: "loaded" as const }],
  viewport: null,
  applied: { preload: true, viewport: false },
  warnings: [],
  incomplete: false,
});
function fake(call: FoundryClient["call"], clients = [gm, tv]): FoundryClient {
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

void describe("client readiness endpoints", () => {
  void it("requires receiver acknowledgement and returns negotiated client identity", async () => {
    let captured: any;
    const foundryClient = fake(((type: string, payload: unknown, options: unknown) => {
      captured = { type, payload, options };
      return Promise.resolve(acknowledgement("preload-0001"));
    }) as FoundryClient["call"]);
    const result = (await clientReadinessEndpointDescriptors[0]!.handler(
      {
        clientId: "tv-client",
        correlationId: "preload-0001",
        sceneId: "scene",
        assetPaths: ["/a.png"],
        timeoutMs: 1000,
      },
      { foundryClient },
    )) as any;
    assert.equal(captured.type, "clientPreloadScene");
    assert.equal(captured.options.clientId, "tv-client");
    assert.equal(result.client.clientId, "tv-client");
    assert.equal(result.acknowledged, true);
  });

  void it("returns typed disconnected and unsupported-version failures", async () => {
    await assert.rejects(
      clientReadinessEndpointDescriptors[1]!.handler(
        { userId: "missing", correlationId: "ready-0001" },
        { foundryClient: fake((() => Promise.resolve({})) as FoundryClient["call"]) },
      ),
      (error: unknown) => (error as { code?: string }).code === "NOT_CONNECTED",
    );
    await assert.rejects(
      clientReadinessEndpointDescriptors[1]!.handler(
        {
          clientId: "tv-client",
          correlationId: "ready-0002",
          minimumModuleVersion: "99.0.0",
        },
        { foundryClient: fake((() => Promise.resolve({})) as FoundryClient["call"]) },
      ),
      (error: unknown) => (error as { code?: string }).code === "UNSUPPORTED_VERSION",
    );
  });

  void it("derives requester identity from the GM lane and rejects spoof assertions", async () => {
    const descriptor = clientReadinessEndpointDescriptors[1]!;
    assert.equal(
      descriptor.inputSchema?.safeParse({
        clientId: "tv-client",
        correlationId: "ready-spoof-0001",
        requestingUserId: "spoofed-gm",
      }).success,
      false,
    );
    let requestingUserId: string | undefined;
    await descriptor.handler(
      { clientId: "tv-client", correlationId: "ready-derived-0001" },
      {
        foundryClient: fake(((_type: string, _payload: unknown, options: unknown) => {
          requestingUserId = (options as { requestingUserId?: string }).requestingUserId;
          return Promise.resolve(acknowledgement("ready-derived-0001"));
        }) as FoundryClient["call"]),
      },
    );
    assert.equal(requestingUserId, "gm");
    assert.equal(clientReadinessEndpointDescriptors[0]?.annotations?.readOnlyHint, false);
  });

  void it("rejects preload acknowledgement for a different manifest", async () => {
    await assert.rejects(
      clientReadinessEndpointDescriptors[0]!.handler(
        {
          clientId: "tv-client",
          correlationId: "preload-mismatch-0001",
          sceneId: "scene",
          assetPaths: ["/requested.png"],
          timeoutMs: 1000,
        },
        {
          foundryClient: fake((() =>
            Promise.resolve(acknowledgement("preload-mismatch-0001"))) as FoundryClient["call"]),
        },
      ),
      (error: unknown) => (error as { code?: string }).code === "INCOMPLETE_RESULT",
    );
  });

  void it("rejects viewport acknowledgement whose applied values do not match", async () => {
    const reply = {
      ...acknowledgement("viewport-mismatch-0001"),
      viewport: { x: 1, y: 2, scale: 1 },
      applied: { preload: false, viewport: true },
    };
    await assert.rejects(
      clientReadinessEndpointDescriptors[2]!.handler(
        {
          clientId: "tv-client",
          correlationId: "viewport-mismatch-0001",
          sceneId: "scene",
          viewport: { x: 100, y: 200, scale: 2 },
        },
        {
          foundryClient: fake((() => Promise.resolve(reply)) as FoundryClient["call"]),
        },
      ),
      (error: unknown) => (error as { code?: string }).code === "INCOMPLETE_RESULT",
    );
  });

  void it("routes a bounded reload and validates the receiver identity before success", async () => {
    let captured: any;
    const descriptor = clientReadinessEndpointDescriptors[3]!;
    const result = (await descriptor.handler(
      {
        clientId: "tv-client",
        correlationId: "reload-route-0001",
        delayMs: 1_000,
      },
      {
        foundryClient: fake(((type: string, payload: unknown, options: unknown) => {
          captured = { type, payload, options };
          return Promise.resolve({
            correlationId: "reload-route-0001",
            acknowledged: true,
            replayed: false,
            acknowledgedAt: "now",
            clientUserId: "tv",
            executingClientId: "tv-client",
            reloadScheduled: true,
            reloadAfterMs: 1_000,
          });
        }) as FoundryClient["call"]),
      },
    )) as any;
    assert.equal(descriptor.name, "foundry_reload_client");
    assert.equal(captured.type, "clientReload");
    assert.equal(captured.options.clientId, "tv-client");
    assert.equal(captured.options.requestingUserId, "gm");
    assert.equal(result.client.clientId, "tv-client");
    assert.equal(result.reloadScheduled, true);
  });

  void it("rejects a reload acknowledgement from a different client", async () => {
    await assert.rejects(
      clientReadinessEndpointDescriptors[3]!.handler(
        {
          clientId: "tv-client",
          correlationId: "reload-mismatch-0001",
          delayMs: 1_000,
        },
        {
          foundryClient: fake((() =>
            Promise.resolve({
              correlationId: "reload-mismatch-0001",
              acknowledged: true,
              replayed: false,
              acknowledgedAt: "now",
              clientUserId: "tv",
              executingClientId: "other-client",
              reloadScheduled: true,
              reloadAfterMs: 1_000,
            })) as FoundryClient["call"]),
        },
      ),
      (error: unknown) => (error as { code?: string }).code === "INCOMPLETE_RESULT",
    );
  });
});
