import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { describe, it } from "node:test";

import {
  BRIDGE_ENROLLMENT_QUERY,
  type BridgeEnrollmentDeliveryInput,
  type BridgeEnrollmentTargetInput,
  type BridgeEnrollmentTargetResult,
} from "@foundry-local-api/shared";

import type { BridgeClient } from "./bridge-client.js";
import { registerBridgeEnrollmentQuery } from "./bridge-enrollment.js";

function installGlobals(consent: boolean) {
  const settings = new Map<string, unknown>([["foundry-local-api.allowRemoteControl", consent]]);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      values: new Map<string, string>([["foundry-local-api.clientId", "player-client"]]),
      getItem(key: string) {
        return this.values.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        this.values.set(key, value);
      },
    },
  });
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: webcrypto,
  });
  Object.defineProperty(globalThis, "CONFIG", {
    configurable: true,
    value: { queries: {} },
  });
  Object.defineProperty(globalThis, "game", {
    configurable: true,
    value: {
      user: { id: "player-user", name: "Test Player", isGM: false },
      release: { version: "14.368" },
      system: { id: "dnd5e", version: "6.0.3" },
      modules: new Map([["foundry-local-api", { version: "0.1.0" }]]),
      settings: {
        get: (namespace: string, key: string) => settings.get(`${namespace}.${key}`),
      },
      users: new Map(),
    },
  });
  return (
    globalThis as unknown as {
      CONFIG: { queries: Record<string, (input: unknown, context: unknown) => unknown> };
    }
  ).CONFIG.queries;
}

function delivery(
  overrides: Partial<BridgeEnrollmentDeliveryInput> = {},
): BridgeEnrollmentDeliveryInput {
  return {
    action: "deliver",
    targetUserId: "player-user",
    expectedLane: "player",
    expectedClientId: "player-client",
    encryptedCredential: "not-needed-until-bindings-pass",
    expiresAt: "2026-09-28T02:00:00.000Z",
    protocolVersion: 2,
    moduleVersion: "0.1.0",
    ...overrides,
  };
}

async function encryptFor(publicKeySpki: string, credential: string): Promise<string> {
  const binary = Buffer.from(publicKeySpki, "base64");
  const key = await webcrypto.subtle.importKey(
    "spki",
    binary,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const encrypted = await webcrypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    key,
    new TextEncoder().encode(credential),
  );
  return Buffer.from(encrypted).toString("base64");
}

function diagnostics(consentGranted: boolean) {
  return {
    moduleLoaded: true as const,
    moduleVersion: "0.1.0",
    userId: "player-user",
    intendedLane: "player" as const,
    consentGranted,
    connectionState: "disconnected" as const,
    lastConnectionAttemptAt: null,
    lastNegotiationResult: null,
    errorCode: "enrollment-required" as const,
    reconnect: { state: "idle" as const, attempt: 0, nextAttemptAt: null },
  };
}

void describe("Phase 0R targeted module enrollment", () => {
  void it("reports a safe probe and preserves consent as a separate gate", async () => {
    const queries = installGlobals(false);
    let accepted = false;
    registerBridgeEnrollmentQuery(
      () =>
        ({
          acceptEnrollment: () => (accepted = true),
          getDiagnostics: () => diagnostics(false),
        }) as unknown as BridgeClient,
    );
    const handler = queries[BRIDGE_ENROLLMENT_QUERY]!;
    const context = { user: { isGM: true } };
    const probe = (await handler(
      { action: "probe", targetUserId: "player-user", expectedLane: "player" },
      context,
    )) as BridgeEnrollmentTargetResult;
    assert.equal(probe.moduleLoaded, true);
    assert.equal(probe.consentGranted, false);
    assert.equal("credential" in probe, false);
    const rejected = (await handler(delivery(), context)) as BridgeEnrollmentTargetResult;
    assert.equal(rejected.delivery, "consent-required");
    assert.equal(rejected.errorCode, "CONSENT_REQUIRED");
    assert.equal(accepted, false);
  });

  void it("accepts only exact client/user/version bindings from an authenticated GM query", async () => {
    const queries = installGlobals(true);
    const accepted: Array<{ credential: string }> = [];
    registerBridgeEnrollmentQuery(
      () =>
        ({
          acceptEnrollment: (input: { credential: string }) => accepted.push(input),
          getDiagnostics: () => diagnostics(true),
        }) as unknown as BridgeClient,
    );
    const handler = queries[BRIDGE_ENROLLMENT_QUERY]!;
    const context = { user: { isGM: true } };
    for (const [input, code] of [
      [delivery({ targetUserId: "wrong" }), "ENROLLMENT_USER_MISMATCH"],
      [delivery({ expectedClientId: "wrong" }), "ENROLLMENT_CLIENT_MISMATCH"],
      [delivery({ expectedLane: "tv" }), "ENROLLMENT_LANE_MISMATCH"],
      [delivery({ protocolVersion: 1 }), "ENROLLMENT_PROTOCOL_MISMATCH"],
      [delivery({ moduleVersion: "0.0.9" }), "ENROLLMENT_MODULE_MISMATCH"],
    ] as Array<[BridgeEnrollmentTargetInput, string]>) {
      assert.equal(
        ((await handler(input, context)) as BridgeEnrollmentTargetResult).errorCode,
        code,
      );
    }
    const probe = (await handler(
      { action: "probe", targetUserId: "player-user", expectedLane: "player" },
      context,
    )) as BridgeEnrollmentTargetResult;
    const credential = "opaque-one-time-credential-value";
    const result = (await handler(
      delivery({ encryptedCredential: await encryptFor(probe.enrollmentPublicKey, credential) }),
      context,
    )) as BridgeEnrollmentTargetResult;
    assert.equal(result.delivery, "accepted");
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]?.credential, credential);
    await assert.rejects(Promise.resolve(handler(delivery(), { user: { isGM: false } })));
  });
});
