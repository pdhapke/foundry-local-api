// Unit tests for FoundryClient. Driven against a fake BridgeGateway (only
// the subset of its API FoundryClient actually calls: onMessage,
// onConnectionLost, isConnected, send) rather than a real WebSocketServer —
// no HTTP server or real socket is involved, mirroring how other files in
// this codebase fake their one collaborator (e.g. `users.test.ts`'s fake
// `FoundryClient`).
//
// Phase 26 adds the `onEvent`/`kind: "event"` coverage here; the
// request/response coverage (`call()`, timeouts, ok/error replies) is new in
// this same phase since no test file previously existed for this class.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  BridgeConnectionLostListener,
  BridgeGateway,
  BridgeMessageListener,
} from "./gateway.js";
import type { ConnectedBridgeClient } from "@foundry-local-api/shared";
import { FoundryClient } from "./foundry-client.js";

class FakeGateway {
  private connected = true;
  private messageListener: BridgeMessageListener | undefined;
  private connectionLostListener: BridgeConnectionLostListener | undefined;
  readonly sent: string[] = [];
  private readonly client: ConnectedBridgeClient = {
    clientId: "client-gm",
    userId: "user-gm",
    userName: "GM",
    isGM: true,
    lane: "gm",
    optedIn: true,
    protocolVersion: 2,
    foundryVersion: "14.368",
    systemId: "dnd5e",
    systemVersion: "6.0.3",
    moduleVersion: "0.1.0",
    transport: "websocket",
    connectedAt: 1,
    lastSeenAt: 1,
    capabilities: ["foundryPing"],
  };

  onMessage(listener: BridgeMessageListener): void {
    this.messageListener = listener;
  }

  onConnectionLost(listener: BridgeConnectionLostListener): void {
    this.connectionLostListener = listener;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getClient(): ConnectedBridgeClient | null {
    return this.connected ? this.client : null;
  }

  listClients(): ConnectedBridgeClient[] {
    return this.connected ? [this.client] : [];
  }

  advertise(...commands: string[]): void {
    this.client.capabilities = commands;
  }

  send(raw: string): boolean {
    if (!this.connected) {
      return false;
    }
    this.sent.push(raw);
    return true;
  }

  /** Test helper: simulates an inbound message from the module. */
  emitMessage(raw: string): void {
    this.messageListener?.(this.client.clientId, raw);
  }

  /** Test helper: simulates the connection dropping. */
  emitConnectionLost(): void {
    this.connected = false;
    this.connectionLostListener?.(this.client);
  }
}

function buildClient(): { client: FoundryClient; gateway: FakeGateway } {
  const gateway = new FakeGateway();
  const client = new FoundryClient(gateway as unknown as BridgeGateway, { defaultTimeoutMs: 1000 });
  return { client, gateway };
}

void describe("FoundryClient", () => {
  void it("resolves call() when a matching ok:true response arrives", async () => {
    const { client, gateway } = buildClient();
    const pending = client.call("foundryPing", { x: 1 });

    const sentRequest = JSON.parse(gateway.sent[0] ?? "{}") as { id: string };
    gateway.emitMessage(JSON.stringify({ id: sentRequest.id, ok: true, result: { pong: true } }));

    assert.deepEqual(await pending, { pong: true });
  });

  void it("rejects call() when a matching ok:false response arrives", async () => {
    const { client, gateway } = buildClient();
    const pending = client.call("foundryPing");

    const sentRequest = JSON.parse(gateway.sent[0] ?? "{}") as { id: string };
    gateway.emitMessage(
      JSON.stringify({
        id: sentRequest.id,
        ok: false,
        error: { message: "boom", code: "HANDLER_ERROR" },
      }),
    );

    await assert.rejects(pending, /boom/);
  });

  void it('onEvent() receives a kind:"event" message and does not resolve/reject any pending call', async () => {
    const { client, gateway } = buildClient();
    const received: Array<{ event: string; payload: unknown }> = [];
    client.onEvent((event, payload) => received.push({ event, payload }));

    const pending = client.call("foundryPing");

    gateway.emitMessage(
      JSON.stringify({ kind: "event", event: "createActor", payload: { _id: "a1" } }),
    );

    assert.deepEqual(received, [{ event: "createActor", payload: { _id: "a1" } }]);
    assert.equal(client.pendingCount, 1, "the unrelated pending call must still be waiting");

    // Clean up the still-pending call so the test doesn't leak a timer.
    const sentRequest = JSON.parse(gateway.sent[0] ?? "{}") as { id: string };
    gateway.emitMessage(JSON.stringify({ id: sentRequest.id, ok: true, result: null }));
    await pending;
  });

  void it("onEvent()'s unsubscribe function stops further delivery", () => {
    const { client, gateway } = buildClient();
    const received: string[] = [];
    const unsubscribe = client.onEvent((event) => received.push(event));

    gateway.emitMessage(JSON.stringify({ kind: "event", event: "createActor", payload: {} }));
    unsubscribe();
    gateway.emitMessage(JSON.stringify({ kind: "event", event: "updateActor", payload: {} }));

    assert.deepEqual(received, ["createActor"]);
  });

  void it("an event message does not trigger the 'unexpected shape' fallback used for malformed responses", async () => {
    const { client, gateway } = buildClient();
    let eventCount = 0;
    client.onEvent(() => {
      eventCount += 1;
    });

    // No pending call at all — proves this doesn't fall through to the
    // response-shape branch (which would just warn "unknown id" instead).
    gateway.emitMessage(JSON.stringify({ kind: "event", event: "createToken", payload: {} }));

    assert.equal(eventCount, 1);
    assert.equal(client.pendingCount, 0);
  });

  void it("rejects pending calls when the connection is lost, independent of onEvent listeners", async () => {
    const { client, gateway } = buildClient();
    client.onEvent(() => {
      /* present but irrelevant to this test */
    });

    const pending = client.call("foundryPing");
    gateway.emitConnectionLost();

    await assert.rejects(pending, /connection was lost/);
  });

  void it("fails closed before dispatch when a durable audit record is required but unavailable", async () => {
    const { client, gateway } = buildClient();
    await assert.rejects(
      client.call("effectiveUserExecute", {}, { requireDurableAudit: true }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "INCOMPLETE_RESULT" &&
        error.message.includes("durable audit"),
    );
    assert.equal(gateway.sent.length, 0);
  });

  void it("lets a higher-level operation own the one terminal audit record", async () => {
    const gateway = new FakeGateway();
    const records: Array<{ outcome: string }> = [];
    const client = new FoundryClient(gateway as unknown as BridgeGateway, {
      defaultTimeoutMs: 1000,
      auditSink: (record) => {
        records.push(record);
      },
    });
    const pending = client.call(
      "effectiveUserExecute",
      {},
      {
        requireDurableAudit: true,
        suppressCompletionAudit: true,
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    const sentRequest = JSON.parse(gateway.sent[0] ?? "{}") as { id: string };
    gateway.emitMessage(
      JSON.stringify({
        id: sentRequest.id,
        ok: false,
        error: { message: "denied", code: "PERMISSION_DENIED" },
      }),
    );
    await assert.rejects(pending, /denied/);
    assert.deepEqual(
      records.map((record) => record.outcome),
      ["started"],
    );
  });

  void it("never passes a secret delivery credential to the audit sink", async () => {
    const gateway = new FakeGateway();
    const records: unknown[] = [];
    const client = new FoundryClient(gateway as unknown as BridgeGateway, {
      defaultTimeoutMs: 1000,
      auditSink: (record) => {
        records.push(record);
      },
    });
    const credential = "fle1_canary_identifier_canary-secret-value";
    const pending = client.call(
      "bridgeEnrollmentTarget",
      { action: "deliver", credential, targetUserId: "player" },
      { auditPayloadSummary: { action: "deliver", targetUserId: "player" } },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(JSON.stringify(records).includes(credential), false);
    const sentRequest = JSON.parse(gateway.sent[0] ?? "{}") as { id: string };
    gateway.emitMessage(JSON.stringify({ id: sentRequest.id, ok: true, result: null }));
    await pending;
  });

  void it("separates advertised connectivity from successful live command verification", async () => {
    const { client, gateway } = buildClient();
    gateway.advertise("schemaDiscover", "schemaValidate", "transactionExecute");
    let report = client.getCapabilityReport();
    assert.equal(
      report.capabilities.find(({ id }) => id === "mcp-req-003.schema-discovery-validation")
        ?.connected,
      true,
    );
    assert.equal(
      report.capabilities.find(({ id }) => id === "mcp-req-003.schema-discovery-validation")
        ?.liveVerified,
      false,
    );
    assert.equal(
      report.capabilities.find(({ id }) => id === "mcp-req-004.compensating-transactions")?.state,
      "partial",
    );

    const pending = client.call("schemaDiscover", {});
    const sentRequest = JSON.parse(gateway.sent.at(-1) ?? "{}") as { id: string };
    gateway.emitMessage(JSON.stringify({ id: sentRequest.id, ok: true, result: {} }));
    await pending;

    report = client.getCapabilityReport();
    assert.equal(
      report.capabilities.find(({ id }) => id === "mcp-req-003.schema-discovery-validation")
        ?.liveVerified,
      false,
      "both discovery and validation must succeed before the family is live-verified",
    );
  });
});
