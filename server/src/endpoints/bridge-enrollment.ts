import { constants, createPublicKey, publicEncrypt } from "node:crypto";

import { z } from "zod";

import {
  BRIDGE_ENROLLMENT_COMMANDS,
  BRIDGE_PROTOCOL_VERSION,
  ProtocolError,
  type BridgeEnrollmentTargetInput,
  type BridgeEnrollmentTargetResult,
  type IssueBridgeEnrollmentInput,
  type IssueBridgeEnrollmentResult,
} from "@foundry-local-api/shared";

import { EnrollmentIssueError, type EnrollmentStore } from "../bridge/enrollment-store.js";
import type { FoundryClient } from "../bridge/foundry-client.js";
import type { FoundationRuntime } from "../foundations/runtime.js";
import { readPackageVersion } from "../version.js";
import {
  enrollmentDiagnosticsOutputSchema,
  issueEnrollmentOutputSchema,
} from "./requirement-output-schemas.js";
import type { AnyEndpointDescriptor } from "./types.js";

const issueSchema = z
  .object({
    userId: z.string().min(1).max(128),
    lane: z.enum(["player", "tv"]),
    ttlMs: z.number().int().min(1_000).max(600_000).optional(),
  })
  .strict();

function requireEnrollmentStore(foundations?: FoundationRuntime): EnrollmentStore {
  const store = foundations?.enrollments;
  if (!store) throw new Error("Bridge enrollment runtime is not configured.");
  return store;
}

function connectedGm(foundryClient: FoundryClient) {
  return foundryClient
    .getCapabilityReport()
    .clients.filter((client) => client.isGM && client.lane === "gm" && client.optedIn)
    .sort(
      (left, right) =>
        left.connectedAt - right.connectedAt || left.clientId.localeCompare(right.clientId),
    )[0];
}

function encryptEnrollmentCredential(credential: string, publicKeySpki: string): string {
  if (publicKeySpki.length < 128 || publicKeySpki.length > 2048) {
    throw new ProtocolError({
      code: "ENROLLMENT_INVALID",
      message: "The targeted client returned an invalid ephemeral enrollment key.",
      retryable: false,
    });
  }
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeySpki, "base64"),
      format: "der",
      type: "spki",
    });
    return publicEncrypt(
      {
        key,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(credential, "utf8"),
    ).toString("base64");
  } catch {
    throw new ProtocolError({
      code: "ENROLLMENT_INVALID",
      message: "The targeted client returned an unusable ephemeral enrollment key.",
      retryable: false,
    });
  }
}

async function issueEnrollment(
  input: IssueBridgeEnrollmentInput,
  foundryClient: FoundryClient,
  foundations?: FoundationRuntime,
): Promise<IssueBridgeEnrollmentResult> {
  const store = requireEnrollmentStore(foundations);
  const gm = connectedGm(foundryClient);
  if (!gm) {
    store.recordRejectedObservation({
      expectedUserId: input.userId,
      expectedLane: input.lane,
      reason: "no_connected_gm",
      expectedProtocolVersion: BRIDGE_PROTOCOL_VERSION,
    });
    throw new ProtocolError({
      code: "NO_CONNECTED_GM",
      message: "A connected opted-in GM bridge lane is required to authorize enrollment.",
      retryable: true,
    });
  }
  let probe: BridgeEnrollmentTargetResult;
  try {
    probe = await foundryClient.call<BridgeEnrollmentTargetInput, BridgeEnrollmentTargetResult>(
      BRIDGE_ENROLLMENT_COMMANDS.TARGET,
      { action: "probe", targetUserId: input.userId, expectedLane: input.lane },
      {
        clientId: gm.clientId,
        lane: "gm",
        auditPayloadSummary: {
          action: "probe",
          targetUserId: input.userId,
          expectedLane: input.lane,
        },
      },
    );
  } catch (error) {
    store.recordRejectedObservation({
      expectedUserId: input.userId,
      expectedLane: input.lane,
      reason: "module_not_observed",
      expectedProtocolVersion: BRIDGE_PROTOCOL_VERSION,
    });
    throw error;
  }
  if (probe.userId !== input.userId) {
    store.recordRejectedObservation({
      expectedUserId: input.userId,
      expectedLane: input.lane,
      reason: "wrong_user",
      observedUserId: probe.userId,
      observedLane: probe.intendedLane,
      clientId: probe.clientId,
    });
    throw new ProtocolError({
      code: "ENROLLMENT_USER_MISMATCH",
      message: "The targeted Foundry client reported a different signed-in user.",
      retryable: false,
    });
  }
  if (!probe.consentGranted) {
    store.recordRejectedObservation({
      expectedUserId: input.userId,
      expectedLane: input.lane,
      reason: "consent_required",
      observedUserId: probe.userId,
      observedLane: probe.intendedLane,
      clientId: probe.clientId,
    });
    throw new ProtocolError({
      code: "CONSENT_REQUIRED",
      message: "The targeted client has not enabled bounded remote control.",
      retryable: false,
    });
  }
  if (probe.intendedLane !== input.lane) {
    store.recordRejectedObservation({
      expectedUserId: input.userId,
      expectedLane: input.lane,
      reason: "wrong_lane",
      observedUserId: probe.userId,
      observedLane: probe.intendedLane,
      clientId: probe.clientId,
    });
    throw new ProtocolError({
      code: "ENROLLMENT_LANE_MISMATCH",
      message: "The targeted client reports a different intended bridge lane.",
      retryable: false,
    });
  }
  if (probe.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
    store.recordRejectedObservation({
      expectedUserId: input.userId,
      expectedLane: input.lane,
      reason: "wrong_protocol_version",
      observedUserId: probe.userId,
      observedLane: probe.intendedLane,
      expectedProtocolVersion: BRIDGE_PROTOCOL_VERSION,
      observedProtocolVersion: probe.protocolVersion,
      clientId: probe.clientId,
    });
    throw new ProtocolError({
      code: "ENROLLMENT_PROTOCOL_MISMATCH",
      message: "The targeted client uses an incompatible bridge protocol.",
      retryable: false,
    });
  }
  if (probe.moduleVersion !== readPackageVersion()) {
    store.recordRejectedObservation({
      expectedUserId: input.userId,
      expectedLane: input.lane,
      reason: "wrong_module_version",
      observedUserId: probe.userId,
      observedLane: probe.intendedLane,
      observedModuleVersion: probe.moduleVersion,
      clientId: probe.clientId,
    });
    throw new ProtocolError({
      code: "ENROLLMENT_MODULE_MISMATCH",
      message: "The targeted client module version does not match the bridge server version.",
      retryable: false,
    });
  }
  let issued;
  try {
    issued = store.rotate({
      issuer: { userId: gm.userId, clientId: gm.clientId, isGM: gm.isGM, connected: true },
      expectedUserId: input.userId,
      expectedClientId: probe.clientId,
      lane: input.lane,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      moduleVersion: { kind: "exact", version: probe.moduleVersion },
      ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
    });
  } catch (error) {
    if (error instanceof EnrollmentIssueError) {
      throw new ProtocolError({
        code: error.code === "no_connected_gm" ? "NO_CONNECTED_GM" : "INVALID_PAYLOAD",
        message: error.message,
        retryable: error.code === "no_connected_gm",
      });
    }
    throw error;
  }
  const deliveredAt = new Date().toISOString();
  const encryptedCredential = encryptEnrollmentCredential(
    issued.credential,
    probe.enrollmentPublicKey,
  );
  const delivered = await foundryClient.call<
    BridgeEnrollmentTargetInput,
    BridgeEnrollmentTargetResult
  >(
    BRIDGE_ENROLLMENT_COMMANDS.TARGET,
    {
      action: "deliver",
      targetUserId: input.userId,
      expectedLane: input.lane,
      expectedClientId: probe.clientId,
      encryptedCredential,
      expiresAt: new Date(issued.enrollment.expiresAt).toISOString(),
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      moduleVersion: probe.moduleVersion,
    },
    {
      clientId: gm.clientId,
      lane: "gm",
      auditPayloadSummary: {
        action: "deliver",
        targetUserId: input.userId,
        expectedLane: input.lane,
        expectedClientId: probe.clientId,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        moduleVersion: probe.moduleVersion,
      },
    },
  );
  if (delivered.delivery !== "accepted") {
    throw new ProtocolError({
      code: delivered.errorCode ?? "MODULE_NOT_OBSERVED",
      message: "The targeted client did not accept the scoped enrollment offer.",
      retryable: delivered.errorCode === "MODULE_NOT_OBSERVED",
    });
  }
  return {
    enrollmentId: issued.enrollment.enrollmentId,
    userId: input.userId,
    lane: input.lane,
    clientId: probe.clientId,
    scope: "/bridge",
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    moduleVersion: probe.moduleVersion,
    expiresAt: new Date(issued.enrollment.expiresAt).toISOString(),
    deliveredAt,
    client: delivered,
  };
}

export const bridgeEnrollmentEndpointDescriptors: AnyEndpointDescriptor[] = [
  {
    name: "foundry_issue_bridge_enrollment",
    description:
      "Uses the authenticated GM lane and Foundry's targeted User query to deliver a short-lived, one-time, /bridge-only credential to one consenting player or TV client. The credential is never returned.",
    method: "post",
    path: "/bridge/enrollments",
    inputSchema: issueSchema,
    outputSchema: issueEnrollmentOutputSchema,
    handler: (input: IssueBridgeEnrollmentInput, { foundryClient, foundations }) =>
      issueEnrollment(input, foundryClient, foundations),
  },
  {
    name: "foundry_get_bridge_enrollment_diagnostics",
    description:
      "Returns secrecy-safe pending, active, and recent enrollment metadata. It never returns credentials, digests, URLs, headers, cookies, or device data.",
    method: "get",
    path: "/bridge/enrollments/diagnostics",
    outputSchema: enrollmentDiagnosticsOutputSchema,
    handler: (_input: void, { foundations, foundryClient }) => ({
      generatedAt: new Date().toISOString(),
      ...requireEnrollmentStore(foundations).getDiagnostics(),
      connectedClients: foundryClient.getCapabilityReport().clients,
    }),
    annotations: { readOnlyHint: true },
  },
];
