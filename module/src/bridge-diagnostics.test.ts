import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createBridgeDiagnostics,
  observeMissingClientDiagnostics,
  projectBridgeDiagnostics,
  transitionBridgeDiagnostics,
  type BridgeClientDiagnostics,
} from "./bridge-diagnostics.js";

const INITIAL = {
  moduleVersion: "0.1.0",
  userId: "FakePlayerUser01",
  intendedLane: "player" as const,
  consentGranted: true,
};

void describe("bridge diagnostics lifecycle", () => {
  void it("tracks connecting, accepted, disconnected, scheduled, and reconnecting states", () => {
    let state = createBridgeDiagnostics(INITIAL);

    state = transitionBridgeDiagnostics(state, {
      type: "connection-attempted",
      at: "2026-09-28T01:00:00.000Z",
    });
    assert.equal(state.connectionState, "connecting");
    assert.equal(state.lastConnectionAttemptAt, "2026-09-28T01:00:00.000Z");

    state = transitionBridgeDiagnostics(state, {
      type: "negotiation-accepted",
      at: "2026-09-28T01:00:01.000Z",
      protocolVersion: 2,
      moduleVersion: "0.1.0",
    });
    assert.equal(state.connectionState, "connected");
    assert.equal(state.lastNegotiationResult?.outcome, "accepted");

    state = transitionBridgeDiagnostics(state, {
      type: "disconnected",
      errorCode: "server-unavailable",
    });
    assert.equal(state.connectionState, "disconnected");
    assert.equal(state.errorCode, "server-unavailable");

    state = transitionBridgeDiagnostics(state, {
      type: "reconnect-scheduled",
      attempt: 1,
      nextAttemptAt: "2026-09-28T01:00:03.000Z",
    });
    assert.deepEqual(state.reconnect, {
      state: "scheduled",
      attempt: 1,
      nextAttemptAt: "2026-09-28T01:00:03.000Z",
    });

    state = transitionBridgeDiagnostics(state, {
      type: "connection-attempted",
      at: "2026-09-28T01:00:03.000Z",
      reconnectAttempt: 1,
    });
    assert.equal(state.connectionState, "connecting");
    assert.deepEqual(state.reconnect, {
      state: "attempting",
      attempt: 1,
      nextAttemptAt: null,
    });
  });

  void it("records stale protocol and module versions as bounded rejection results", () => {
    let state = createBridgeDiagnostics(INITIAL);
    state = transitionBridgeDiagnostics(state, {
      type: "negotiation-rejected",
      at: "2026-09-28T01:01:00.000Z",
      protocolVersion: 1,
      moduleVersion: "0.0.9",
      errorCode: "protocol-version-mismatch",
    });
    assert.deepEqual(state.lastNegotiationResult, {
      outcome: "rejected",
      at: "2026-09-28T01:01:00.000Z",
      protocolVersion: 1,
      moduleVersion: "0.0.9",
      errorCode: "protocol-version-mismatch",
    });

    state = transitionBridgeDiagnostics(state, {
      type: "negotiation-rejected",
      at: "2026-09-28T01:02:00.000Z",
      protocolVersion: 2,
      moduleVersion: "0.0.9",
      errorCode: "module-version-mismatch",
    });
    assert.equal(state.errorCode, "module-version-mismatch");
  });

  void it("keeps missing consent explicit and records the bounded rejection", () => {
    let state = createBridgeDiagnostics({ ...INITIAL, consentGranted: false });
    state = transitionBridgeDiagnostics(state, {
      type: "negotiation-rejected",
      at: "2026-09-28T01:03:00.000Z",
      protocolVersion: 2,
      moduleVersion: "0.1.0",
      errorCode: "consent-required",
    });
    assert.equal(state.consentGranted, false);
    assert.equal(state.connectionState, "rejected");
    assert.equal(state.errorCode, "consent-required");
  });

  void it("distinguishes duplicate-client rejection from replacement of this client", () => {
    const duplicate = transitionBridgeDiagnostics(createBridgeDiagnostics(INITIAL), {
      type: "negotiation-rejected",
      at: "2026-09-28T01:04:00.000Z",
      protocolVersion: 2,
      moduleVersion: "0.1.0",
      errorCode: "duplicate-client",
    });
    assert.equal(duplicate.connectionState, "rejected");
    assert.equal(duplicate.errorCode, "duplicate-client");

    const replaced = transitionBridgeDiagnostics(duplicate, {
      type: "client-replaced",
      at: "2026-09-28T01:04:01.000Z",
      protocolVersion: 2,
    });
    assert.equal(replaced.connectionState, "rejected");
    assert.equal(replaced.errorCode, "client-replaced");
    assert.equal(replaced.lastNegotiationResult?.errorCode, "client-replaced");
  });
});

void describe("safe diagnostics projection", () => {
  void it("allowlists fields and cannot serialize runtime credential, URL, or device extras", () => {
    const diagnostics = createBridgeDiagnostics(INITIAL) as BridgeClientDiagnostics & {
      credential: string;
      websocketUrl: string;
      device: { userAgent: string };
    };
    diagnostics.credential = "one-time-secret";
    diagnostics.websocketUrl = "ws://localhost/bridge?credential=one-time-secret";
    diagnostics.device = { userAgent: "private-browser-data" };

    const serialized = JSON.stringify(projectBridgeDiagnostics(diagnostics));
    assert.equal(serialized.includes("one-time-secret"), false);
    assert.equal(serialized.includes("websocketUrl"), false);
    assert.equal(serialized.includes("device"), false);
    assert.deepEqual(Object.keys(JSON.parse(serialized) as object).sort(), [
      "connectionState",
      "consentGranted",
      "errorCode",
      "intendedLane",
      "lastConnectionAttemptAt",
      "lastNegotiationResult",
      "moduleLoaded",
      "moduleVersion",
      "reconnect",
      "userId",
    ]);
  });

  void it("represents module-not-loaded only as a server observation with no client snapshot", () => {
    const observation = observeMissingClientDiagnostics({
      reason: "targeted-socket-ack-timeout",
      expectedUserId: "FakeTvUserId0001",
      intendedLane: "tv",
      observedAt: "2026-09-28T01:05:00.000Z",
    });
    assert.deepEqual(observation, {
      source: "server",
      clientSnapshot: null,
      reason: "targeted-socket-ack-timeout",
      expectedUserId: "FakeTvUserId0001",
      intendedLane: "tv",
      observedAt: "2026-09-28T01:05:00.000Z",
    });
  });
});
