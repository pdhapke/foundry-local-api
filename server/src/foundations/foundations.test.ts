import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ProtocolError } from "@foundry-local-api/shared";

import { DurableAuditLog } from "./audit-log.js";
import { FixtureRegistry } from "./fixture-registry.js";
import { DurableIdempotencyStore } from "./idempotency-store.js";
import { assertExpectedRevision, computeRevision } from "./revision.js";

function tempFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "foundry-track0-")), name);
}

void describe("Track 0 durable foundations", () => {
  void it("computes order-stable revisions and rejects stale expectations", () => {
    assert.equal(computeRevision({ a: 1, b: 2 }), computeRevision({ b: 2, a: 1 }));
    assert.throws(
      () => assertExpectedRevision("stale", { a: 1 }),
      (error: unknown) => error instanceof ProtocolError && error.code === "STALE_REVISION",
    );
  });

  void it("replays identical idempotent work and refuses key reuse with different input", async () => {
    const path = tempFile("idempotency.json");
    const store = new DurableIdempotencyStore(path);
    let calls = 0;
    const first = await store.execute("fixture:idem-0001", { a: 1 }, async () => ++calls);
    const replay = await store.execute("fixture:idem-0001", { a: 1 }, async () => ++calls);
    assert.deepEqual(first, { result: 1, replayed: false });
    assert.deepEqual(replay, { result: 1, replayed: true });
    assert.equal(calls, 1);
    await assert.rejects(
      () => store.execute("fixture:idem-0001", { a: 2 }, async () => 2),
      (error: unknown) => error instanceof ProtocolError && error.code === "IDEMPOTENCY_CONFLICT",
    );
  });

  void it("deduplicates identical in-flight work and refuses changed concurrent input", async () => {
    const store = new DurableIdempotencyStore(tempFile("concurrent.json"));
    let release: ((value: string) => void) | undefined;
    const operation = new Promise<string>((resolve) => {
      release = resolve;
    });
    const first = store.execute("fixture:concurrent-0001", { a: 1 }, () => operation);
    const duplicate = store.execute("fixture:concurrent-0001", { a: 1 }, async () => "wrong");
    await assert.rejects(
      () => store.execute("fixture:concurrent-0001", { a: 2 }, async () => "wrong"),
      (error: unknown) => error instanceof ProtocolError && error.code === "IDEMPOTENCY_CONFLICT",
    );
    release?.("committed");
    assert.deepEqual(await first, { result: "committed", replayed: false });
    assert.deepEqual(await duplicate, { result: "committed", replayed: false });
  });

  void it("persists an incomplete marker before execution and refuses unsafe replay after failure", async () => {
    const path = tempFile("pending.json");
    const store = new DurableIdempotencyStore(path);
    await assert.rejects(
      () =>
        store.execute("fixture:pending-0001", { a: 1 }, async () => {
          throw new Error("connection lost after dispatch");
        }),
      /connection lost/,
    );
    const restarted = new DurableIdempotencyStore(path);
    await assert.rejects(
      () => restarted.execute("fixture:pending-0001", { a: 1 }, async () => "duplicate"),
      (error: unknown) => error instanceof ProtocolError && error.code === "INCOMPLETE_RESULT",
    );
  });

  void it("clears only a matching pending marker after verified rollback", async () => {
    const path = tempFile("rolled-back.json");
    const store = new DurableIdempotencyStore(path);
    await assert.rejects(() =>
      store.execute("fixture:rollback-0001", { a: 1 }, async () => {
        throw new Error("verified rollback");
      }),
    );
    store.resolvePendingAsRolledBack("fixture:rollback-0001", { a: 1 });
    assert.deepEqual(
      await store.execute("fixture:rollback-0001", { a: 1 }, async () => "retried"),
      { result: "retried", replayed: false },
    );
  });

  void it("records only exact fixture IDs in cleanup plans", () => {
    const registry = new FixtureRegistry(tempFile("fixtures.json"));
    registry.create("test-track0-fixture-0001");
    registry.recordDocument("test-track0-fixture-0001", {
      documentType: "JournalEntry",
      id: "ExactId123",
    });
    assert.deepEqual(registry.cleanupPlan("test-track0-fixture-0001").documents, [
      { documentType: "JournalEntry", id: "ExactId123" },
    ]);
    registry.recordFile("test-track0-fixture-0001", {
      root: "data",
      path: "worlds/izzy-campaign/assets/mcp-test/test-track0-fixture-0001/a.png",
      sha256: "a".repeat(64),
    });
    registry.moveFile(
      "test-track0-fixture-0001",
      {
        root: "data",
        path: "worlds/izzy-campaign/assets/mcp-test/test-track0-fixture-0001/a.png",
      },
      {
        root: "data",
        path: "worlds/izzy-campaign/assets/mcp-test/test-track0-fixture-0001/b.png",
        sha256: "a".repeat(64),
      },
    );
    assert.equal(
      registry.cleanupPlan("test-track0-fixture-0001").files[0]?.path.endsWith("b.png"),
      true,
    );
    registry.removeFile("test-track0-fixture-0001", {
      root: "data",
      path: "worlds/izzy-campaign/assets/mcp-test/test-track0-fixture-0001/b.png",
    });
    assert.deepEqual(registry.cleanupPlan("test-track0-fixture-0001").files, []);
  });

  void it("recovers a complete fixture manifest left by an interrupted atomic replacement", () => {
    const path = tempFile("fixtures.json");
    const run = {
      testRunId: "test-track0-recovery-0001",
      namespace: "foundry-local-api",
      createdAt: new Date(0).toISOString(),
      documents: [],
      files: [{ root: "data", path: "fixtures/recovered/a.png", sha256: "a".repeat(64) }],
    };
    writeFileSync(`${path}.tmp`, JSON.stringify([run]), "utf8");
    const registry = new FixtureRegistry(path);
    assert.deepEqual(registry.get(run.testRunId).files, run.files);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), [run]);
  });

  void it("redacts secret-bearing payload fields in the durable JSONL audit", () => {
    const path = tempFile("audit.jsonl");
    const audit = new DurableAuditLog(path);
    audit.write({
      timestamp: new Date(0).toISOString(),
      correlationId: "corr-1",
      command: "example",
      requestingUserId: null,
      effectiveUserId: "user-1",
      executingClientId: "client-1",
      outcome: "started",
      payloadSummary: { apiKey: "do-not-log", documentType: "Scene", data: { secret: true } },
    });
    const text = readFileSync(path, "utf8");
    assert.doesNotMatch(text, /do-not-log/);
    assert.doesNotMatch(text, /secret":true/);
    assert.match(text, /\[REDACTED\]/);
    assert.match(text, /Scene/);
  });
});
