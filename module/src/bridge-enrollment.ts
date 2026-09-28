import {
  BRIDGE_ENROLLMENT_COMMANDS,
  BRIDGE_ENROLLMENT_QUERY,
  BRIDGE_PROTOCOL_VERSION,
  ProtocolError,
  type BridgeEnrollmentDeliveryInput,
  type BridgeEnrollmentTargetInput,
  type BridgeEnrollmentTargetResult,
  type EnrollableBridgeLane,
} from "@foundry-local-api/shared";

import {
  ALLOW_REMOTE_CONTROL_SETTING,
  MODULE_ID,
  getClientId,
  getClientLane,
  type AcceptedBridgeEnrollment,
  type BridgeClient,
} from "./bridge-client.js";
import { registerCommand } from "./command-registry.js";

// Foundry 14.368's Users collection constructs this second argument in
// client/documents/collections/users.mjs#handleUserQuery from the
// server-authenticated socket sender ID (`{...queryOptions, user}`). Keep the
// sender check here; query data alone is not an authentication boundary.
type UserQueryContext = { user: FoundryUser; timeout?: number };
type EnrollmentQueryRegistry = Record<
  string,
  (input: BridgeEnrollmentTargetInput, context: UserQueryContext) => Promise<unknown> | unknown
>;

let getBridgeClient: (() => BridgeClient | undefined) | undefined;
let enrollmentKeyPair: Promise<CryptoKeyPair> | undefined;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): ArrayBuffer {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer as ArrayBuffer;
}

function getEnrollmentKeyPair(): Promise<CryptoKeyPair> {
  enrollmentKeyPair ??= crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    false,
    ["encrypt", "decrypt"],
  );
  return enrollmentKeyPair;
}

async function enrollmentPublicKey(): Promise<string> {
  const pair = await getEnrollmentKeyPair();
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  return bytesToBase64(new Uint8Array(spki));
}

async function decryptEnrollmentCredential(ciphertext: string): Promise<string> {
  const pair = await getEnrollmentKeyPair();
  const plaintext = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    pair.privateKey,
    base64ToBytes(ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

function localModuleVersion(): string {
  return game.modules.get(MODULE_ID)?.version ?? "unknown";
}

async function safeResult(
  expectedLane: EnrollableBridgeLane,
  delivery: BridgeEnrollmentTargetResult["delivery"],
  errorCode: BridgeEnrollmentTargetResult["errorCode"],
): Promise<BridgeEnrollmentTargetResult> {
  const diagnostics = getBridgeClient?.()?.getDiagnostics();
  const moduleVersion = localModuleVersion();
  const userId = game.user.id;
  const consentGranted = game.settings.get<boolean>(MODULE_ID, ALLOW_REMOTE_CONTROL_SETTING);
  return {
    moduleLoaded: true,
    moduleVersion,
    userId,
    clientId: getClientId(),
    enrollmentPublicKey: await enrollmentPublicKey(),
    intendedLane: getClientLane(),
    consentGranted,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    foundryVersion: game.release.version,
    systemId: game.system.id,
    systemVersion: game.system.version,
    delivery,
    errorCode,
    diagnostics: diagnostics ?? {
      moduleLoaded: true,
      moduleVersion,
      userId,
      intendedLane: expectedLane,
      consentGranted,
      connectionState: "disconnected",
      lastConnectionAttemptAt: null,
      lastNegotiationResult: null,
      errorCode: "enrollment-required",
      reconnect: { state: "idle", attempt: 0, nextAttemptAt: null },
    },
  };
}

async function validateDelivery(
  input: BridgeEnrollmentDeliveryInput,
): Promise<BridgeEnrollmentTargetResult | null> {
  if (input.targetUserId !== game.user.id)
    return safeResult(input.expectedLane, "rejected", "ENROLLMENT_USER_MISMATCH");
  if (input.expectedClientId !== getClientId())
    return safeResult(input.expectedLane, "rejected", "ENROLLMENT_CLIENT_MISMATCH");
  if (input.expectedLane !== getClientLane())
    return safeResult(input.expectedLane, "rejected", "ENROLLMENT_LANE_MISMATCH");
  if (input.protocolVersion !== BRIDGE_PROTOCOL_VERSION)
    return safeResult(input.expectedLane, "rejected", "ENROLLMENT_PROTOCOL_MISMATCH");
  if (input.moduleVersion !== localModuleVersion())
    return safeResult(input.expectedLane, "rejected", "ENROLLMENT_MODULE_MISMATCH");
  if (!game.settings.get<boolean>(MODULE_ID, ALLOW_REMOTE_CONTROL_SETTING))
    return safeResult(input.expectedLane, "consent-required", "CONSENT_REQUIRED");
  return null;
}

/** Registers Foundry's authenticated targeted User.query receiver on every module client. */
export function registerBridgeEnrollmentQuery(client: () => BridgeClient | undefined): void {
  getBridgeClient = client;
  const queries = (CONFIG as unknown as { queries?: EnrollmentQueryRegistry }).queries;
  if (!queries) throw new Error("Foundry User query registry is unavailable.");
  queries[BRIDGE_ENROLLMENT_QUERY] = async (
    input: BridgeEnrollmentTargetInput,
    context: UserQueryContext,
  ): Promise<BridgeEnrollmentTargetResult> => {
    if (!context.user.isGM) {
      throw new ProtocolError({
        code: "PERMISSION_DENIED",
        message: "Bridge enrollment offers are accepted only from an authenticated GM user query.",
        retryable: false,
      });
    }
    if (input.targetUserId !== game.user.id)
      return safeResult(input.expectedLane, "rejected", "ENROLLMENT_USER_MISMATCH");
    if (input.action === "probe") return safeResult(input.expectedLane, "not-requested", null);
    const rejected = await validateDelivery(input);
    if (rejected) return rejected;
    const bridgeClient = getBridgeClient?.();
    if (!bridgeClient) return safeResult(input.expectedLane, "rejected", "MODULE_NOT_OBSERVED");
    let credential: string;
    try {
      credential = await decryptEnrollmentCredential(input.encryptedCredential);
    } catch {
      return safeResult(input.expectedLane, "rejected", "ENROLLMENT_INVALID");
    }
    const accepted: AcceptedBridgeEnrollment = {
      action: "deliver",
      targetUserId: input.targetUserId,
      expectedLane: input.expectedLane,
      expectedClientId: input.expectedClientId,
      credential,
      expiresAt: input.expiresAt,
      protocolVersion: input.protocolVersion,
      moduleVersion: input.moduleVersion,
    };
    bridgeClient.acceptEnrollment(accepted);
    return safeResult(input.expectedLane, "accepted", null);
  };
}

/** Runs on the API-key-authenticated GM lane and delegates through Foundry's targeted User.query. */
export async function targetBridgeEnrollment(
  input: BridgeEnrollmentTargetInput,
): Promise<BridgeEnrollmentTargetResult> {
  if (!game.user.isGM) {
    throw new ProtocolError({
      code: "PERMISSION_DENIED",
      message: "Only the connected GM lane may target a bridge enrollment query.",
      retryable: false,
    });
  }
  const target = game.users.get(input.targetUserId);
  if (!target?.active) {
    throw new ProtocolError({
      code: "MODULE_NOT_OBSERVED",
      message: "The target Foundry user is not active.",
      retryable: true,
    });
  }
  try {
    return (await target.query(BRIDGE_ENROLLMENT_QUERY, input, {
      timeout: 5_000,
    })) as BridgeEnrollmentTargetResult;
  } catch {
    throw new ProtocolError({
      code: "MODULE_NOT_OBSERVED",
      message: "The target module did not acknowledge the enrollment query.",
      retryable: true,
    });
  }
}

registerCommand(BRIDGE_ENROLLMENT_COMMANDS.TARGET, targetBridgeEnrollment);
