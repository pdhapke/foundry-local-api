import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import express from "express";
import request from "supertest";

import type { FoundryClient } from "../bridge/foundry-client.js";
import {
  ACCEPTANCE_IDENTITIES,
  ACCEPTANCE_TARGET,
  acceptanceValidationOutputSchema,
  createAcceptanceValidationEndpointDescriptors,
  resolveAcceptanceConfig,
} from "./acceptance-validation.js";
import { mountRestEndpoints, registerMcpTools } from "./registry.js";
import type { AnyEndpointDescriptor, EndpointContext } from "./types.js";

function descriptor(handler: AnyEndpointDescriptor["handler"]): AnyEndpointDescriptor {
  return { name: "test", description: "test", handler };
}

function collisionEvidence() {
  const snapshot = {
    tokenRevision: "a",
    sceneRevision: "a",
    wallRevisions: {},
    topologySignature: "topology",
    token: { x: 0, y: 0, elevation: 0, width: 1, height: 1, revision: "a" },
    walls: {},
    malformedWalls: {},
  };
  return {
    before: structuredClone(snapshot),
    after: structuredClone(snapshot),
    unchanged: true,
    independentReadRequired: true as const,
  };
}

function evidence(check: { evidence: unknown } | undefined): Record<string, unknown> {
  return (check?.evidence ?? {}) as Record<string, unknown>;
}

const clients = [
  { ...ACCEPTANCE_IDENTITIES.gm, lane: "gm", isGM: true },
  { ...ACCEPTANCE_IDENTITIES.player, lane: "player", isGM: false },
  { ...ACCEPTANCE_IDENTITIES.tv, lane: "tv", isGM: false },
].map((client) => ({
  ...client,
  userName: client.userId,
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
}));

function context(): EndpointContext {
  return {
    foundryClient: {
      getCapabilityReport: () => ({
        generatedAt: 1,
        serverVersion: "0.1.0",
        protocolVersion: 2,
        clients,
        capabilities: [],
      }),
    } as unknown as FoundryClient,
  };
}

function dependencies(
  overrides: Partial<Parameters<typeof createAcceptanceValidationEndpointDescriptors>[0]> = {},
): Parameters<typeof createAcceptanceValidationEndpointDescriptors>[0] {
  return {
    acceptance: () => resolveAcceptanceConfig({}),
    readiness: descriptor(async (input: unknown) => ({
      correlationId: (input as { correlationId: string }).correlationId,
      acknowledged: true,
      replayed: false,
      acknowledgedAt: "now",
      clientUserId: ACCEPTANCE_IDENTITIES.player.userId,
      executingClientId: ACCEPTANCE_IDENTITIES.player.clientId,
      expectedSceneId: ACCEPTANCE_TARGET.sceneId,
      activeSceneId: ACCEPTANCE_TARGET.sceneId,
      scenePreloaded: true,
      activeSceneMatches: true,
      sceneReady: true,
      assets: [],
      viewport: null,
      applied: { preload: false, viewport: false },
      warnings: [],
      incomplete: false,
      client: {
        ...ACCEPTANCE_IDENTITIES.player,
        lane: "player",
        isGM: false,
        foundryVersion: "14.368",
        systemId: "dnd5e",
        systemVersion: "6.0.3",
        moduleVersion: "0.1.0",
      },
    })),
    fog: descriptor(async () => ({
      sceneId: ACCEPTANCE_TARGET.sceneId,
      userId: ACCEPTANCE_IDENTITIES.player.userId,
      exists: true,
      documentId: "fog",
      revision: "fog-rev",
      state: { explored: "texture", positions: {} },
    })),
    visibility: descriptor(async () => ({
      capturedAt: "now",
      observation: {
        version: 1,
        id: "11111111-1111-4111-8111-111111111111",
        worldId: "world",
        sceneId: ACCEPTANCE_TARGET.sceneId,
        userId: ACCEPTANCE_IDENTITIES.player.userId,
        tokenId: ACCEPTANCE_TARGET.playerTokenId,
        actorId: "actor",
        clientId: ACCEPTANCE_IDENTITIES.player.clientId,
        isGM: false,
        optedIn: true,
        capturedAt: "now",
        stateRevision: "same",
        readiness: "ready",
        basis: "request-local-native-render-flags",
        pendingRenderFlags: 0,
      },
      sceneId: ACCEPTANCE_TARGET.sceneId,
      effectiveUserId: ACCEPTANCE_IDENTITIES.player.userId,
      tokenId: ACCEPTANCE_TARGET.playerTokenId,
      status: "complete",
      issues: [],
      context: { selectedUser: true, selectedToken: true, tokenOwned: true, sceneLoaded: true },
      visible: { tokens: [], notes: [], tiles: [] },
      redaction: {
        occludedEntities: true,
        hiddenRegions: true,
        barrierDocumentIds: true,
        barrierCoordinates: true,
        secretDoors: true,
        exitDestinations: true,
      },
      queryPoints: [],
      effectiveSources: { vision: 1, light: 0 },
      isolation: {
        status: "complete",
        method: "foundry-v14-detection-modes",
        detectionModes: 1,
        unrelatedVisionSourcesIgnored: 0,
        visionProvidingLightsIgnored: 0,
      },
      environment: {
        fog: "complete",
        lighting: "complete",
        darkness: "complete",
        vision: "complete",
        regions: "complete",
        fogExplorationEnabled: true,
        tokenVisionEnabled: true,
        globalLight: false,
        darknessLevel: 0,
      },
      regions: [],
      visibleBarriers: [],
      coveragePolygons: [],
      fogRevision: "fog-rev",
      persistence: { beforeRevision: "a", afterRevision: "a", unchanged: true },
      bounds: {
        truncated: false,
        visiblePerKind: 0,
        regions: 0,
        barriers: 0,
        coverageSources: 0,
        coveragePointsPerSource: 0,
        issues: 0,
      },
    })),
    references: descriptor(async () => ({
      clean: true,
      complete: true,
      scannedDocuments: 1,
      classes: [],
      issues: [],
      truncated: false,
    })),
    topology: descriptor(async () => ({
      sceneId: ACCEPTANCE_TARGET.sceneId,
      status: "complete",
      incompleteReasons: [],
      wallCount: 1,
      malformedWallIds: [],
      zeroLengthWallIds: [],
      duplicateGroups: [],
      danglingEndpointWallIds: [],
      crossingPairs: [],
      unchanged: true,
      persisted: false,
    })),
    collision: descriptor(async () => ({
      sceneId: ACCEPTANCE_TARGET.sceneId,
      tokenId: ACCEPTANCE_TARGET.playerTokenId,
      movementMode: "walk",
      reachable: true,
      status: "complete",
      incompleteReasons: [],
      segments: [],
      firstCollision: null,
      malformedWallIds: [],
      invalidSimulatedDoorIds: [],
      modeSupport: { status: "supported", warnings: [] },
      burrowPolicy: {
        status: "not_applicable",
        policy: "negative-elevation-or-authoritative-surface",
        authoritativeSurfaceCount: 0,
        usedSurfaceCount: 0,
        unprovenSegmentIndexes: [],
        warnings: [],
      },
      gridFit: { valid: true, errors: [], warnings: [] },
      gridWarnings: [],
      before: { x: 0, y: 0, elevation: 0, revision: "a" },
      after: { x: 0, y: 0, elevation: 0, revision: "a" },
      evidence: collisionEvidence(),
      persisted: false,
    })),
    movementDiagnostics: () => ({
      configured: true,
      runtimeAvailable: true,
      readable: true,
      valid: true,
      version: 2,
      generation: "generation",
      eventCount: 0,
      nextSequence: 1,
      issueCodes: [],
    }),
    ...overrides,
  };
}

const input = {
  sceneId: ACCEPTANCE_TARGET.sceneId,
  playerUserId: ACCEPTANCE_IDENTITIES.player.userId,
  playerTokenId: ACCEPTANCE_TARGET.playerTokenId,
  playerClientId: ACCEPTANCE_IDENTITIES.player.clientId,
  correlationId: "acceptance-0001",
  pathCases: [
    {
      id: "open-path",
      waypoints: [{ x: 0, y: 0 }],
      movementMode: "walk" as const,
      expectedReachable: true,
      expectedFirstCollisionWallIds: [],
    },
  ],
};

void describe("acceptance failure validator", () => {
  void it("aggregates every read-only probe for the exact player client", async () => {
    let fogReads = 0;
    const endpoint = createAcceptanceValidationEndpointDescriptors(
      dependencies({
        fog: descriptor(async () => {
          fogReads += 1;
          return {
            sceneId: ACCEPTANCE_TARGET.sceneId,
            userId: ACCEPTANCE_IDENTITIES.player.userId,
            exists: true,
            documentId: "fog",
            revision: "fog-rev",
            state: { explored: "texture", positions: {} },
          };
        }),
      }),
    )[0]!;
    const result = await endpoint.handler(input, context());
    const parsed = acceptanceValidationOutputSchema.parse(result);
    assert.equal(parsed.overall, "pass");
    assert.equal(parsed.correlationId, input.correlationId);
    assert.equal(parsed.playerClientId, ACCEPTANCE_IDENTITIES.player.clientId);
    assert.equal(parsed.summary.pass, 8);
    assert.equal(parsed.summary.partial, 0);
    assert.equal(parsed.summary.fail, 0);
    assert.equal(parsed.readOnly, true);
    assert.equal(endpoint.name, "foundry_validate_acceptance_failures");
    assert.equal(endpoint.method, "post");
    assert.equal(endpoint.path, "/acceptance/validate-failures");
    assert.equal(endpoint.annotations?.readOnlyHint, true);
    assert.equal(endpoint.annotations?.destructiveHint, false);
    assert.equal(endpoint.annotations?.idempotentHint, true);
    assert.equal(fogReads, 2);
    const matrixCheck = parsed.checks.find(({ id }) => id === "client-matrix");
    const matrixClients = evidence(matrixCheck)["clients"] as Array<Record<string, unknown>>;
    assert.equal(matrixClients.find(({ lane }) => lane === "gm")?.["isGM"], true);
    assert.equal(matrixClients.find(({ lane }) => lane === "player")?.["isGM"], false);
    const readiness = evidence(parsed.checks.find(({ id }) => id === "player-readiness"));
    assert.equal(readiness?.["executingClientId"], ACCEPTANCE_IDENTITIES.player.clientId);
    assert.equal(readiness?.["expectedSceneId"], ACCEPTANCE_TARGET.sceneId);
    assert.equal(
      endpoint.inputSchema?.safeParse({ ...input, sceneId: "wrong-scene" }).success,
      false,
    );
    assert.equal(
      endpoint.inputSchema?.safeParse({ ...input, playerTokenId: "wrong-token" }).success,
      false,
    );
    assert.equal(
      endpoint.inputSchema?.safeParse({
        ...input,
        pathCases: [input.pathCases[0], { ...input.pathCases[0] }],
      }).success,
      false,
    );
    const collisionCase = evidence(parsed.checks.find(({ id }) => id === "collision-paths"))[
      "cases"
    ] as Array<Record<string, unknown>>;
    assert.deepEqual(collisionCase[0]?.["waypoints"], input.pathCases[0]!.waypoints);
    assert.equal(collisionCase[0]?.["movementMode"], "walk");
  });

  void it("isolates subsystem failures and still reports later checks", async () => {
    const endpoint = createAcceptanceValidationEndpointDescriptors(
      dependencies({
        collision: descriptor(async (collisionInput: unknown) => {
          const waypoint = (collisionInput as { waypoints: Array<{ x: number }> }).waypoints[0];
          if (waypoint?.x === 99)
            throw Object.assign(new Error("sensitive detail"), {
              code: "INCOMPLETE_RESULT",
              retryable: false,
            });
          return {
            sceneId: ACCEPTANCE_TARGET.sceneId,
            tokenId: ACCEPTANCE_TARGET.playerTokenId,
            movementMode: "walk",
            reachable: true,
            status: "complete",
            incompleteReasons: [],
            segments: [],
            firstCollision: null,
            malformedWallIds: [],
            invalidSimulatedDoorIds: [],
            modeSupport: { status: "supported", warnings: [] },
            burrowPolicy: {
              status: "not_applicable",
              policy: "negative-elevation-or-authoritative-surface",
              authoritativeSurfaceCount: 0,
              usedSurfaceCount: 0,
              unprovenSegmentIndexes: [],
              warnings: [],
            },
            gridFit: { valid: true, errors: [], warnings: [] },
            gridWarnings: [],
            before: { x: 0, y: 0, elevation: 0, revision: "a" },
            after: { x: 0, y: 0, elevation: 0, revision: "a" },
            evidence: collisionEvidence(),
            persisted: false,
          };
        }),
        movementDiagnostics: () => ({
          configured: true,
          runtimeAvailable: true,
          readable: true,
          valid: false,
          version: 2,
          generation: "generation",
          eventCount: 1,
          nextSequence: 2,
          issueCodes: ["STORE_DIGEST_MISMATCH"],
        }),
      }),
    )[0]!;
    const result = acceptanceValidationOutputSchema.parse(
      await endpoint.handler(
        {
          ...input,
          pathCases: [
            ...input.pathCases,
            {
              id: "isolated-failure",
              waypoints: [{ x: 99, y: 0 }],
              movementMode: "walk",
              expectedReachable: false,
              expectedFirstCollisionWallIds: [],
            },
          ],
        },
        context(),
      ),
    );
    assert.equal(result.overall, "fail");
    assert.equal(result.checks.find(({ id }) => id === "movement-store")?.status, "fail");
    assert.equal(result.checks.find(({ id }) => id === "reference-integrity")?.status, "pass");
    const collisionCases = evidence(result.checks.find(({ id }) => id === "collision-paths"))[
      "cases"
    ] as Array<{ id: string; status: string }>;
    assert.equal(collisionCases.find(({ id }) => id === "open-path")?.status, "complete");
    assert.equal(collisionCases.find(({ id }) => id === "isolated-failure")?.status, "failed");
    assert.doesNotMatch(JSON.stringify(result), /stack|C:\\/i);

    const capabilityFailure = acceptanceValidationOutputSchema.parse(
      await endpoint.handler(input, {
        foundryClient: {
          getCapabilityReport: () => {
            throw Object.assign(new Error("api-key=super-secret C:\\private"), {
              code: "api-key=super-secret",
            });
          },
        } as unknown as FoundryClient,
      }),
    );
    assert.equal(
      evidence(capabilityFailure.checks.find(({ id }) => id === "client-matrix"))["code"],
      "VALIDATION_ERROR",
    );
    assert.doesNotMatch(JSON.stringify(capabilityFailure), /super-secret|C:\\private/);

    const wrongGm = { ...clients[0]!, isGM: false };
    const mismatchAndAbsent = acceptanceValidationOutputSchema.parse(
      await endpoint.handler(input, {
        foundryClient: {
          getCapabilityReport: () => ({ clients: [wrongGm, clients[1]!] }),
        } as unknown as FoundryClient,
      }),
    );
    const matrix = mismatchAndAbsent.checks.find(({ id }) => id === "client-matrix");
    assert.equal(matrix?.status, "fail");
    const matrixClients = evidence(matrix)["clients"] as Array<{
      lane: string;
      findings: string[];
    }>;
    assert.ok(
      matrixClients.find(({ lane }) => lane === "gm")?.findings.includes("PRIVILEGE_MISMATCH"),
    );
    assert.deepEqual(matrixClients.find(({ lane }) => lane === "tv")?.findings, ["NOT_CONNECTED"]);
  });

  void it("reports omitted collision cases as partial instead of claiming coverage", async () => {
    const endpoint = createAcceptanceValidationEndpointDescriptors(dependencies())[0]!;
    const { pathCases: _pathCases, ...withoutCases } = input;
    const result = acceptanceValidationOutputSchema.parse(
      await endpoint.handler(withoutCases, context()),
    );
    assert.equal(result.overall, "partial");
    assert.equal(result.checks.find(({ id }) => id === "collision-paths")?.status, "partial");

    const filtered = acceptanceValidationOutputSchema.parse(
      await endpoint.handler(
        {
          ...withoutCases,
          referenceAudit: { includeDocumentTypes: ["Scene"] },
        },
        context(),
      ),
    );
    const references = filtered.checks.find(({ id }) => id === "reference-integrity");
    assert.equal(references?.status, "partial");
    assert.equal(evidence(references)["complete"], false);
    assert.equal(evidence(references)["clean"], null);

    const changingTopologyEndpoint = createAcceptanceValidationEndpointDescriptors(
      dependencies({
        topology: descriptor(async () => ({
          sceneId: ACCEPTANCE_TARGET.sceneId,
          status: "complete",
          incompleteReasons: [],
          wallCount: 1,
          malformedWallIds: [],
          zeroLengthWallIds: [],
          duplicateGroups: [],
          danglingEndpointWallIds: [],
          crossingPairs: [],
          unchanged: false,
          persisted: false,
        })),
      }),
    )[0]!;
    const changingTopology = acceptanceValidationOutputSchema.parse(
      await changingTopologyEndpoint.handler(input, context()),
    );
    assert.equal(changingTopology.checks.find(({ id }) => id === "wall-topology")?.status, "fail");

    const nullRenderedFogEndpoint = createAcceptanceValidationEndpointDescriptors(
      dependencies({
        visibility: descriptor(async () => ({
          ...(await dependencies().visibility.handler({}, context())),
          fogRevision: null,
        })),
      }),
    )[0]!;
    const nullRenderedFog = acceptanceValidationOutputSchema.parse(
      await nullRenderedFogEndpoint.handler(input, context()),
    );
    assert.equal(
      nullRenderedFog.checks.find(({ id }) => id === "player-visibility")?.status,
      "fail",
    );

    const wrongFogIdentityEndpoint = createAcceptanceValidationEndpointDescriptors(
      dependencies({
        fog: descriptor(async () => ({
          sceneId: "wrong-scene",
          userId: ACCEPTANCE_IDENTITIES.player.userId,
          exists: true,
          documentId: "fog",
          revision: "fog-rev",
          state: { explored: "texture", positions: {} },
        })),
      }),
    )[0]!;
    const wrongFogIdentity = acceptanceValidationOutputSchema.parse(
      await wrongFogIdentityEndpoint.handler(input, context()),
    );
    assert.equal(wrongFogIdentity.checks.find(({ id }) => id === "fog-document")?.status, "fail");

    let fogRead = 0;
    const driftingFogEndpoint = createAcceptanceValidationEndpointDescriptors(
      dependencies({
        fog: descriptor(async () => ({
          sceneId: ACCEPTANCE_TARGET.sceneId,
          userId: ACCEPTANCE_IDENTITIES.player.userId,
          exists: true,
          documentId: "fog",
          revision: `fog-rev-${(fogRead += 1)}`,
          state: { explored: "texture", positions: {} },
        })),
      }),
    )[0]!;
    const driftingFog = acceptanceValidationOutputSchema.parse(
      await driftingFogEndpoint.handler(input, context()),
    );
    const fogCheck = driftingFog.checks.find(({ id }) => id === "fog-document");
    assert.equal(fogCheck?.status, "fail");
    assert.match(fogCheck?.message ?? "", /changed across two direct reads/i);

    const changedCollisionEndpoint = createAcceptanceValidationEndpointDescriptors(
      dependencies({
        collision: descriptor(async () => {
          const base = (await dependencies().collision.handler({}, context())) as Record<
            string,
            unknown
          >;
          return {
            ...base,
            evidence: { ...(base["evidence"] as object), unchanged: false },
          };
        }),
      }),
    )[0]!;
    const changedCollision = acceptanceValidationOutputSchema.parse(
      await changedCollisionEndpoint.handler(input, context()),
    );
    assert.equal(
      changedCollision.checks.find(({ id }) => id === "collision-paths")?.status,
      "fail",
    );
  });

  void it("fails closed on identity conflicts and keeps typed unsupported evidence partial", async () => {
    const wrongVisibilityEndpoint = createAcceptanceValidationEndpointDescriptors(
      dependencies({
        visibility: descriptor(async () => ({
          ...(await dependencies().visibility.handler({}, context())),
          tokenId: "wrong-token",
        })),
      }),
    )[0]!;
    const wrongVisibility = acceptanceValidationOutputSchema.parse(
      await wrongVisibilityEndpoint.handler(input, context()),
    );
    assert.equal(
      wrongVisibility.checks.find(({ id }) => id === "player-visibility")?.status,
      "fail",
    );

    const wrongTopologyEndpoint = createAcceptanceValidationEndpointDescriptors(
      dependencies({
        topology: descriptor(async () => ({
          ...(await dependencies().topology.handler({}, context())),
          sceneId: "wrong-scene",
        })),
      }),
    )[0]!;
    const wrongTopology = acceptanceValidationOutputSchema.parse(
      await wrongTopologyEndpoint.handler(input, context()),
    );
    assert.equal(wrongTopology.checks.find(({ id }) => id === "wall-topology")?.status, "fail");

    const unsupportedCollisionEndpoint = createAcceptanceValidationEndpointDescriptors(
      dependencies({
        collision: descriptor(async () => ({
          ...(await dependencies().collision.handler({}, context())),
          movementMode: "burrow",
          status: "unsupported",
          incompleteReasons: ["BURROW_MODE_UNSUPPORTED"],
          modeSupport: { status: "unsupported", warnings: ["No authoritative policy."] },
          burrowPolicy: {
            status: "unsupported",
            policy: "negative-elevation-or-authoritative-surface",
            authoritativeSurfaceCount: 0,
            usedSurfaceCount: 0,
            unprovenSegmentIndexes: [0],
            warnings: ["No authoritative surface geometry."],
          },
        })),
      }),
    )[0]!;
    const unsupportedCollision = acceptanceValidationOutputSchema.parse(
      await unsupportedCollisionEndpoint.handler(
        {
          ...input,
          pathCases: [
            {
              ...input.pathCases[0]!,
              id: "burrow-path",
              movementMode: "burrow",
              expectedReachable: false,
            },
          ],
        },
        context(),
      ),
    );
    assert.equal(
      unsupportedCollision.checks.find(({ id }) => id === "collision-paths")?.status,
      "partial",
    );
    const burrowEvidence = unsupportedCollision.checks.find(({ id }) => id === "collision-paths")
      ?.evidence as
      | {
          cases: Array<{
            id: string;
            burrowPolicy: { status: string; unprovenSegmentIndexes: number[] };
          }>;
        }
      | undefined;
    const burrowCase = burrowEvidence?.cases.find(({ id }) => id === "burrow-path");
    assert.equal(burrowCase?.burrowPolicy.status, "unsupported");
    assert.deepEqual(burrowCase?.burrowPolicy.unprovenSegmentIndexes, [0]);

    const unavailableRuntimeEndpoint = createAcceptanceValidationEndpointDescriptors(
      dependencies({
        movementDiagnostics: () => ({
          configured: true,
          runtimeAvailable: false,
          readable: true,
          valid: true,
          version: 2,
          generation: "generation",
          eventCount: 0,
          nextSequence: 1,
          issueCodes: [],
        }),
      }),
    )[0]!;
    const unavailableRuntime = acceptanceValidationOutputSchema.parse(
      await unavailableRuntimeEndpoint.handler(input, context()),
    );
    const movement = unavailableRuntime.checks.find(({ id }) => id === "movement-store");
    assert.equal(movement?.status, "blocked");
    assert.match(movement?.message ?? "", /runtime is unavailable/i);

    const timeoutEndpoint = createAcceptanceValidationEndpointDescriptors(
      dependencies({
        references: descriptor(async () => {
          throw Object.assign(new Error("timed out"), { code: "TIMEOUT", retryable: true });
        }),
      }),
    )[0]!;
    const timeout = acceptanceValidationOutputSchema.parse(
      await timeoutEndpoint.handler(input, context()),
    );
    assert.equal(timeout.checks.find(({ id }) => id === "reference-integrity")?.status, "blocked");
  });

  void it("invokes the exact REST route and MCP tool with the same strict schemas", async () => {
    const endpoint = createAcceptanceValidationEndpointDescriptors(dependencies())[0]!;
    const app = express();
    app.use(express.json());
    const router = express.Router();
    mountRestEndpoints(router, [endpoint]);
    app.use("/api", router);
    app.use(
      (
        error: { status?: number },
        _request: express.Request,
        response: express.Response,
        _next: express.NextFunction,
      ) => response.status(error.status ?? 500).json({ error: true }),
    );
    app.locals["foundryClient"] = context().foundryClient;

    const rest = await request(app).post("/api/acceptance/validate-failures").send(input);
    assert.equal(rest.status, 200);
    assert.equal(rest.body.correlationId, input.correlationId);
    assert.equal(rest.body.overall, "pass");
    const rejected = await request(app)
      .post("/api/acceptance/validate-failures")
      .send({ ...input, extra: true });
    assert.equal(rejected.status, 400);

    let callback:
      ((args: unknown) => Promise<{ structuredContent?: Record<string, unknown> }>) | undefined;
    const mcpServer = {
      registerTool: (
        name: string,
        config: { inputSchema?: unknown; outputSchema?: unknown },
        handler: (args: unknown) => Promise<{ structuredContent?: Record<string, unknown> }>,
      ) => {
        assert.equal(name, "foundry_validate_acceptance_failures");
        assert.deepEqual(Object.keys(config.inputSchema as object).sort(), [
          "correlationId",
          "pathCases",
          "playerClientId",
          "playerTokenId",
          "playerUserId",
          "queryPoints",
          "referenceAudit",
          "sceneId",
        ]);
        assert.ok(config.outputSchema);
        callback = handler;
        return {};
      },
    } as unknown as McpServer;
    registerMcpTools(mcpServer, [endpoint], context().foundryClient);
    assert.ok(callback);
    const mcp = await callback(input);
    assert.equal(mcp.structuredContent?.["correlationId"], input.correlationId);
    assert.equal(mcp.structuredContent?.["overall"], "pass");
    await assert.rejects(() => callback!({ ...input, extra: true }));
  });

  void it("pins the input to the acceptance IDs from the environment", () => {
    assert.deepEqual(resolveAcceptanceConfig({}), {
      identities: ACCEPTANCE_IDENTITIES,
      target: ACCEPTANCE_TARGET,
    });
    const config = resolveAcceptanceConfig({
      ACCEPTANCE_SCENE_ID: "OtherSceneId0001",
      ACCEPTANCE_PLAYER_TOKEN_ID: " ",
    });
    assert.equal(config.target.playerTokenId, ACCEPTANCE_TARGET.playerTokenId);
    const [endpoint] = createAcceptanceValidationEndpointDescriptors(
      dependencies({ acceptance: () => config }),
    );
    assert.equal(endpoint?.inputSchema?.safeParse(input).success, false);
    assert.equal(
      endpoint?.inputSchema?.safeParse({ ...input, sceneId: "OtherSceneId0001" }).success,
      true,
    );
  });
});
