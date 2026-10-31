import { z } from "zod";

import type { MovementStoreDiagnostics } from "../events/movement-event-store.js";

import { FoundryBridgeError } from "../bridge/errors.js";
import {
  collisionPathOutputSchema,
  sceneVisibilityOutputSchema,
  wallTopologyOutputSchema,
} from "./requirement-output-schemas.js";
import type { AnyEndpointDescriptor, EndpointContext } from "./types.js";

type ValidationStatus = "pass" | "partial" | "fail" | "blocked";

interface ValidationCheck {
  id: string;
  requirement: string;
  status: ValidationStatus;
  message: string;
  evidence?: Record<string, unknown>;
}

interface Dependencies {
  readiness: AnyEndpointDescriptor;
  fog: AnyEndpointDescriptor;
  visibility: AnyEndpointDescriptor;
  references: AnyEndpointDescriptor;
  topology: AnyEndpointDescriptor;
  collision: AnyEndpointDescriptor;
  movementDiagnostics: () => MovementStoreDiagnostics;
  /** Defaults to {@link resolveAcceptanceConfig}, read per request. */
  acceptance?: () => AcceptanceConfig;
}

interface PathCase {
  id: string;
  waypoints: Array<{ x: number; y: number; elevation?: number }>;
  movementMode: "walk" | "fly" | "burrow";
  simulatedDoors?: Record<string, "open" | "closed" | "locked" | "barred" | "sealed">;
  expectedReachable?: boolean;
  expectedFirstCollisionWallIds?: string[];
}

interface ValidationInput {
  sceneId: string;
  playerUserId: string;
  playerTokenId: string;
  playerClientId: string;
  correlationId: string;
  queryPoints?: Array<{ id: string; x: number; y: number }>;
  pathCases?: PathCase[];
  referenceAudit?: {
    includeDocumentTypes?: string[];
    maxDocuments?: number;
    maxIssues?: number;
  };
}

/**
 * Placeholder identities. The live world's IDs come from the local .env
 * (ACCEPTANCE_* keys) so no real world data is committed.
 */
export const ACCEPTANCE_IDENTITIES = {
  gm: { userId: "FakeGmUserId0001", clientId: "00000000-0000-4000-8000-000000000001" },
  player: { userId: "FakePlayerUser01", clientId: "00000000-0000-4000-8000-000000000002" },
  tv: { userId: "FakeTvUserId0001", clientId: "00000000-0000-4000-8000-000000000003" },
} as const;

export const ACCEPTANCE_TARGET = {
  sceneId: "FakeSceneId00001",
  playerTokenId: "FakeTokenId00001",
} as const;

type AcceptanceLane = "gm" | "player" | "tv";

export interface AcceptanceConfig {
  identities: Record<AcceptanceLane, { userId: string; clientId: string }>;
  target: { sceneId: string; playerTokenId: string };
}

/** Reads the ACCEPTANCE_* keys, falling back to the placeholders for any unset key. */
export function resolveAcceptanceConfig(
  environment: Record<string, string | undefined> = process.env,
): AcceptanceConfig {
  const read = (key: string, fallback: string) => environment[key]?.trim() || fallback;
  const identity = (lane: AcceptanceLane) => {
    const prefix = `ACCEPTANCE_${lane.toUpperCase()}`;
    return {
      userId: read(`${prefix}_USER_ID`, ACCEPTANCE_IDENTITIES[lane].userId),
      clientId: read(`${prefix}_CLIENT_ID`, ACCEPTANCE_IDENTITIES[lane].clientId),
    };
  };
  return {
    identities: { gm: identity("gm"), player: identity("player"), tv: identity("tv") },
    target: {
      sceneId: read("ACCEPTANCE_SCENE_ID", ACCEPTANCE_TARGET.sceneId),
      playerTokenId: read("ACCEPTANCE_PLAYER_TOKEN_ID", ACCEPTANCE_TARGET.playerTokenId),
    },
  };
}

const EXPECTED_RUNTIME = {
  protocolVersion: 2,
  foundryVersion: "14.368",
  systemId: "dnd5e",
  systemVersion: "6.0.3",
  moduleVersion: "0.1.0",
} as const;

const id = z.string().min(1).max(128);
const safeText = z.string().max(512);
const point = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    elevation: z.number().finite().optional(),
  })
  .strict();
const baseValidationInputSchema = z
  .object({
    sceneId: id,
    playerUserId: id,
    playerTokenId: id,
    playerClientId: id,
    correlationId: z
      .string()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]+$/),
    queryPoints: z
      .array(z.object({ id, x: z.number().finite(), y: z.number().finite() }).strict())
      .max(500)
      .optional(),
    pathCases: z
      .array(
        z
          .object({
            id,
            waypoints: z.array(point).min(1).max(256),
            movementMode: z.enum(["walk", "fly", "burrow"]),
            simulatedDoors: z
              .record(
                z.string().min(1).max(128),
                z.enum(["open", "closed", "locked", "barred", "sealed"]),
              )
              .refine((doors) => Object.keys(doors).length <= 100, {
                message: "At most 100 simulated doors are allowed.",
              })
              .optional(),
            expectedReachable: z.boolean().optional(),
            expectedFirstCollisionWallIds: z.array(id).max(100).optional(),
          })
          .strict(),
      )
      .max(25)
      .optional(),
    referenceAudit: z
      .object({
        includeDocumentTypes: z.array(z.string().min(1).max(64)).max(100).optional(),
        maxDocuments: z.number().int().min(1).max(10_000).optional(),
        maxIssues: z.number().int().min(1).max(2_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    value.pathCases?.forEach((pathCase, index) => {
      if (seen.has(pathCase.id))
        context.addIssue({
          code: "custom",
          path: ["pathCases", index, "id"],
          message: "Collision case IDs must be unique.",
        });
      seen.add(pathCase.id);
    });
  });

const readinessResultSchema = z
  .object({
    correlationId: id,
    acknowledged: z.literal(true),
    replayed: z.boolean(),
    acknowledgedAt: safeText,
    clientUserId: id,
    executingClientId: id,
    expectedSceneId: id.nullable(),
    activeSceneId: id.nullable(),
    scenePreloaded: z.boolean(),
    activeSceneMatches: z.boolean(),
    sceneReady: z.boolean(),
    assets: z
      .array(
        z
          .object({
            path: z.string().min(1).max(2048),
            status: z.enum(["loaded", "failed"]),
            error: z.string().max(200).optional(),
          })
          .strict(),
      )
      .max(200),
    viewport: z
      .object({ x: z.number().finite(), y: z.number().finite(), scale: z.number().positive() })
      .strict()
      .nullable(),
    applied: z.object({ preload: z.boolean(), viewport: z.boolean() }).strict(),
    warnings: z.array(safeText).max(100),
    incomplete: z.boolean(),
    client: z
      .object({
        clientId: id,
        userId: id,
        lane: z.enum(["gm", "player", "tv"]),
        isGM: z.boolean(),
        foundryVersion: z.string().max(32),
        systemId: z.string().max(128),
        systemVersion: z.string().max(32),
        moduleVersion: z.string().max(32),
      })
      .strict(),
  })
  .strict();

const fogSnapshotSchema = z
  .object({
    sceneId: id,
    userId: id,
    level: id.nullable().optional(),
    exists: z.boolean(),
    documentId: id.nullable(),
    revision: z.string().min(1).max(128),
    state: z
      .object({
        explored: z.string().max(4_000_000).nullable(),
        positions: z.record(
          z.string().min(1).max(128),
          z
            .object({
              x: z.number().finite(),
              y: z.number().finite(),
              radius: z.number().finite().positive().optional(),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();

const referenceResultSchema = z
  .object({
    clean: z.boolean().nullable(),
    complete: z.boolean(),
    scannedDocuments: z.number().int().nonnegative(),
    classes: z
      .array(
        z
          .object({
            class: z.enum([
              "uuid",
              "asset",
              "embedded",
              "note",
              "tokenActor",
              "folder",
              "ownership",
              "stableId",
              "tableResult",
            ]),
            complete: z.boolean(),
            scanned: z.number().int().nonnegative(),
            issueCount: z.number().int().nonnegative(),
            reason: safeText.optional(),
          })
          .strict(),
      )
      .max(20),
    issues: z
      .array(
        z
          .object({
            class: z.enum([
              "uuid",
              "asset",
              "embedded",
              "note",
              "tokenActor",
              "folder",
              "ownership",
              "stableId",
              "tableResult",
            ]),
            code: z.string().min(1).max(64),
            documentUuid: safeText.optional(),
            fieldPath: safeText.optional(),
            target: z.string().max(4096).optional(),
            message: safeText,
          })
          .strict(),
      )
      .max(2_000),
    truncated: z.boolean(),
  })
  .strict();

const validationStatusSchema = z.enum(["pass", "partial", "fail", "blocked"]);
const checkEnvelope = {
  requirement: z.string().min(1).max(128),
  status: validationStatusSchema,
  message: z.string().min(1).max(512),
};
const clientMatrixEvidenceSchema = z
  .object({
    clients: z
      .array(
        z
          .object({
            lane: z.enum(["gm", "player", "tv"]),
            userId: id,
            clientId: id,
            connected: z.boolean(),
            optedIn: z.boolean(),
            isGM: z.boolean().nullable(),
            identityMatched: z.boolean(),
            roleMatched: z.boolean(),
            versionsMatched: z.boolean(),
            findings: z.array(z.string().min(1).max(64)).max(5),
            versions: z
              .object({
                protocol: z.number().int(),
                foundry: z.string().max(32),
                system: z.string().max(256),
                module: z.string().max(32),
              })
              .strict()
              .nullable(),
          })
          .strict(),
      )
      .length(3),
    expectedRuntime: z
      .object({
        protocolVersion: z.number().int(),
        foundryVersion: z.string().max(32),
        systemId: z.string().max(128),
        systemVersion: z.string().max(32),
        moduleVersion: z.string().max(32),
      })
      .strict(),
  })
  .strict();
const readinessEvidenceSchema = z
  .object({
    identityMatched: z.boolean(),
    correlationId: id,
    executingClientId: id,
    clientUserId: id,
    expectedSceneId: id.nullable(),
    activeSceneId: id.nullable(),
    activeSceneMatches: z.boolean(),
    sceneReady: z.boolean(),
    incomplete: z.boolean(),
    warningCount: z.number().int().nonnegative().max(100),
    client: readinessResultSchema.shape.client,
  })
  .strict();
const fogEvidenceSchema = z
  .object({
    identityMatched: z.boolean(),
    beforeSceneId: id,
    afterSceneId: id,
    beforeUserId: id,
    afterUserId: id,
    exists: z.boolean(),
    documentId: id.nullable(),
    beforeRevision: id,
    afterRevision: id,
    unchanged: z.boolean(),
    positionCount: z.number().int().nonnegative(),
    hasExploredTexture: z.boolean(),
  })
  .strict();
const visibilityEvidenceSchema = z
  .object({
    identityMatched: z.boolean(),
    status: sceneVisibilityOutputSchema.shape.status,
    environment: sceneVisibilityOutputSchema.shape.environment,
    isolation: sceneVisibilityOutputSchema.shape.isolation,
    issueCount: z.number().int().nonnegative(),
    issueCodes: z.array(z.string().min(1).max(64)).max(100),
    persistence: sceneVisibilityOutputSchema.shape.persistence,
    fogRevision: id.nullable(),
    directFogRevision: id.nullable(),
    redaction: sceneVisibilityOutputSchema.shape.redaction,
  })
  .strict();
const referenceEvidenceSchema = z
  .object({
    complete: z.boolean(),
    clean: z.boolean().nullable(),
    filtered: z.boolean(),
    scannedDocuments: z.number().int().nonnegative().max(10_000),
    issueCount: z.number().int().nonnegative(),
    issues: z
      .array(
        z
          .object({
            class: referenceResultSchema.shape.issues.element.shape.class,
            code: z.string().min(1).max(64),
            documentUuid: z.string().max(256).optional(),
            target: z.string().max(512).optional(),
          })
          .strict(),
      )
      .max(100),
    classes: referenceResultSchema.shape.classes,
  })
  .strict();
const topologyEvidenceSchema = z
  .object({
    identityMatched: z.boolean(),
    status: wallTopologyOutputSchema.shape.status,
    wallCount: z.number().int().nonnegative(),
    malformedWallIds: z.array(id).max(100),
    zeroLengthWallIds: z.array(id).max(100),
    duplicateGroups: z.array(z.array(id).max(100)).max(100),
    danglingEndpointWallIds: z.array(id).max(100),
    crossingPairs: z.array(z.tuple([id, id])).max(100),
    findingCounts: z
      .object({
        malformed: z.number().int().nonnegative(),
        zeroLength: z.number().int().nonnegative(),
        duplicateGroups: z.number().int().nonnegative(),
        danglingEndpoints: z.number().int().nonnegative(),
        crossingPairs: z.number().int().nonnegative(),
      })
      .strict(),
    projectionTruncated: z.boolean(),
    incompleteReasons: z.array(safeText).max(100),
    persisted: z.literal(false),
    unchanged: z.boolean(),
  })
  .strict();
const collisionCaseSchema = z
  .object({
    id,
    waypoints: z.array(point).min(1).max(256),
    movementMode: z.enum(["walk", "fly", "burrow"]),
    simulatedDoors: z
      .record(id, z.enum(["open", "closed", "locked", "barred", "sealed"]))
      .refine((doors) => Object.keys(doors).length <= 100),
    expectedReachable: z.boolean().nullable(),
    expectedFirstCollisionWallIds: z.array(id).max(100).nullable(),
    status: z.enum(["complete", "incomplete", "unsupported", "failed"]),
    failureStatus: validationStatusSchema.nullable(),
    identityMatched: z.boolean().nullable(),
    reachable: z.boolean().nullable(),
    persisted: z.boolean().nullable(),
    unchanged: z.boolean().nullable(),
    firstCollisionWallIds: z.array(id).max(100),
    firstCollisionWallCount: z.number().int().nonnegative(),
    firstCollisionWallsTruncated: z.boolean(),
    expectationMatched: z.boolean(),
    expectationComplete: z.boolean(),
    incompleteReasonCount: z.number().int().nonnegative(),
    incompleteReasons: z.array(safeText).max(100),
    gridFit: z
      .object({
        valid: z.boolean(),
        errors: z.array(safeText).max(100),
        warnings: z.array(safeText).max(100),
      })
      .strict()
      .nullable(),
    modeSupport: z
      .object({
        status: z.enum(["supported", "unsupported"]),
        warnings: z.array(safeText).max(100),
      })
      .strict()
      .nullable(),
    burrowPolicy: z
      .object({
        status: z.enum(["not_applicable", "complete", "incomplete", "unsupported"]),
        policy: z.literal("negative-elevation-or-authoritative-surface"),
        authoritativeSurfaceCount: z.number().int().nonnegative(),
        usedSurfaceCount: z.number().int().nonnegative(),
        unprovenSegmentIndexes: z.array(z.number().int().nonnegative()).max(256),
        warnings: z.array(safeText).max(100),
      })
      .strict()
      .nullable(),
  })
  .strict();
const movementEvidenceSchema = z
  .object({
    configured: z.boolean(),
    runtimeAvailable: z.boolean(),
    readable: z.boolean(),
    valid: z.boolean(),
    version: z.number().nullable(),
    generation: id.nullable(),
    eventCount: z.number().int().nonnegative().nullable(),
    nextSequence: z.number().int().nonnegative().nullable(),
    issueCodeCount: z.number().int().nonnegative(),
    issueCodes: z.array(z.string().min(1).max(64)).max(100),
  })
  .strict();
const failureEvidenceSchema = z
  .object({ code: z.string().min(1).max(64), retryable: z.boolean().optional() })
  .strict();
const checkSchema = z.discriminatedUnion("id", [
  z
    .object({
      id: z.literal("client-matrix"),
      ...checkEnvelope,
      evidence: clientMatrixEvidenceSchema.or(failureEvidenceSchema),
    })
    .strict(),
  z
    .object({
      id: z.literal("player-readiness"),
      ...checkEnvelope,
      evidence: readinessEvidenceSchema.or(failureEvidenceSchema),
    })
    .strict(),
  z
    .object({
      id: z.literal("fog-document"),
      ...checkEnvelope,
      evidence: fogEvidenceSchema.or(failureEvidenceSchema),
    })
    .strict(),
  z
    .object({
      id: z.literal("player-visibility"),
      ...checkEnvelope,
      evidence: visibilityEvidenceSchema.or(failureEvidenceSchema),
    })
    .strict(),
  z
    .object({
      id: z.literal("reference-integrity"),
      ...checkEnvelope,
      evidence: referenceEvidenceSchema.or(failureEvidenceSchema),
    })
    .strict(),
  z
    .object({
      id: z.literal("wall-topology"),
      ...checkEnvelope,
      evidence: topologyEvidenceSchema.or(failureEvidenceSchema),
    })
    .strict(),
  z
    .object({
      id: z.literal("collision-paths"),
      ...checkEnvelope,
      evidence: z.object({ cases: z.array(collisionCaseSchema).max(25) }).strict(),
    })
    .strict(),
  z
    .object({
      id: z.literal("movement-store"),
      ...checkEnvelope,
      evidence: movementEvidenceSchema.or(failureEvidenceSchema),
    })
    .strict(),
]);

export const acceptanceValidationOutputSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    readOnly: z.literal(true),
    correlationId: id,
    sceneId: id,
    playerUserId: id,
    playerTokenId: id,
    playerClientId: id,
    overall: z.enum(["pass", "partial", "fail", "blocked"]),
    summary: z
      .object({
        pass: z.number().int().nonnegative(),
        partial: z.number().int().nonnegative(),
        fail: z.number().int().nonnegative(),
        blocked: z.number().int().nonnegative(),
      })
      .strict(),
    checks: z.array(checkSchema).length(8),
  })
  .strict();

function safeCode(value: unknown, fallback = "VALIDATION_ERROR"): string {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : fallback;
}

function failure(error: unknown): Pick<ValidationCheck, "status" | "message" | "evidence"> {
  const status = (code: string): ValidationStatus => {
    if (
      [
        "NOT_CONNECTED",
        "PERMISSION_DENIED",
        "TIMEOUT",
        "UNKNOWN_COMMAND",
        "UNSUPPORTED_VERSION",
        "UNSUPPORTED_TYPE",
      ].includes(code)
    )
      return "blocked";
    if (code === "INCOMPLETE_RESULT") return "partial";
    return "fail";
  };
  const safeMessage = (code: string) => {
    if (code === "NOT_CONNECTED") return "The required opted-in client is disconnected.";
    if (code === "PERMISSION_DENIED")
      return "The required client is connected, but the probe is not authorized.";
    if (status(code) === "blocked")
      return "The validation probe could not run because a required capability was unavailable.";
    if (status(code) === "partial") return "The validation probe returned incomplete evidence.";
    return "The validation probe returned a typed failure.";
  };
  if (error instanceof FoundryBridgeError)
    return {
      status: status(error.code),
      message: safeMessage(error.code),
      evidence: { code: safeCode(error.code), retryable: error.retryable },
    };
  if (error && typeof error === "object" && "code" in error) {
    const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown };
    return {
      status: status(safeCode(candidate.code)),
      message: safeMessage(safeCode(candidate.code)),
      evidence: {
        code: safeCode(candidate.code),
        retryable: candidate.retryable === true,
      },
    };
  }
  return {
    status: "fail",
    message: "The validation probe failed unexpectedly.",
    evidence: { code: "VALIDATION_ERROR" },
  };
}

function bounded(value: string | undefined, maximum = 300): string | undefined {
  if (!value) return undefined;
  const withoutCredentials = value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1[redacted]@")
    .replace(
      /\b(api[-_ ]?key|authorization|cookie|password|secret|token)\s*[:=]\s*\S+/gi,
      "$1=[redacted]",
    )
    .replace(/\b[A-Za-z]:[\\/][^\r\n,;]*/g, "[redacted-path]")
    .replace(/\\\\[^\\\s]+\\[^\r\n,;]*/g, "[redacted-path]");
  return withoutCredentials.slice(0, maximum);
}

function safeReferenceTarget(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(value)) return "[redacted-path]";
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`.slice(0, 512);
  } catch {
    return bounded(value, 512);
  }
}

async function probe(
  checks: ValidationCheck[],
  base: Pick<ValidationCheck, "id" | "requirement">,
  operation: () => Promise<Omit<ValidationCheck, "id" | "requirement">>,
): Promise<void> {
  try {
    checks.push({ ...base, ...(await operation()) });
  } catch (error) {
    checks.push({ ...base, ...failure(error) });
  }
}

function aggregate(checks: ValidationCheck[]): ValidationStatus {
  if (checks.some(({ status }) => status === "fail")) return "fail";
  if (checks.some(({ status }) => status === "blocked")) return "blocked";
  if (checks.some(({ status }) => status === "partial")) return "partial";
  return "pass";
}

function count(checks: ValidationCheck[], status: ValidationStatus): number {
  return checks.filter((check) => check.status === status).length;
}

/** Pins the input to the configured Scene, player, Token, and client. */
function validationInputSchemaFor(acceptance: () => AcceptanceConfig) {
  return baseValidationInputSchema.superRefine((value, context) => {
    const { identities, target } = acceptance();
    const expected = {
      sceneId: target.sceneId,
      playerUserId: identities.player.userId,
      playerTokenId: target.playerTokenId,
      playerClientId: identities.player.clientId,
    };
    for (const [field, want] of Object.entries(expected) as Array<[keyof typeof expected, string]>)
      if (value[field] !== want)
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} must be the configured acceptance value.`,
        });
  });
}

export function createAcceptanceValidationEndpointDescriptors(
  dependencies: Dependencies,
): AnyEndpointDescriptor[] {
  const acceptance = dependencies.acceptance ?? (() => resolveAcceptanceConfig());
  return [
    {
      name: "foundry_validate_acceptance_failures",
      description:
        "Runs a read-only, failure-isolated acceptance diagnostic for the exact player client and Scene. It validates the connected client matrix, player readiness, fog/visibility, campaign references, wall topology and optional path cases, durable movement storage. It never impersonates a user, substitutes a GM render, moves a Token, changes fog, or mutates campaign documents.",
      method: "post",
      path: "/acceptance/validate-failures",
      inputSchema: validationInputSchemaFor(acceptance),
      outputSchema: acceptanceValidationOutputSchema,
      handler: async (input: ValidationInput, ctx: EndpointContext) => {
        const checks: ValidationCheck[] = [];
        await probe(checks, { id: "client-matrix", requirement: "MCP-REQ-011" }, async () => {
          const clients = ctx.foundryClient.getCapabilityReport().clients;
          const matrix = (
            Object.entries(acceptance().identities) as Array<
              ["gm" | "player" | "tv", { userId: string; clientId: string }]
            >
          ).map(([lane, identity]) => {
            const exact = clients.find((client) => client.clientId === identity.clientId);
            const identityMatched = exact?.userId === identity.userId && exact?.lane === lane;
            const roleMatched = exact
              ? lane === "gm"
                ? exact.isGM === true
                : exact.isGM === false
              : false;
            const versionsMatched =
              exact?.protocolVersion === EXPECTED_RUNTIME.protocolVersion &&
              exact.foundryVersion === EXPECTED_RUNTIME.foundryVersion &&
              exact.systemId === EXPECTED_RUNTIME.systemId &&
              exact.systemVersion === EXPECTED_RUNTIME.systemVersion &&
              exact.moduleVersion === EXPECTED_RUNTIME.moduleVersion;
            return {
              lane,
              userId: identity.userId,
              clientId: identity.clientId,
              connected: !!exact,
              optedIn: exact?.optedIn === true,
              isGM: exact?.isGM ?? null,
              identityMatched,
              roleMatched,
              versionsMatched,
              findings: !exact
                ? ["NOT_CONNECTED"]
                : [
                    ...(exact.optedIn ? [] : ["NOT_OPTED_IN"]),
                    ...(identityMatched ? [] : ["IDENTITY_MISMATCH"]),
                    ...(roleMatched ? [] : ["PRIVILEGE_MISMATCH"]),
                    ...(versionsMatched ? [] : ["VERSION_MISMATCH"]),
                  ],
              versions: exact
                ? {
                    protocol: exact.protocolVersion,
                    foundry: exact.foundryVersion,
                    system: `${exact.systemId} ${exact.systemVersion}`,
                    module: exact.moduleVersion,
                  }
                : null,
            };
          });
          const unavailable = matrix.some((client) => !client.connected || !client.optedIn);
          const mismatch = matrix.some(
            (client) =>
              client.connected &&
              (!client.identityMatched || !client.roleMatched || !client.versionsMatched),
          );
          return {
            status: mismatch ? "fail" : unavailable ? "blocked" : "pass",
            message:
              !unavailable && !mismatch
                ? "The exact GM, player, and TV clients are connected, opted in, identity-bound, and version-matched."
                : mismatch
                  ? "A connected required client has an identity, privilege, lane, or runtime version mismatch."
                  : "One or more exact required clients are disconnected or have not opted in.",
            evidence: { clients: matrix, expectedRuntime: EXPECTED_RUNTIME },
          };
        });

        await probe(checks, { id: "player-readiness", requirement: "MCP-REQ-011" }, async () => {
          const result = readinessResultSchema.parse(
            await dependencies.readiness.handler(
              {
                userId: input.playerUserId,
                clientId: input.playerClientId,
                correlationId: `${input.correlationId}:ready`,
              },
              ctx,
            ),
          );
          const passed =
            result.correlationId === `${input.correlationId}:ready` &&
            result.sceneReady === true &&
            result.incomplete === false &&
            result.expectedSceneId === input.sceneId &&
            result.activeSceneId === input.sceneId &&
            result.activeSceneMatches === true &&
            result.executingClientId === input.playerClientId &&
            result.clientUserId === input.playerUserId &&
            result.client.clientId === input.playerClientId &&
            result.client.userId === input.playerUserId &&
            result.client.lane === "player" &&
            result.client.isGM === false;
          const identityMatched =
            result.correlationId === `${input.correlationId}:ready` &&
            result.executingClientId === input.playerClientId &&
            result.clientUserId === input.playerUserId &&
            result.client.clientId === input.playerClientId &&
            result.client.userId === input.playerUserId &&
            result.client.lane === "player" &&
            result.client.isGM === false;
          return {
            status: passed ? "pass" : identityMatched ? "partial" : "fail",
            message: passed
              ? "The exact player client reports the requested Scene ready."
              : identityMatched
                ? "The exact player client responded, but the requested Scene is not fully ready."
                : "The readiness acknowledgement did not match the exact player identity.",
            evidence: {
              identityMatched,
              correlationId: result.correlationId,
              executingClientId: result.executingClientId,
              clientUserId: result.clientUserId,
              expectedSceneId: result.expectedSceneId,
              activeSceneId: result.activeSceneId ?? null,
              activeSceneMatches: result.activeSceneMatches,
              sceneReady: result.sceneReady,
              incomplete: result.incomplete,
              warningCount: result.warnings.length,
              client: result.client,
            },
          };
        });

        let fogSnapshot: z.infer<typeof fogSnapshotSchema> | undefined;
        await probe(checks, { id: "fog-document", requirement: "MCP-REQ-001" }, async () => {
          const fogInput = { sceneId: input.sceneId, userId: input.playerUserId };
          const before = fogSnapshotSchema.parse(await dependencies.fog.handler(fogInput, ctx));
          const after = fogSnapshotSchema.parse(await dependencies.fog.handler(fogInput, ctx));
          fogSnapshot = after;
          const identityMatched =
            before.sceneId === input.sceneId &&
            after.sceneId === input.sceneId &&
            before.userId === input.playerUserId &&
            after.userId === input.playerUserId;
          const unchanged =
            before.revision === after.revision &&
            before.exists === after.exists &&
            before.documentId === after.documentId &&
            JSON.stringify(before.state) === JSON.stringify(after.state);
          const complete = identityMatched && before.exists && after.exists && unchanged;
          const message = complete
            ? "The exact player's FogExploration document is readable and unchanged across two direct reads."
            : !identityMatched
              ? "The fog read returned a different Scene or user identity."
              : !unchanged
                ? "The FogExploration document changed across two direct reads."
                : "No FogExploration document exists for the exact Scene and user.";
          return {
            status: complete ? "pass" : "fail",
            message,
            evidence: {
              identityMatched,
              beforeSceneId: before.sceneId,
              afterSceneId: after.sceneId,
              beforeUserId: before.userId,
              afterUserId: after.userId,
              exists: after.exists,
              documentId: after.documentId,
              beforeRevision: before.revision,
              afterRevision: after.revision,
              unchanged,
              positionCount: Object.keys(after.state.positions).length,
              hasExploredTexture: after.state.explored !== null,
            },
          };
        });

        await probe(checks, { id: "player-visibility", requirement: "MCP-REQ-005" }, async () => {
          const result = sceneVisibilityOutputSchema.parse(
            await dependencies.visibility.handler(
              {
                sceneId: input.sceneId,
                effectiveUserId: input.playerUserId,
                clientId: input.playerClientId,
                tokenId: input.playerTokenId,
                includeImage: false,
                ...(input.queryPoints ? { queryPoints: input.queryPoints } : {}),
              },
              ctx,
            ),
          );
          const complete =
            result.sceneId === input.sceneId &&
            result.effectiveUserId === input.playerUserId &&
            result.tokenId === input.playerTokenId &&
            result.context.selectedUser === true &&
            result.context.selectedToken === true &&
            result.context.tokenOwned === true &&
            result.context.sceneLoaded === true &&
            result.status === "complete" &&
            result.persistence.unchanged === true &&
            result.persistence.beforeRevision === result.persistence.afterRevision &&
            result.environment.fog === "complete" &&
            result.environment.lighting === "complete" &&
            result.environment.darkness === "complete" &&
            result.environment.vision === "complete" &&
            result.environment.regions === "complete" &&
            result.isolation.status === "complete" &&
            Object.values(result.redaction).every((guaranteed) => guaranteed === true) &&
            result.bounds.truncated === false &&
            result.fogRevision !== null &&
            fogSnapshot?.exists === true &&
            result.fogRevision === fogSnapshot.revision;
          const identityMatched =
            result.sceneId === input.sceneId &&
            result.effectiveUserId === input.playerUserId &&
            result.tokenId === input.playerTokenId;
          const unchanged =
            result.persistence.unchanged === true &&
            result.persistence.beforeRevision === result.persistence.afterRevision;
          const fogConsistent =
            result.fogRevision !== null &&
            fogSnapshot?.exists === true &&
            result.fogRevision === fogSnapshot.revision;
          return {
            status: complete
              ? "pass"
              : !identityMatched || !unchanged || (fogSnapshot?.exists === true && !fogConsistent)
                ? "fail"
                : "partial",
            message: complete
              ? "Player-scoped visibility and fog evidence are complete and unchanged."
              : !identityMatched
                ? "The visibility result did not match the exact Scene, user, and Token."
                : !unchanged
                  ? "The visibility probe violated the required unchanged-state invariant."
                  : fogSnapshot?.exists === true && !fogConsistent
                    ? "Rendered fog evidence conflicts with the direct FogExploration revision."
                    : "The player-scoped visibility probe completed with incomplete evidence.",
            evidence: {
              identityMatched,
              status: result.status,
              environment: result.environment,
              isolation: result.isolation,
              issueCount: result.issues.length,
              issueCodes: result.issues
                .slice(0, 100)
                .map(({ code }) => safeCode(code, "VISIBILITY_ISSUE")),
              persistence: result.persistence,
              fogRevision: result.fogRevision,
              directFogRevision: fogSnapshot?.revision ?? null,
              redaction: result.redaction,
            },
          };
        });

        await probe(checks, { id: "reference-integrity", requirement: "MCP-REQ-009" }, async () => {
          const result = referenceResultSchema.parse(
            await dependencies.references.handler(input.referenceAudit ?? {}, ctx),
          );
          const filtered = input.referenceAudit?.includeDocumentTypes !== undefined;
          const complete = result.complete && !filtered;
          const status: ValidationStatus = result.complete
            ? filtered
              ? "partial"
              : result.clean
                ? "pass"
                : "fail"
            : "partial";
          return {
            status,
            message:
              status === "pass"
                ? "The bounded campaign reference audit is complete and clean."
                : status === "fail"
                  ? "The complete campaign reference audit found broken references."
                  : "The campaign reference audit failed closed with incomplete coverage.",
            evidence: {
              complete,
              clean: complete ? result.clean : null,
              filtered,
              scannedDocuments: result.scannedDocuments,
              issueCount: result.issues.length,
              issues: result.issues.slice(0, 100).map((issue) => ({
                class: issue.class,
                code: safeCode(issue.code, "REFERENCE_ISSUE"),
                documentUuid: bounded(issue.documentUuid, 256),
                target: safeReferenceTarget(issue.target),
              })),
              classes: result.classes.map((entry) => ({
                class: entry.class,
                complete: entry.complete,
                scanned: entry.scanned,
                issueCount: entry.issueCount,
                reason: bounded(entry.reason),
              })),
            },
          };
        });

        await probe(checks, { id: "wall-topology", requirement: "MCP-REQ-010" }, async () => {
          const result = wallTopologyOutputSchema.parse(
            await dependencies.topology.handler({ sceneId: input.sceneId }, ctx),
          );
          const defects =
            result.malformedWallIds.length +
            result.zeroLengthWallIds.length +
            result.duplicateGroups.length +
            result.danglingEndpointWallIds.length +
            result.crossingPairs.length;
          const complete = result.status === "complete";
          const identityMatched = result.sceneId === input.sceneId;
          const readOnly = result.persisted === false;
          const unchanged = result.unchanged === true;
          return {
            status:
              !identityMatched || !readOnly || !unchanged || defects > 0
                ? "fail"
                : complete
                  ? "pass"
                  : "partial",
            message:
              identityMatched && complete && defects === 0 && readOnly && unchanged
                ? "Wall topology is complete with no structural defects."
                : "Wall topology is incomplete or contains structural findings.",
            evidence: {
              identityMatched,
              status: result.status,
              wallCount: result.wallCount,
              malformedWallIds: result.malformedWallIds.slice(0, 100),
              zeroLengthWallIds: result.zeroLengthWallIds.slice(0, 100),
              duplicateGroups: result.duplicateGroups
                .slice(0, 100)
                .map((group) => group.slice(0, 100)),
              danglingEndpointWallIds: result.danglingEndpointWallIds.slice(0, 100),
              crossingPairs: result.crossingPairs.slice(0, 100),
              findingCounts: {
                malformed: result.malformedWallIds.length,
                zeroLength: result.zeroLengthWallIds.length,
                duplicateGroups: result.duplicateGroups.length,
                danglingEndpoints: result.danglingEndpointWallIds.length,
                crossingPairs: result.crossingPairs.length,
              },
              projectionTruncated:
                result.malformedWallIds.length > 100 ||
                result.zeroLengthWallIds.length > 100 ||
                result.duplicateGroups.length > 100 ||
                result.duplicateGroups.some((group) => group.length > 100) ||
                result.danglingEndpointWallIds.length > 100 ||
                result.crossingPairs.length > 100,
              incompleteReasons: result.incompleteReasons
                .slice(0, 100)
                .map((reason) => bounded(reason) ?? "INCOMPLETE_RESULT"),
              persisted: result.persisted,
              unchanged,
            },
          };
        });

        if (!input.pathCases?.length) {
          checks.push({
            id: "collision-paths",
            requirement: "MCP-REQ-010",
            status: "partial",
            message: "No caller-defined collision path cases were supplied.",
            evidence: { cases: [] },
          });
        } else {
          await probe(checks, { id: "collision-paths", requirement: "MCP-REQ-010" }, async () => {
            const results = await Promise.all(
              input.pathCases!.map(async (pathCase) => {
                try {
                  const result = collisionPathOutputSchema.parse(
                    await dependencies.collision.handler(
                      {
                        sceneId: input.sceneId,
                        tokenId: input.playerTokenId,
                        waypoints: pathCase.waypoints,
                        movementMode: pathCase.movementMode,
                        ...(pathCase.simulatedDoors
                          ? { simulatedDoors: pathCase.simulatedDoors }
                          : {}),
                      },
                      ctx,
                    ),
                  );
                  const observedWalls = result.firstCollision
                    ? (result.segments[result.firstCollision.segmentIndex]
                        ?.firstCollisionWallIds ?? [result.firstCollision.wallId])
                    : [];
                  const expectedWalls = pathCase.expectedFirstCollisionWallIds;
                  const expectationComplete =
                    pathCase.expectedReachable !== undefined && expectedWalls !== undefined;
                  const expectationMatched =
                    (pathCase.expectedReachable === undefined ||
                      result.reachable === pathCase.expectedReachable) &&
                    (expectedWalls === undefined ||
                      (expectedWalls.length === observedWalls.length &&
                        expectedWalls.every((wallId) => observedWalls.includes(wallId))));
                  const identityMatched =
                    result.sceneId === input.sceneId &&
                    result.tokenId === input.playerTokenId &&
                    result.movementMode === pathCase.movementMode;
                  return {
                    id: pathCase.id,
                    waypoints: pathCase.waypoints.map(({ x, y, elevation }) => ({
                      x,
                      y,
                      ...(elevation === undefined ? {} : { elevation }),
                    })),
                    movementMode: pathCase.movementMode,
                    simulatedDoors: Object.fromEntries(
                      Object.entries(pathCase.simulatedDoors ?? {}).slice(0, 100),
                    ),
                    expectedReachable: pathCase.expectedReachable ?? null,
                    expectedFirstCollisionWallIds: pathCase.expectedFirstCollisionWallIds ?? null,
                    status: result.status,
                    failureStatus: null,
                    identityMatched,
                    reachable: result.reachable,
                    persisted: result.persisted,
                    unchanged: result.evidence.unchanged,
                    firstCollisionWallIds: observedWalls.slice(0, 100),
                    firstCollisionWallCount: observedWalls.length,
                    firstCollisionWallsTruncated: observedWalls.length > 100,
                    expectationMatched,
                    incompleteReasonCount: result.incompleteReasons.length,
                    incompleteReasons: result.incompleteReasons
                      .slice(0, 100)
                      .map((reason) => bounded(reason) ?? "INCOMPLETE_RESULT"),
                    gridFit: {
                      valid: result.gridFit.valid,
                      errors: result.gridFit.errors
                        .slice(0, 100)
                        .map((entry) => bounded(entry) ?? "GRID_ERROR"),
                      warnings: result.gridFit.warnings
                        .slice(0, 100)
                        .map((entry) => bounded(entry) ?? "GRID_WARNING"),
                    },
                    modeSupport: {
                      status: result.modeSupport.status,
                      warnings: result.modeSupport.warnings
                        .slice(0, 100)
                        .map((entry) => bounded(entry) ?? "MODE_WARNING"),
                    },
                    burrowPolicy: {
                      ...result.burrowPolicy,
                      unprovenSegmentIndexes: result.burrowPolicy.unprovenSegmentIndexes.slice(
                        0,
                        256,
                      ),
                      warnings: result.burrowPolicy.warnings
                        .slice(0, 100)
                        .map((entry) => bounded(entry) ?? "BURROW_POLICY_WARNING"),
                    },
                    expectationComplete,
                  };
                } catch (error) {
                  const isolated = failure(error);
                  return {
                    id: pathCase.id,
                    waypoints: pathCase.waypoints.map(({ x, y, elevation }) => ({
                      x,
                      y,
                      ...(elevation === undefined ? {} : { elevation }),
                    })),
                    movementMode: pathCase.movementMode,
                    simulatedDoors: Object.fromEntries(
                      Object.entries(pathCase.simulatedDoors ?? {}).slice(0, 100),
                    ),
                    expectedReachable: pathCase.expectedReachable ?? null,
                    expectedFirstCollisionWallIds: pathCase.expectedFirstCollisionWallIds ?? null,
                    status: "failed",
                    failureStatus: isolated.status,
                    identityMatched: null,
                    reachable: null,
                    persisted: null,
                    unchanged: null,
                    firstCollisionWallIds: [],
                    firstCollisionWallCount: 0,
                    firstCollisionWallsTruncated: false,
                    expectationMatched: false,
                    expectationComplete:
                      pathCase.expectedReachable !== undefined &&
                      pathCase.expectedFirstCollisionWallIds !== undefined,
                    incompleteReasonCount: 1,
                    incompleteReasons: [String(isolated.evidence?.["code"] ?? "VALIDATION_ERROR")],
                    gridFit: null,
                    modeSupport: null,
                    burrowPolicy: null,
                  };
                }
              }),
            );
            const incomplete = results.some((result) => result.status !== "complete");
            const changed = results.some((result) => result.unchanged === false);
            const identityMismatch = results.some((result) => result.identityMatched === false);
            const mismatch = results.some(
              (result) => result.status === "complete" && !result.expectationMatched,
            );
            const missingExpectation = results.some((result) => !result.expectationComplete);
            const failed = results.some(
              (result) => result.status === "failed" && result.failureStatus === "fail",
            );
            const blocked = results.some(
              (result) => result.status === "failed" && result.failureStatus === "blocked",
            );
            return {
              status:
                identityMismatch || mismatch || changed || failed
                  ? "fail"
                  : blocked
                    ? "blocked"
                    : incomplete || missingExpectation
                      ? "partial"
                      : "pass",
              message: identityMismatch
                ? "A collision result did not match the requested Scene, Token, or movement mode."
                : mismatch
                  ? "One or more collision path expectations did not match."
                  : changed
                    ? "A collision probe violated the required read-only unchanged-state invariant."
                    : failed
                      ? "One or more collision probes returned a typed failure."
                      : blocked
                        ? "One or more collision probes could not run because a required capability was unavailable."
                        : incomplete
                          ? "Collision paths ran, but some evidence is incomplete."
                          : missingExpectation
                            ? "Collision paths ran read-only, but one or more expected outcomes were omitted."
                            : "All supplied collision paths matched with unchanged-state evidence.",
              evidence: { cases: results },
            };
          });
        }

        await probe(checks, { id: "movement-store", requirement: "MCP-REQ-013" }, async () => {
          const result = dependencies.movementDiagnostics();
          const integrityFinding = result.issueCodes.some(
            (code) => code !== "STORE_NOT_CONFIGURED",
          );
          const status: ValidationStatus = !result.configured
            ? "blocked"
            : integrityFinding || !result.valid
              ? "fail"
              : !result.runtimeAvailable
                ? "blocked"
                : result.valid
                  ? "pass"
                  : "fail";
          return {
            status,
            message:
              status === "pass"
                ? "The durable movement store is readable and internally consistent."
                : !result.configured
                  ? "The durable movement path is not configured."
                  : integrityFinding || !result.valid
                    ? "The durable movement store has a typed integrity finding and was not modified."
                    : "The durable movement path is configured and valid, but its runtime is unavailable.",
            evidence: {
              configured: result.configured,
              runtimeAvailable: result.runtimeAvailable,
              readable: result.readable,
              valid: result.valid,
              version: result.version,
              generation: result.generation,
              eventCount: result.eventCount,
              nextSequence: result.nextSequence,
              issueCodeCount: result.issueCodes.length,
              issueCodes: result.issueCodes.slice(0, 100),
            },
          };
        });

        const overall = aggregate(checks);
        return {
          generatedAt: new Date().toISOString(),
          readOnly: true as const,
          correlationId: input.correlationId,
          sceneId: input.sceneId,
          playerUserId: input.playerUserId,
          playerTokenId: input.playerTokenId,
          playerClientId: input.playerClientId,
          overall,
          summary: {
            pass: count(checks, "pass"),
            partial: count(checks, "partial"),
            fail: count(checks, "fail"),
            blocked: count(checks, "blocked"),
          },
          checks,
        };
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
  ];
}
