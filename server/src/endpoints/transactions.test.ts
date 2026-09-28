import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  TRANSACTION_COMMANDS,
  type TransactionManifest,
  type TransactionRecoveryInput,
} from "@foundry-local-api/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Initialize the app-owned endpoint cycle before importing the registry.
import "../app.js";
import { FoundryBridgeError } from "../bridge/errors.js";
import type { FoundryClient } from "../bridge/foundry-client.js";
import { FixtureRegistry } from "../foundations/fixture-registry.js";
import { DurableIdempotencyStore } from "../foundations/idempotency-store.js";
import { TransactionJournal } from "../foundations/transaction-runtime.js";
import { registerMcpTools } from "./registry.js";
import { createTransactionEndpointDescriptors, transactionManifestSchema } from "./transactions.js";

function input(name = "one"): TransactionManifest {
  return {
    mode: "atomic",
    rollbackPolicy: "strict",
    worldId: "test-world",
    correlationId: "transaction-correlation",
    idempotencyKey: "transaction-idempotency",
    operations: [
      {
        operationId: "create",
        kind: "document.create",
        documentType: "JournalEntry",
        data: { _id: "ServerCreate0001", name },
      },
    ],
  };
}

function harness() {
  const directory = mkdtempSync(join(tmpdir(), "transactions-endpoint-"));
  const calls: Array<{ command: string; payload: unknown }> = [];
  const foundryClient = {
    getCapabilityReport: () => ({
      clients: [
        {
          clientId: "gm-client",
          userId: "gm-user",
          userName: "GM",
          isGM: true,
          lane: "gm",
          optedIn: true,
          connectedAt: 1,
          capabilities: [TRANSACTION_COMMANDS.EXECUTE],
          foundryVersion: "14.368",
          systemId: "dnd5e",
          systemVersion: "6.0.3",
          moduleVersion: "0.1.0",
        },
      ],
    }),
    call: async (command: string, payload: TransactionManifest | TransactionRecoveryInput) => {
      calls.push({ command, payload });
      if (command === TRANSACTION_COMMANDS.PREFLIGHT) {
        const manifest = payload as TransactionManifest;
        return {
          transactionId: manifest.correlationId,
          correlationId: manifest.correlationId,
          atomic: true,
          valid: true,
          executionOrder: manifest.operations.map(({ operationId }) => operationId),
          checkedRevisions: [],
          validationWarnings: [],
        };
      }
      if (command === TRANSACTION_COMMANDS.RECOVER) {
        const recovery = payload as TransactionRecoveryInput;
        return {
          transactionId: recovery.transactionId,
          rolledBack: true,
          recoveredOperationIds: ["create"],
        };
      }
      const manifest = payload as TransactionManifest;
      return {
        transactionId: manifest.correlationId,
        correlationId: manifest.correlationId,
        idempotencyKey: manifest.idempotencyKey,
        committed: true,
        atomic: true,
        replayed: false,
        executionOrder: manifest.operations.map(({ operationId }) => operationId),
        operations: [],
        committedRevision: "a".repeat(64),
      };
    },
    recordAudit: async () => {},
  } as unknown as FoundryClient;
  const foundations = {
    fixtures: new FixtureRegistry(join(directory, "fixtures.json")),
    idempotency: new DurableIdempotencyStore(join(directory, "idempotency.json")),
  };
  const journal = new TransactionJournal(null);
  const descriptors = createTransactionEndpointDescriptors(journal);
  return { foundryClient, foundations, calls, descriptors, journal };
}

void describe("transaction endpoints", () => {
  void it("exposes separate no-mutation preflight and atomic commit descriptors", async () => {
    const { foundryClient, foundations, calls, descriptors } = harness();
    const preflight = descriptors[0]!;
    const execute = descriptors[1]!;
    const value = input();
    const checked = await preflight.handler(value, { foundryClient, foundations });
    assert.equal(checked.valid, true);
    const committed = await execute.handler(value, { foundryClient, foundations });
    assert.equal(committed.committed, true);
    assert.deepEqual(
      calls.map(({ command }) => command),
      [TRANSACTION_COMMANDS.PREFLIGHT, TRANSACTION_COMMANDS.EXECUTE],
    );
  });

  void it("replays a committed idempotency key without another Foundry mutation", async () => {
    const { foundryClient, foundations, calls, descriptors } = harness();
    const execute = descriptors[1]!;
    const value = input();
    const first = await execute.handler(value, { foundryClient, foundations });
    const replay = await execute.handler(value, { foundryClient, foundations });
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(calls.length, 1);
  });

  void it("rejects reuse of an idempotency key with different input", async () => {
    const { foundryClient, foundations, descriptors } = harness();
    const execute = descriptors[1]!;
    await execute.handler(input("first"), { foundryClient, foundations });
    await assert.rejects(
      () => execute.handler(input("changed"), { foundryClient, foundations }),
      (error: unknown) =>
        error instanceof FoundryBridgeError && error.code === "IDEMPOTENCY_CONFLICT",
    );
  });

  void it("validates bounded operation count, revisions, and fixture-only failure injection", () => {
    assert.equal(transactionManifestSchema.safeParse(input()).success, true);
    const invalid = input();
    invalid.failureInjection = { testRunId: "production", afterOperationId: "create" };
    assert.equal(transactionManifestSchema.safeParse(invalid).success, false);
    const staleShape = input();
    staleShape.operations = [
      {
        operationId: "update",
        kind: "document.update",
        documentType: "JournalEntry",
        documentId: "id",
        expectedRevision: "short",
        changes: {},
      },
    ];
    assert.equal(transactionManifestSchema.safeParse(staleShape).success, false);
    assert.equal(
      transactionManifestSchema.safeParse({ ...input(), rollbackPolicy: "best-effort" }).success,
      false,
    );
    assert.equal(transactionManifestSchema.safeParse({ ...input(), worldId: "" }).success, false);
  });

  void it("registers both descriptors as MCP tools", () => {
    const { foundryClient, foundations, descriptors } = harness();
    const server = new McpServer({ name: "transactions-test", version: "1" });
    assert.equal(
      registerMcpTools(server, descriptors, foundryClient, undefined, foundations).length,
      4,
    );
  });

  void it("reports durable status and dispatches only explicitly recovery-required work", async () => {
    const { foundryClient, foundations, descriptors, journal, calls } = harness();
    const value = input();
    journal.prepare(value);
    journal.transition(value.correlationId, "recoveryRequired", { errorCode: "ROLLBACK_FAILED" });
    const status = await descriptors[2]!.handler(
      { transactionId: value.correlationId },
      { foundryClient, foundations },
    );
    assert.equal(status.state, "recoveryRequired");
    const recovered = await descriptors[3]!.handler(
      { transactionId: value.correlationId, worldId: value.worldId },
      { foundryClient, foundations },
    );
    assert.equal(recovered.rolledBack, true);
    assert.equal(journal.get(value.correlationId).state, "rolledBack");
    assert.equal(calls.at(-1)?.command, TRANSACTION_COMMANDS.RECOVER);
  });

  void it("does not redispatch a pending crash-window transaction", async () => {
    const { foundryClient, foundations, descriptors, journal, calls } = harness();
    const value = input();
    journal.prepare(value);
    await assert.rejects(
      () => descriptors[1]!.handler(value, { foundryClient, foundations }),
      (error: unknown) => error instanceof FoundryBridgeError && error.code === "INCOMPLETE_RESULT",
    );
    assert.equal(calls.length, 0);
  });

  void it("marks an ambiguous bridge timeout as recovery-required rather than rolled back", async () => {
    const { foundryClient, foundations, descriptors, journal } = harness();
    foundryClient.call = (() =>
      Promise.reject(
        new FoundryBridgeError("TIMEOUT", "The response was lost after dispatch.", {
          retryable: true,
        }),
      )) as FoundryClient["call"];
    const value = input();
    await assert.rejects(
      () => descriptors[1]!.handler(value, { foundryClient, foundations }),
      (error: unknown) => error instanceof FoundryBridgeError && error.code === "TIMEOUT",
    );
    assert.equal(journal.get(value.correlationId).state, "recoveryRequired");
  });
});
