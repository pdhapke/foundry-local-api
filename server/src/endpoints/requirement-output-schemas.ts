import { z } from "zod";

const id = z.string().min(1).max(256);
const revision = z.string().min(1).max(256);
const point = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    elevation: z.number().finite().optional(),
  })
  .strict();

const bridgeLane = z.enum(["gm", "player", "tv"]);
const enrollableLane = z.enum(["player", "tv"]);
const enrollmentError = z.string().max(128).nullable();
const clientDiagnostics = z
  .object({
    moduleLoaded: z.literal(true),
    moduleVersion: z.string(),
    userId: id,
    intendedLane: bridgeLane,
    consentGranted: z.boolean(),
    connectionState: z.enum(["disconnected", "connecting", "connected", "rejected"]),
    lastConnectionAttemptAt: z.string().nullable(),
    lastNegotiationResult: z
      .object({
        outcome: z.enum(["accepted", "rejected"]),
        at: z.string(),
        protocolVersion: z.number().int(),
        moduleVersion: z.string(),
        errorCode: enrollmentError,
      })
      .strict()
      .nullable(),
    errorCode: enrollmentError,
    reconnect: z
      .object({
        state: z.enum(["idle", "scheduled", "attempting"]),
        attempt: z.number().int().nonnegative(),
        nextAttemptAt: z.string().nullable(),
      })
      .strict(),
  })
  .strict();
const enrollmentTarget = z
  .object({
    moduleLoaded: z.literal(true),
    moduleVersion: z.string(),
    userId: id,
    clientId: id,
    enrollmentPublicKey: z.string(),
    intendedLane: bridgeLane,
    consentGranted: z.boolean(),
    protocolVersion: z.number().int(),
    foundryVersion: z.string(),
    systemId: z.string(),
    systemVersion: z.string(),
    delivery: z.enum(["not-requested", "accepted", "consent-required", "rejected"]),
    errorCode: enrollmentError,
    diagnostics: clientDiagnostics,
  })
  .strict();
export const issueEnrollmentOutputSchema = z
  .object({
    enrollmentId: id,
    userId: id,
    lane: enrollableLane,
    clientId: id,
    scope: z.literal("/bridge"),
    protocolVersion: z.number().int(),
    moduleVersion: z.string(),
    expiresAt: z.string(),
    deliveredAt: z.string(),
    client: enrollmentTarget,
  })
  .strict();
const versionRequirement = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exact"), version: z.string() }).strict(),
  z
    .object({
      kind: z.literal("range"),
      minInclusive: z.string(),
      maxExclusive: z.string().optional(),
    })
    .strict(),
]);
const pendingEnrollment = z
  .object({
    enrollmentId: id,
    expectedUserId: id,
    expectedClientId: id,
    lane: enrollableLane,
    scope: z.literal("/bridge"),
    protocolVersion: z.number().int(),
    moduleVersion: versionRequirement,
    issuedAt: z.number(),
    expiresAt: z.number(),
    status: z.enum(["pending", "accepted", "rejected", "expired", "invalidated"]),
    issuerUserId: id,
    issuerClientId: id,
    connectedClientId: id.optional(),
    rejectionCode: z.string().optional(),
  })
  .strict();
const safeEnrollmentEvent = z
  .object({
    eventId: id,
    timestamp: z.number(),
    action: z.enum(["issued", "accepted", "rejected", "invalidated", "expired"]),
    enrollmentId: id.optional(),
    expectedUserId: id.optional(),
    expectedClientId: id.optional(),
    expectedLane: enrollableLane.optional(),
    observedUserId: id.optional(),
    observedLane: bridgeLane.optional(),
    expectedProtocolVersion: z.number().int().optional(),
    observedProtocolVersion: z.number().int().optional(),
    expectedModuleVersion: versionRequirement.optional(),
    observedModuleVersion: z.string().optional(),
    clientId: id.optional(),
    reason: z.string().optional(),
  })
  .strict();
const connectedClient = z
  .object({
    clientId: id,
    userId: id,
    userName: z.string(),
    isGM: z.boolean(),
    lane: bridgeLane,
    optedIn: z.boolean(),
    protocolVersion: z.number().int(),
    foundryVersion: z.string(),
    systemId: z.string(),
    systemVersion: z.string(),
    moduleVersion: z.string(),
    transport: z.literal("websocket"),
    connectedAt: z.number(),
    lastSeenAt: z.number(),
    capabilities: z.array(z.string()),
  })
  .strict();
export const enrollmentDiagnosticsOutputSchema = z
  .object({
    generatedAt: z.string(),
    pendingCount: z.number().int().nonnegative(),
    pending: z.array(pendingEnrollment),
    active: z.array(pendingEnrollment),
    events: z.array(safeEnrollmentEvent),
    connectedClients: z.array(connectedClient),
  })
  .strict();

const sceneIssue = z
  .object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    subjectId: id.optional(),
  })
  .strict();
export const sceneVisibilityOutputSchema = z
  .object({
    capturedAt: z.string(),
    observation: z.object({ version: z.literal(1), id: z.string().uuid(), worldId: id, sceneId: id, userId: id, tokenId: id,
      actorId: id.nullable(), clientId: id.nullable(), isGM: z.literal(false), optedIn: z.literal(true), capturedAt: z.string(), stateRevision: z.string(),
      readiness: z.enum(["ready", "stale", "unavailable"]), basis: z.literal("request-local-native-render-flags"), pendingRenderFlags: z.number().int().min(0).nullable() }).strict(),
    sceneId: id,
    effectiveUserId: id,
    tokenId: id,
    status: z.enum(["complete", "incomplete", "asset_error", "unsupported"]),
    issues: z.array(sceneIssue),
    context: z
      .object({
        selectedUser: z.literal(true),
        selectedToken: z.literal(true),
        tokenOwned: z.literal(true),
        sceneLoaded: z.literal(true),
      })
      .strict(),
    visible: z.object({ tokens: z.array(id), notes: z.array(id), tiles: z.array(id) }).strict(),
    redaction: z
      .object({
        occludedEntities: z.literal(true),
        hiddenRegions: z.literal(true),
        barrierDocumentIds: z.literal(true),
        barrierCoordinates: z.literal(true),
        secretDoors: z.literal(true),
        exitDestinations: z.literal(true),
      })
      .strict(),
    queryPoints: z.array(
      z
        .object({
          id,
          visible: z.boolean(),
          regions: z.array(z.string()),
          blockerAttribution: z.enum([
            "none",
            "visible-wall",
            "out-of-range",
            "environment-ambiguous",
            "unavailable",
          ]),
          blockerKeys: z.array(z.string()),
        })
        .strict(),
    ),
    effectiveSources: z
      .object({ vision: z.union([z.literal(0), z.literal(1)]), light: z.number() })
      .strict(),
    isolation: z
      .object({
        status: z.enum(["complete", "incomplete", "unsupported"]),
        method: z.enum(["foundry-v14-detection-modes", "selected-source-polygons"]).nullable(),
        detectionModes: z.number().int().nonnegative(),
        unrelatedVisionSourcesIgnored: z.number().int().nonnegative(),
        visionProvidingLightsIgnored: z.number().int().nonnegative(),
      })
      .strict(),
    environment: z
      .object({
        fog: z.enum(["complete", "incomplete", "unsupported"]),
        lighting: z.enum(["complete", "incomplete", "unsupported"]),
        darkness: z.enum(["complete", "incomplete", "unsupported"]),
        vision: z.enum(["complete", "incomplete", "unsupported"]),
        regions: z.enum(["complete", "incomplete", "unsupported"]),
        fogExplorationEnabled: z.boolean().nullable(),
        tokenVisionEnabled: z.boolean().nullable(),
        globalLight: z.boolean().nullable(),
        darknessLevel: z.number().nullable(),
      })
      .strict(),
    regions: z.array(
      z
        .object({
          key: z.string(),
          containsSelectedToken: z.boolean(),
          effects: z.enum(["active", "none", "redacted"]),
        })
        .strict(),
    ),
    visibleBarriers: z.array(
      z
        .object({
          key: z.string(),
          kind: z.enum(["barrier", "door"]),
          state: z.enum(["open", "closed", "locked", "unknown"]),
          blocksVision: z.boolean(),
          exit: z.boolean(),
          destination: z.literal("redacted"),
        })
        .strict(),
    ),
    coveragePolygons: z.array(
      z.object({ source: z.literal("selected-token"), points: z.array(point) }).strict(),
    ),
    fogRevision: z.string().nullable(),
    persistence: z
      .object({ beforeRevision: revision, afterRevision: revision, unchanged: z.boolean() })
      .strict(),
    bounds: z
      .object({
        truncated: z.boolean(),
        visiblePerKind: z.number().int(),
        regions: z.number().int(),
        barriers: z.number().int(),
        coverageSources: z.number().int(),
        coveragePointsPerSource: z.number().int(),
        issues: z.number().int(),
      })
      .strict(),
  })
  .strict();
export const sceneRenderOutputSchema = sceneVisibilityOutputSchema.extend({
  capturedAt: z.string(),
  image: z
    .object({
      mediaType: z.enum(["image/png", "image/webp"]),
      dataUrl: z.string(),
      bytes: z.number().int().nonnegative(),
    })
    .strict()
    .nullable(),
});

const embeddedFamily = z.enum(["Tile", "RegionBehavior", "PlaylistSound", "TableResult", "Card"]);
const embeddedRead = {
  family: embeddedFamily,
  parentId: id,
  childId: id,
  parentRevision: revision,
  childRevision: revision,
  data: z.record(z.string(), z.unknown()),
};
export const embeddedListOutputSchema = z
  .object({
    family: embeddedFamily,
    parentId: id,
    parentRevision: revision,
    children: z.array(
      z.object({ childId: id, revision, data: z.record(z.string(), z.unknown()) }).strict(),
    ),
  })
  .strict();
export const embeddedReadOutputSchema = z.object(embeddedRead).strict();
export const embeddedMutationOutputSchema = z
  .object({
    ...embeddedRead,
    replayed: z.boolean(),
    dryRun: z.boolean(),
    persisted: z.boolean(),
    subtype: z.string().optional(),
    before: z.record(z.string(), z.unknown()).nullable(),
    after: z.record(z.string(), z.unknown()).nullable(),
    diff: z.array(
      z
        .object({
          path: z.string(),
          kind: z.enum(["added", "changed", "removed"]),
          before: z.unknown().optional(),
          after: z.unknown().optional(),
        })
        .strict(),
    ),
    warnings: z.array(
      z.object({ code: z.string(), path: z.string(), message: z.string() }).strict(),
    ),
    migrationWarnings: z.array(z.string()),
    deleted: z.boolean().optional(),
    alreadyAbsent: z.boolean().optional(),
    siblingsVerified: z.literal(true),
    siblingCount: z.number().int().nonnegative(),
  })
  .strict();

const intersection = z
  .object({
    wallId: id,
    x: z.number(),
    y: z.number(),
    t: z.number(),
    elevation: z.number(),
    doorType: z.enum(["none", "door", "secret"]),
    doorState: z.enum(["none", "open", "closed", "locked", "barred", "sealed"]),
    doorOpen: z.boolean(),
    blocking: z.boolean(),
  })
  .strict();
const collisionSnapshot = z
  .object({
    tokenRevision: revision,
    sceneRevision: revision,
    wallRevisions: z.record(z.string(), revision),
    topologySignature: z.string(),
    token: z
      .object({
        x: z.number(),
        y: z.number(),
        elevation: z.number(),
        width: z.number(),
        height: z.number(),
        revision,
      })
      .strict(),
    walls: z.record(
      z.string(),
      z
        .object({
          revision,
          coordinates: z.tuple([z.number(), z.number(), z.number(), z.number()]),
          doorType: z.enum(["none", "door", "secret"]),
          doorState: z.enum(["none", "open", "closed", "locked", "barred", "sealed"]),
          move: z.number(),
          direction: z.number(),
          bottom: z.number().nullable(),
          top: z.number().nullable(),
        })
        .strict(),
    ),
    malformedWalls: z.record(
      z.string(),
      z.object({ revision, shapeSignature: z.string() }).strict(),
    ),
    fog: z
      .object({
        userId: id,
        exists: z.boolean(),
        documentId: z.string().nullable(),
        revision: z.string().nullable(),
        stateSignature: z.string(),
      })
      .strict()
      .optional(),
    burrowSurfaces: z
      .object({ count: z.number().int().nonnegative(), stateSignature: z.string() })
      .strict()
      .optional(),
  })
  .strict();
export const collisionPathOutputSchema = z
  .object({
    sceneId: id,
    tokenId: id,
    movementMode: z.string(),
    reachable: z.boolean(),
    status: z.enum(["complete", "incomplete", "unsupported"]),
    incompleteReasons: z.array(z.string()),
    segments: z.array(
      z
        .object({
          index: z.number().int(),
          from: point,
          to: point,
          distance: z.number(),
          blocked: z.boolean(),
          wallIds: z.array(id),
          firstCollisionWallIds: z.array(id),
          firstCollision: intersection.nullable(),
          intersections: z.array(intersection),
        })
        .strict(),
    ),
    firstCollision: intersection.extend({ segmentIndex: z.number().int() }).nullable(),
    malformedWallIds: z.array(id),
    invalidSimulatedDoorIds: z.array(id),
    modeSupport: z
      .object({ status: z.enum(["supported", "unsupported"]), warnings: z.array(z.string()) })
      .strict(),
    burrowPolicy: z
      .object({
        status: z.enum(["not_applicable", "complete", "incomplete", "unsupported"]),
        policy: z.literal("negative-elevation-or-authoritative-surface"),
        authoritativeSurfaceCount: z.number().int().nonnegative(),
        usedSurfaceCount: z.number().int().nonnegative(),
        unprovenSegmentIndexes: z.array(z.number().int().nonnegative()),
        warnings: z.array(z.string()),
      })
      .strict(),
    gridFit: z
      .object({ valid: z.boolean(), errors: z.array(z.string()), warnings: z.array(z.string()) })
      .strict(),
    gridWarnings: z.array(z.string()),
    before: point.extend({ revision }),
    after: point.extend({ revision }),
    evidence: z
      .object({
        before: collisionSnapshot,
        after: collisionSnapshot,
        unchanged: z.boolean(),
        independentReadRequired: z.literal(true),
      })
      .strict(),
    persisted: z.literal(false),
  })
  .strict();
export const wallTopologyOutputSchema = z
  .object({
    sceneId: id,
    status: z.enum(["complete", "incomplete"]),
    incompleteReasons: z.array(z.string()),
    wallCount: z.number().int().nonnegative(),
    malformedWallIds: z.array(id),
    zeroLengthWallIds: z.array(id),
    duplicateGroups: z.array(z.array(id)),
    danglingEndpointWallIds: z.array(id),
    crossingPairs: z.array(z.tuple([id, id])),
    unchanged: z.boolean(),
    persisted: z.literal(false),
  })
  .strict();

const movementField = z.enum(["x", "y", "elevation"]);
const transition = z
  .object({
    regionId: id,
    regionName: z.string().optional(),
    category: z.enum(["hazard", "threshold", "exit", "room", "corridor", "other"]),
    stopOnEnter: z.literal(true).optional(),
    kind: z.enum(["enter", "exit"]),
    segmentIndex: z.number().int(),
    t: z.number(),
    point,
  })
  .strict();
export const movementEventOutputSchema = z
  .object({
    eventId: id,
    eventType: z.literal("token_movement"),
    movementFields: z.array(movementField),
    sceneId: id,
    tokenId: id,
    userId: id,
    timestamp: z.number(),
    from: point,
    to: point,
    footprint: z.object({ width: z.number(), height: z.number() }).strict(),
    geometryStatus: z.enum(["complete", "incomplete"]),
    incompleteReasons: z.array(z.string()),
    deltas: z.array(z.object({ dx: z.number(), dy: z.number(), delevation: z.number() }).strict()),
    waypoints: z.array(point),
    segments: z.array(
      z
        .object({
          index: z.number().int(),
          from: point,
          to: point,
          dx: z.number(),
          dy: z.number(),
          delevation: z.number(),
        })
        .strict(),
    ),
    transitions: z.array(transition),
    firstStop: transition.optional(),
    acceptedPoint: point,
    remainingPath: z.array(point),
    pendingMovement: z
      .object({
        status: z.literal("pending"),
        stop: transition,
        acceptedPoint: point,
        remainingPath: z.array(point),
      })
      .strict()
      .optional(),
    provenance: z
      .object({ reporterClientId: id, reporterUserId: id, reporterLane: bridgeLane })
      .strict()
      .optional(),
  })
  .strict();
export const sequencedMovementEventOutputSchema = movementEventOutputSchema.extend({
  sequence: z.number().int().positive(),
});
export const movementPageOutputSchema = z
  .object({
    events: z.array(sequencedMovementEventOutputSchema),
    nextCursor: z.string(),
    generation: z.string(),
    gap: z
      .object({
        code: z.literal("CURSOR_GAP"),
        reason: z.enum(["restart", "expired"]),
        oldestSequence: z.number().int().nonnegative(),
        requestedGeneration: z.string(),
        currentGeneration: z.string(),
        missingRanges: z.array(
          z.object({ fromSequence: z.number().int(), toSequence: z.number().int() }).strict(),
        ),
        missingRangesComplete: z.boolean(),
        reconciliationRequired: z.literal(true),
      })
      .strict()
      .optional(),
  })
  .strict();

