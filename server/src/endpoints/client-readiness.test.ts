import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";
import request from "supertest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FoundryClient } from "../bridge/foundry-client.js";
import { clientReadinessEndpointDescriptors } from "./client-readiness.js";
import { mountRestEndpoints, registerMcpTools } from "./registry.js";

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
    reserveClientIdentity: () => "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    releaseClientIdentity: () => undefined,
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
  void it('forwards explicit scene-view and DTT options only to exact opted-in TV',async()=>{
    let captured:any;
    const foundryClient=fake(((type:string,payload:any,options:any)=>{
      captured={type,payload,options};return Promise.resolve({...acknowledgement(payload.correlationId),viewport:payload.viewport,applied:{preload:false,viewport:true}});
    }) as FoundryClient['call']);
    const viewport={x:100,y:200,scale:0.5};
    await clientReadinessEndpointDescriptors[2]!.handler({clientId:'tv-client',userId:'tv',correlationId:'forest-dtt-1',sceneId:'scene',viewport,viewScene:true,digitalTabletop:true},{foundryClient} as any);
    assert.equal(captured.options.clientId,'tv-client');assert.equal(captured.payload.viewScene,true);assert.equal(captured.payload.digitalTabletop,true);
    assert.equal(captured.options.requestingUserId,'gm');
  });
  void it('preserves authenticated CSS display evidence through the strict output schema', async()=>{
    const foundryClient=fake((()=>Promise.resolve({...acknowledgement('display-0001'),display:{cssWidth:1920,cssHeight:1080,devicePixelRatio:2,canvasReady:true}})) as FoundryClient['call']);
    const result=await clientReadinessEndpointDescriptors[1]!.handler({clientId:'tv-client',correlationId:'display-0001'},{foundryClient} as any) as any;
    assert.deepEqual(result.display,{cssWidth:1920,cssHeight:1080,devicePixelRatio:2,canvasReady:true});
  });
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

  void it("never dispatches reload to a client that does not advertise it", async () => {
    let calls = 0;
    const priorBundleTv = {
      ...tv,
      capabilities: tv.capabilities.filter((command) => command !== "clientReload"),
    };
    await assert.rejects(
      clientReadinessEndpointDescriptors[3]!.handler(
        {
          clientId: "tv-client",
          correlationId: "reload-unsupported-0001",
          delayMs: 1_000,
        },
        {
          foundryClient: fake(
            (() => {
              calls += 1;
              return Promise.resolve({});
            }) as FoundryClient["call"],
            [gm, priorBundleTv],
          ),
        },
      ),
      (error: unknown) => (error as { code?: string }).code === "UNSUPPORTED_VERSION",
    );
    assert.equal(calls, 0);
  });

  void it("adopts an absent exact GM identity under a bounded reservation", async () => {
    const desiredClientId = "e54cdc0c-74a8-4548-96b2-27d3a1021f7d";
    const exactGm = {
      ...gm,
      clientId: "6489d1c8-8937-42ce-8126-ef036fdfadd5",
      capabilities: [...gm.capabilities, "clientIdentityAdopt"],
    };
    let reserved: string | undefined;
    let released: string | undefined;
    const foundryClient = fake(
      ((_type: string, payload: any) =>
        Promise.resolve({
          correlationId: payload.correlationId,
          acknowledged: true,
          replayed: false,
          acknowledgedAt: "now",
          clientUserId: "gm",
          executingClientId: exactGm.clientId,
          adoptedClientId: desiredClientId,
          reloadRequired: true,
        })) as FoundryClient["call"],
      [exactGm],
    );
    foundryClient.reserveClientIdentity = (desired) => {
      reserved = desired;
      return "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    };
    foundryClient.releaseClientIdentity = (desired) => {
      released = desired;
    };
    const result = (await clientReadinessEndpointDescriptors[4]!.handler(
      {
        correlationId: "identity-adopt-server-0001",
        expectedClientId: exactGm.clientId,
        desiredClientId,
        timeoutMs: 1000,
      },
      { foundryClient },
    )) as any;
    assert.equal(result.adoptedClientId, desiredClientId);
    assert.equal(reserved, desiredClientId);
    assert.equal(released, undefined, "successful reservations survive until matching reconnect");
  });

  void it("refuses connected identity collisions before dispatch", async () => {
    const desired = { ...gm, clientId: "e54cdc0c-74a8-4548-96b2-27d3a1021f7d" };
    const exactGm = {
      ...gm,
      clientId: "6489d1c8-8937-42ce-8126-ef036fdfadd5",
      capabilities: [...gm.capabilities, "clientIdentityAdopt"],
    };
    let calls = 0;
    await assert.rejects(
      clientReadinessEndpointDescriptors[4]!.handler(
        {
          correlationId: "identity-adopt-server-0002",
          expectedClientId: exactGm.clientId,
          desiredClientId: desired.clientId,
          timeoutMs: 1000,
        },
        {
          foundryClient: fake(
            (() => {
              calls += 1;
              return Promise.resolve({});
            }) as FoundryClient["call"],
            [exactGm, desired],
          ),
        },
      ),
      (error: unknown) => (error as { code?: string }).code === "IDEMPOTENCY_CONFLICT",
    );
    assert.equal(calls, 0);
  });

  void it("invokes identity adoption through strict REST and MCP registration", async () => {
    const endpoint = clientReadinessEndpointDescriptors[4]!;
    const expectedClientId = "6489d1c8-8937-42ce-8126-ef036fdfadd5";
    const desiredClientId = "e54cdc0c-74a8-4548-96b2-27d3a1021f7d";
    const exactGm = {
      ...gm,
      clientId: expectedClientId,
      capabilities: [...gm.capabilities, "clientIdentityAdopt"],
    };
    const foundryClient = fake(
      ((
        type: string,
        payload: { correlationId: string; identityHandoffProof: string },
        options: { auditPayloadSummary: unknown },
      ) => {
        assert.equal(type, "clientIdentityAdopt");
        assert.match(payload.identityHandoffProof, /^[A-Za-z0-9_-]{43}$/);
        assert.equal(
          JSON.stringify(options.auditPayloadSummary).includes(payload.identityHandoffProof),
          false,
        );
        return Promise.resolve({
          correlationId: payload.correlationId,
          acknowledged: true,
          replayed: false,
          acknowledgedAt: "now",
          clientUserId: "gm",
          executingClientId: expectedClientId,
          adoptedClientId: desiredClientId,
          reloadRequired: true,
        });
      }) as FoundryClient["call"],
      [exactGm],
    );
    const input = {
      correlationId: "identity-adopt-transport-0001",
      expectedClientId,
      desiredClientId,
      timeoutMs: 1000,
    };

    const app = express();
    app.use(express.json());
    const router = express.Router();
    mountRestEndpoints(router, [endpoint]);
    app.use("/api", router);
    app.locals["foundryClient"] = foundryClient;
    const rest = await request(app).post("/api/clients/adopt-gm-identity").send(input);
    assert.equal(rest.status, 200);
    assert.equal(rest.body.adoptedClientId, desiredClientId);
    assert.equal("identityHandoffProof" in rest.body, false);

    let callback: ((args: unknown) => Promise<{ structuredContent?: object }>) | undefined;
    const mcp = {
      registerTool: (
        name: string,
        _config: unknown,
        handler: (args: unknown) => Promise<{ structuredContent?: object }>,
      ) => {
        assert.equal(name, "foundry_adopt_gm_client_identity");
        callback = handler;
        return {};
      },
    } as unknown as McpServer;
    registerMcpTools(mcp, [endpoint], foundryClient);
    assert.ok(callback);
    const invoked = await callback(input);
    assert.equal(
      (invoked.structuredContent as { adoptedClientId?: string }).adoptedClientId,
      desiredClientId,
    );
    await assert.rejects(() => callback!({ ...input, extra: true }));
  });

  void it("routes enrolled TV identity adoption only through authenticated GM authority", async () => {
    const currentTv = {
      ...tv,
      clientId: "6489d1c8-8937-42ce-8126-ef036fdfadd5",
      userId: "tv-user",
      capabilities: [...tv.capabilities, "clientEnrolledIdentityAdopt"],
    };
    const desiredClientId = "9f325991-49f6-420d-9120-5c428a39d8d2";
    let command: string | undefined;
    let requestingUserId: string | null | undefined;
    const foundryClient = fake(
      ((type: string, payload: any, options: any) => {
        command = type;
        requestingUserId = options.requestingUserId;
        return Promise.resolve({
          correlationId: payload.correlationId,
          acknowledged: true,
          replayed: false,
          acknowledgedAt: "now",
          clientUserId: "tv-user",
          executingClientId: currentTv.clientId,
          adoptedClientId: desiredClientId,
          reloadRequired: true,
        });
      }) as FoundryClient["call"],
      [gm, currentTv],
    );
    const result = (await clientReadinessEndpointDescriptors[5]!.handler(
      {
        correlationId: "identity-adopt-tv-server-0001",
        expectedClientId: currentTv.clientId,
        desiredClientId,
        expectedUserId: "tv-user",
        expectedLane: "tv",
        timeoutMs: 1000,
      },
      { foundryClient },
    )) as any;
    assert.equal(command, "clientEnrolledIdentityAdopt");
    assert.equal(requestingUserId, "gm");
    assert.equal(result.adoptedClientId, desiredClientId);

    await assert.rejects(
      clientReadinessEndpointDescriptors[5]!.handler(
        {
          correlationId: "identity-adopt-tv-server-0002",
          expectedClientId: currentTv.clientId,
          desiredClientId,
          expectedUserId: "different-user",
          expectedLane: "tv",
          timeoutMs: 1000,
        },
        { foundryClient },
      ),
      (error: unknown) => (error as { code?: string }).code === "NOT_CONNECTED",
    );
  });

  void it("invokes enrolled identity adoption through strict REST and MCP schemas", async () => {
    const endpoint = clientReadinessEndpointDescriptors[5]!;
    const currentTv = {
      ...tv,
      clientId: "6489d1c8-8937-42ce-8126-ef036fdfadd5",
      userId: "tv-user",
      capabilities: [...tv.capabilities, "clientEnrolledIdentityAdopt"],
    };
    const desiredClientId = "9f325991-49f6-420d-9120-5c428a39d8d2";
    const foundryClient = fake(
      ((_type: string, payload: any) =>
        Promise.resolve({
          correlationId: payload.correlationId,
          acknowledged: true,
          replayed: false,
          acknowledgedAt: "now",
          clientUserId: "tv-user",
          executingClientId: currentTv.clientId,
          adoptedClientId: desiredClientId,
          reloadRequired: true,
        })) as FoundryClient["call"],
      [gm, currentTv],
    );
    const input = {
      correlationId: "identity-adopt-tv-transport-0001",
      expectedClientId: currentTv.clientId,
      desiredClientId,
      expectedUserId: "tv-user",
      expectedLane: "tv",
      timeoutMs: 1000,
    };
    const app = express();
    app.use(express.json());
    const router = express.Router();
    mountRestEndpoints(router, [endpoint]);
    app.use("/api", router);
    app.locals["foundryClient"] = foundryClient;
    const rest = await request(app).post("/api/clients/adopt-enrolled-identity").send(input);
    assert.equal(rest.status, 200);

    let callback: ((args: unknown) => Promise<{ structuredContent?: object }>) | undefined;
    const mcp = {
      registerTool: (
        name: string,
        _config: unknown,
        handler: (args: unknown) => Promise<{ structuredContent?: object }>,
      ) => {
        assert.equal(name, "foundry_adopt_enrolled_client_identity");
        callback = handler;
        return {};
      },
    } as unknown as McpServer;
    registerMcpTools(mcp, [endpoint], foundryClient);
    assert.ok(callback);
    const invoked = await callback(input);
    assert.equal(
      (invoked.structuredContent as { adoptedClientId?: string }).adoptedClientId,
      desiredClientId,
    );
    await assert.rejects(() => callback!({ ...input, expectedLane: "gm" }));
  });
});
