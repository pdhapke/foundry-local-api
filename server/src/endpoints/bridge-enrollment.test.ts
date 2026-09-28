import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";

import express from "express";
import request from "supertest";

import type {
  BridgeEnrollmentTargetInput,
  BridgeEnrollmentTargetResult,
  CapabilityReport,
} from "@foundry-local-api/shared";

import { EnrollmentStore } from "../bridge/enrollment-store.js";
import type { FoundryClient } from "../bridge/foundry-client.js";
import { createApiKeyAuth } from "../middleware/auth.js";
import { bridgeEnrollmentEndpointDescriptors } from "./bridge-enrollment.js";

const enrollmentPublicKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .publicKey.export({
    format: "der",
    type: "spki",
  })
  .toString("base64");

const gm = {
  clientId: "gm-client",
  userId: "X7X4KK7zca5U2Ics",
  userName: "Gamemaster",
  isGM: true,
  lane: "gm" as const,
  optedIn: true,
  protocolVersion: 2,
  foundryVersion: "14.368",
  systemId: "dnd5e",
  systemVersion: "6.0.3",
  moduleVersion: "0.1.0",
  transport: "websocket" as const,
  connectedAt: 1,
  lastSeenAt: 1,
  capabilities: ["bridgeEnrollmentTarget"],
};

function report(withGm = true): CapabilityReport {
  return {
    generatedAt: 1,
    serverVersion: "0.1.0",
    protocolVersion: 2,
    clients: withGm ? [gm] : [],
    capabilities: [],
  };
}

function targetResult(
  input: BridgeEnrollmentTargetInput,
  consentGranted = true,
): BridgeEnrollmentTargetResult {
  return {
    moduleLoaded: true,
    moduleVersion: "0.1.0",
    userId: input.targetUserId,
    clientId: "target-client",
    enrollmentPublicKey,
    intendedLane: input.expectedLane,
    consentGranted,
    protocolVersion: 2,
    foundryVersion: "14.368",
    systemId: "dnd5e",
    systemVersion: "6.0.3",
    delivery: input.action === "deliver" ? "accepted" : "not-requested",
    errorCode: null,
    diagnostics: {
      moduleLoaded: true,
      moduleVersion: "0.1.0",
      userId: input.targetUserId,
      intendedLane: input.expectedLane,
      consentGranted,
      connectionState: "disconnected",
      lastConnectionAttemptAt: null,
      lastNegotiationResult: null,
      errorCode: "enrollment-required",
      reconnect: { state: "idle", attempt: 0, nextAttemptAt: null },
    },
  };
}

void describe("Phase 0R enrollment endpoints", () => {
  void it("probes and delivers through the GM lane without returning the credential", async () => {
    const calls: BridgeEnrollmentTargetInput[] = [];
    const callOptions: unknown[] = [];
    const foundryClient = {
      getCapabilityReport: () => report(),
      call: async (_command: string, input: BridgeEnrollmentTargetInput, options: unknown) => {
        calls.push(input);
        callOptions.push(options);
        return targetResult(input);
      },
    } as unknown as FoundryClient;
    const enrollments = new EnrollmentStore({
      laneCommandAllowlist: { player: ["effectiveUserExecute"] },
    });
    const descriptor = bridgeEnrollmentEndpointDescriptors[0]!;
    const result = (await descriptor.handler(
      { userId: "edtBL96Yu3058QAT", lane: "player", ttlMs: 30_000 },
      {
        foundryClient,
        foundations: { enrollments } as never,
      },
    )) as Record<string, unknown>;
    assert.deepEqual(
      calls.map(({ action }) => action),
      ["probe", "deliver"],
    );
    assert.equal("credential" in result, false);
    assert.equal(JSON.stringify(result).includes("fle1_"), false);
    assert.equal(JSON.stringify(callOptions).includes("credential"), false);
    const delivered = calls.find((call) => call.action === "deliver");
    assert.ok(delivered && delivered.action === "deliver");
    assert.equal("credential" in delivered, false);
    assert.ok(delivered.encryptedCredential.length > 100);
    assert.equal(enrollments.pendingCount(), 1);
  });

  void it("requires both a connected GM and explicit target consent", async () => {
    const descriptor = bridgeEnrollmentEndpointDescriptors[0]!;
    const noGmEnrollments = new EnrollmentStore();
    await assert.rejects(
      descriptor.handler(
        { userId: "edtBL96Yu3058QAT", lane: "player" },
        {
          foundryClient: { getCapabilityReport: () => report(false) } as FoundryClient,
          foundations: { enrollments: noGmEnrollments } as never,
        },
      ),
      (error: unknown) => (error as { code?: string }).code === "NO_CONNECTED_GM",
    );
    assert.equal(noGmEnrollments.listEvents().at(-1)?.reason, "no_connected_gm");
    const noConsentEnrollments = new EnrollmentStore();
    await assert.rejects(
      descriptor.handler(
        { userId: "edtBL96Yu3058QAT", lane: "player" },
        {
          foundryClient: {
            getCapabilityReport: () => report(),
            call: async (_command: string, input: BridgeEnrollmentTargetInput) =>
              targetResult(input, false),
          } as unknown as FoundryClient,
          foundations: { enrollments: noConsentEnrollments } as never,
        },
      ),
      (error: unknown) => (error as { code?: string }).code === "CONSENT_REQUIRED",
    );
    assert.equal(noConsentEnrollments.listEvents().at(-1)?.reason, "consent_required");
  });

  void it("cannot use a scoped enrollment credential as REST or MCP authentication", async () => {
    const store = new EnrollmentStore();
    const issued = store.issue({
      issuer: { userId: "gm", clientId: "gm-client", isGM: true, connected: true },
      expectedUserId: "player",
      expectedClientId: "player-client",
      lane: "player",
      protocolVersion: 2,
      moduleVersion: { kind: "exact", version: "0.1.0" },
    });
    const app = express();
    app.use(["/api", "/mcp"], createApiKeyAuth("administrative-master-key"));
    app.get("/api/test", (_req, res) => res.json({ ok: true }));
    app.post("/mcp", (_req, res) => res.json({ ok: true }));
    assert.equal(
      (await request(app).get("/api/test").set("x-api-key", issued.credential)).status,
      401,
    );
    assert.equal(
      (await request(app).post("/mcp").set("Authorization", `Bearer ${issued.credential}`)).status,
      401,
    );
  });
});
