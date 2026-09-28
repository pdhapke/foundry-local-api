import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ProtocolError, type TransactionManifest } from "@foundry-local-api/shared";

import { TransactionJournal } from "./transaction-runtime.js";

function manifest(name = "Secret fixture content"): TransactionManifest {
  return {
    mode: "atomic",
    rollbackPolicy: "strict",
    worldId: "test-world",
    correlationId: "transaction-journal-0001",
    idempotencyKey: "journal-idempotency-0001",
    operations: [
      {
        operationId: "create",
        kind: "document.create",
        documentType: "JournalEntry",
        data: { _id: "JournalCreate001", name },
      },
    ],
  };
}

void describe("durable transaction journal", () => {
  void it("persists pending before dispatch and exposes it after restart without payloads", () => {
    const directory = mkdtempSync(join(tmpdir(), "transaction-journal-"));
    const path = join(directory, "journal.json");
    const first = new TransactionJournal(path);
    const pending = first.prepare(manifest());
    assert.equal(pending.state, "pending");
    const serialized = readFileSync(path, "utf8");
    assert.doesNotMatch(serialized, /Secret fixture content/);
    const restarted = new TransactionJournal(path);
    assert.equal(restarted.get(pending.transactionId).state, "pending");
  });

  void it("serializes concurrent-equivalent prepare calls and rejects changed manifests", async () => {
    const directory = mkdtempSync(join(tmpdir(), "transaction-journal-concurrent-"));
    const journal = new TransactionJournal(join(directory, "journal.json"));
    const [left, right] = await Promise.all([
      Promise.resolve().then(() => journal.prepare(manifest())),
      Promise.resolve().then(() => journal.prepare(manifest())),
    ]);
    assert.deepEqual(left, right);
    assert.throws(
      () => journal.prepare(manifest("Different input")),
      (error: unknown) => error instanceof ProtocolError && error.code === "IDEMPOTENCY_CONFLICT",
    );
  });

  void it("persists committed, rolled-back, and recovery-required transitions", () => {
    const directory = mkdtempSync(join(tmpdir(), "transaction-journal-states-"));
    const path = join(directory, "journal.json");
    const journal = new TransactionJournal(path);
    journal.prepare(manifest());
    journal.transition("transaction-journal-0001", "recoveryRequired", {
      errorCode: "ROLLBACK_FAILED",
    });
    assert.equal(
      new TransactionJournal(path).get("transaction-journal-0001").state,
      "recoveryRequired",
    );
    journal.transition("transaction-journal-0001", "rolledBack");
    assert.equal(journal.get("transaction-journal-0001").state, "rolledBack");
  });
});
