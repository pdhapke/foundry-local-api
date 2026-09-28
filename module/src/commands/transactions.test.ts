import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { ProtocolError, type TransactionManifest } from "@foundry-local-api/shared";

import {
  executeAtomicTransaction,
  preflightTransactionResult,
  recoverAtomicTransaction,
  transactionRevision,
} from "./transactions.js";

const savedConfig = Object.getOwnPropertyDescriptor(globalThis, "CONFIG");
const savedGame = Object.getOwnPropertyDescriptor(globalThis, "game");

class FakeDocument {
  static collections = new Map<string, Map<string, FakeDocument>>();
  readonly embedded = new Map<string, Map<string, FakeDocument>>();
  canWrite = true;
  deleteAttempts = 0;
  private deleted = false;

  constructor(
    readonly type: string,
    public id: string,
    private data: Record<string, unknown>,
    private readonly owner: Map<string, FakeDocument>,
  ) {}

  toObject(): Record<string, unknown> {
    if (this.data["throwOnToObject"] === true) throw new Error("post-write toObject failed");
    return structuredClone(this.data);
  }

  canUserModify(): boolean {
    return this.canWrite;
  }

  async update(changes: Record<string, unknown>, options?: Record<string, unknown>): Promise<this> {
    this.data =
      options?.["diff"] === false ? structuredClone(changes) : { ...this.data, ...changes };
    if (changes["throwAfterWrite"] === true) throw new Error("hook failed after write");
    return this;
  }

  async delete(): Promise<this> {
    this.deleteAttempts += 1;
    if (this.data["rollbackDeleteFails"] === true) throw new Error("injected delete failure");
    if (this.data["rollbackDeleteNoop"] === true) return this;
    this.owner.delete(this.id);
    this.deleted = true;
    if (this.data["throwAfterDelete"] === true) throw new Error("hook failed after delete");
    return this;
  }

  getEmbeddedCollection(type: string): Map<string, FakeDocument> {
    let children = this.embedded.get(type);
    if (!children) {
      children = new Map();
      this.embedded.set(type, children);
    }
    return children;
  }

  async createEmbeddedDocuments(
    type: string,
    data: Record<string, unknown>[],
    options?: Record<string, unknown>,
  ): Promise<FakeDocument[]> {
    const owner = this.getEmbeddedCollection(type);
    return data.map((source, index) => {
      const id =
        options?.["keepId"] === true ? String(source["_id"]) : `embedded-${owner.size + index + 1}`;
      const created = new FakeDocument(type, id, { ...source, _id: id }, owner);
      owner.set(id, created);
      return created;
    });
  }
}

function installWorld(): Map<string, FakeDocument> {
  const journals = new Map<string, FakeDocument>();
  FakeDocument.collections = new Map([["JournalEntry", journals]]);
  const documentClass = {
    canUserCreate: () => true,
    metadata: { embedded: { JournalEntryPage: "pages" } },
    create: async (data: Record<string, unknown>, options?: Record<string, unknown>) => {
      const id =
        options?.["keepId"] === true ? String(data["_id"]) : `journal-${journals.size + 1}`;
      const created = new FakeDocument("JournalEntry", id, { ...data, _id: id }, journals);
      journals.set(id, created);
      return created;
    },
  };
  Object.defineProperty(globalThis, "CONFIG", {
    configurable: true,
    value: {
      JournalEntry: { documentClass },
      JournalEntryPage: { documentClass: { canUserCreate: () => true } },
    },
  });
  Object.defineProperty(globalThis, "game", {
    configurable: true,
    value: {
      collections: new Map([["JournalEntry", journals]]),
      user: { id: "gm", isGM: true },
      world: { id: "test-world" },
      release: { version: "14.368" },
      system: { id: "dnd5e", version: "6.0.3" },
      modules: new Map([["foundry-local-api", { version: "0.1.0" }]]),
    },
  });
  return journals;
}

function restore(name: "CONFIG" | "game", descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}

beforeEach(() => installWorld());
afterEach(() => {
  restore("CONFIG", savedConfig);
  restore("game", savedGame);
});

function manifest(operations: TransactionManifest["operations"]): TransactionManifest {
  return {
    mode: "atomic",
    rollbackPolicy: "strict",
    worldId: "test-world",
    correlationId: "correlation-transaction-test",
    idempotencyKey: "transaction-test-key",
    operations,
  };
}

function fixture(testRunId: string): Record<string, unknown> {
  return { flags: { "foundry-local-api": { testRunId } } };
}

void describe("atomic transaction command", () => {
  void it("binds manifests to the active world and an executing GM", async () => {
    const wrongWorld = manifest([
      {
        operationId: "create",
        kind: "document.create",
        documentType: "JournalEntry",
        data: { _id: "NeverCreate00001", name: "Never" },
      },
    ]);
    wrongWorld.worldId = "another-world";
    await assert.rejects(
      () => preflightTransactionResult(wrongWorld),
      (error: unknown) =>
        error instanceof ProtocolError &&
        error.code === "INVALID_PAYLOAD" &&
        error.fieldPath === "worldId",
    );
    (game.user as unknown as { isGM: boolean }).isGM = false;
    await assert.rejects(
      () => preflightTransactionResult(manifest(wrongWorld.operations)),
      (error: unknown) => error instanceof ProtocolError && error.code === "PERMISSION_DENIED",
    );
    assert.equal(FakeDocument.collections.get("JournalEntry")?.size, 0);
  });

  void it("defensively rejects a non-strict rollback policy", async () => {
    const value = {
      ...manifest([
        {
          operationId: "create",
          kind: "document.create",
          documentType: "JournalEntry",
          data: { _id: "NeverCreate00002", name: "Never" },
        },
      ]),
      rollbackPolicy: "best-effort",
    } as unknown as TransactionManifest;
    await assert.rejects(
      () => preflightTransactionResult(value),
      (error: unknown) =>
        error instanceof ProtocolError &&
        error.code === "INVALID_PAYLOAD" &&
        error.fieldPath === "rollbackPolicy",
    );
  });

  void it("uses semantic revisions that ignore only Foundry modification bookkeeping", async () => {
    const left = {
      _id: "same",
      name: "Same",
      _stats: { createdTime: 1, modifiedTime: 2, modifiedBy: "gm-a" },
    };
    const right = {
      _id: "same",
      name: "Same",
      _stats: { createdTime: 1, modifiedTime: 99, modifiedBy: "gm-b" },
    };
    assert.equal(await transactionRevision(left), await transactionRevision(right));
    assert.notEqual(
      await transactionRevision(left),
      await transactionRevision({ ...right, name: "Changed" }),
    );
  });

  void it("preflights and commits in dependency order", async () => {
    const input = manifest([
      {
        operationId: "second",
        kind: "document.create",
        documentType: "JournalEntry",
        data: { _id: "SecondCreate0001", name: "Second" },
        dependsOn: ["first"],
      },
      {
        operationId: "first",
        kind: "document.create",
        documentType: "JournalEntry",
        data: { _id: "FirstCreate00001", name: "First" },
      },
    ]);
    const preflight = await preflightTransactionResult(input);
    assert.equal(preflight.transactionId, input.correlationId);
    assert.equal(preflight.atomic, false);
    assert.equal(preflight.transactionSemantics, "strict-verified-compensation");
    assert.match(preflight.limitations.join(" "), /not expose database-isolated/i);
    assert.deepEqual(preflight.executionOrder, ["first", "second"]);
    const result = await executeAtomicTransaction(input);
    assert.equal(result.transactionId, input.correlationId);
    assert.equal(result.atomic, false);
    assert.equal(result.transactionSemantics, "strict-verified-compensation");
    assert.match(result.limitations.join(" "), /hook side effects cannot be undone/i);
    assert.match(result.committedRevision, /^[a-f0-9]{64}$/);
    assert.ok(
      result.operations.every(({ validationWarnings }) => Array.isArray(validationWarnings)),
    );
    assert.deepEqual(result.executionOrder, ["first", "second"]);
    assert.equal(FakeDocument.collections.get("JournalEntry")?.size, 2);
  });

  void it("creates an embedded child with caller ID and parent revision CAS", async () => {
    const journals = FakeDocument.collections.get("JournalEntry")!;
    const parent = new FakeDocument(
      "JournalEntry",
      "parent",
      { _id: "parent", name: "Parent" },
      journals,
    );
    journals.set(parent.id, parent);
    const parentRevision = await transactionRevision(parent.toObject());
    const result = await executeAtomicTransaction(
      manifest([
        {
          operationId: "embedded-create",
          kind: "embedded.create",
          parentType: "JournalEntry",
          parentId: parent.id,
          embeddedType: "JournalEntryPage",
          expectedParentRevision: parentRevision,
          data: { _id: "EmbeddedPage0001", name: "Page" },
        },
      ]),
    );
    assert.equal(result.operations[0]?.documentId, "EmbeddedPage0001");
    assert.ok(parent.getEmbeddedCollection("JournalEntryPage").has("EmbeddedPage0001"));
  });

  void it("commits a strict multi-type manifest", async () => {
    const items = new Map<string, FakeDocument>();
    game.collections.set("Item", items as unknown as FoundryWorldCollection);
    const config = CONFIG as unknown as Record<string, Record<string, unknown>>;
    config["Item"] = {
      documentClass: {
        canUserCreate: () => true,
        create: async (data: Record<string, unknown>) => {
          const id = String(data["_id"]);
          const created = new FakeDocument("Item", id, data, items);
          items.set(id, created);
          return created;
        },
      },
    };
    const result = await executeAtomicTransaction(
      manifest([
        {
          operationId: "journal",
          kind: "document.create",
          documentType: "JournalEntry",
          data: { _id: "MultiJournal0001", name: "Journal" },
        },
        {
          operationId: "item",
          kind: "document.create",
          documentType: "Item",
          data: { _id: "MultiItem0000001", name: "Item" },
        },
      ]),
    );
    assert.deepEqual(result.executionOrder, ["journal", "item"]);
    assert.equal(items.size, 1);
  });

  void it("rejects duplicate create IDs and detects a concurrent source change at commit CAS", async () => {
    const journals = FakeDocument.collections.get("JournalEntry")!;
    const occupied = new FakeDocument(
      "JournalEntry",
      "OccupiedCreate01",
      { _id: "OccupiedCreate01", name: "Existing" },
      journals,
    );
    journals.set(occupied.id, occupied);
    await assert.rejects(
      () =>
        preflightTransactionResult(
          manifest([
            {
              operationId: "duplicate",
              kind: "document.create",
              documentType: "JournalEntry",
              data: { _id: "OccupiedCreate01", name: "Duplicate" },
            },
          ]),
        ),
      (error: unknown) => error instanceof ProtocolError && error.code === "INVALID_PAYLOAD",
    );

    const items = new Map<string, FakeDocument>();
    const item = new FakeDocument("Item", "item", { _id: "item", name: "Before" }, items);
    items.set(item.id, item);
    game.collections.set("Item", items as unknown as FoundryWorldCollection);
    const config = CONFIG as unknown as Record<string, { documentClass: Record<string, unknown> }>;
    config["Item"] = { documentClass: {} };
    const journalClass = config["JournalEntry"]!.documentClass;
    const originalCreate = journalClass["create"] as (
      data: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => Promise<FakeDocument>;
    journalClass["create"] = async (
      data: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => {
      const created = await originalCreate(data, options);
      await item.update({ name: "Concurrent" });
      return created;
    };
    const beforeRevision = await transactionRevision(item.toObject());
    await assert.rejects(
      () =>
        executeAtomicTransaction(
          manifest([
            {
              operationId: "first",
              kind: "document.create",
              documentType: "JournalEntry",
              data: { _id: "ConcurrentCreate", name: "Temporary" },
            },
            {
              operationId: "second",
              kind: "document.update",
              documentType: "Item",
              documentId: item.id,
              expectedRevision: beforeRevision,
              changes: { name: "Transaction" },
              dependsOn: ["first"],
            },
          ]),
        ),
      (error: unknown) => error instanceof ProtocolError && error.code === "STALE_REVISION",
    );
    assert.equal(item.toObject()["name"], "Concurrent");
    assert.equal(journals.has("ConcurrentCreate"), false);
  });

  void it("rejects a stale revision before any mutation", async () => {
    const journals = FakeDocument.collections.get("JournalEntry")!;
    const existing = new FakeDocument(
      "JournalEntry",
      "existing",
      { _id: "existing", name: "Before" },
      journals,
    );
    journals.set(existing.id, existing);
    const input = manifest([
      {
        operationId: "stale",
        kind: "document.update",
        documentType: "JournalEntry",
        documentId: existing.id,
        expectedRevision: "0".repeat(64),
        changes: { name: "After" },
      },
      {
        operationId: "never",
        kind: "document.create",
        documentType: "JournalEntry",
        data: { _id: "NeverCreate00003", name: "Never" },
      },
    ]);
    await assert.rejects(
      () => executeAtomicTransaction(input),
      (error: unknown) => {
        assert.ok(error instanceof ProtocolError);
        assert.equal(error.code, "STALE_REVISION");
        return true;
      },
    );
    assert.equal(journals.size, 1);
    assert.equal(existing.toObject()["name"], "Before");
  });

  void it("immediately compensates the current operation when a hook rejects after mutation", async () => {
    const journals = FakeDocument.collections.get("JournalEntry")!;
    const before = { _id: "hook-target", name: "Before" };
    const existing = new FakeDocument("JournalEntry", "hook-target", before, journals);
    journals.set(existing.id, existing);
    const expectedRevision = await transactionRevision(before);
    await assert.rejects(
      () =>
        executeAtomicTransaction(
          manifest([
            {
              operationId: "hook-failure",
              kind: "document.update",
              documentType: "JournalEntry",
              documentId: existing.id,
              expectedRevision,
              changes: { name: "After", throwAfterWrite: true },
            },
          ]),
        ),
      ProtocolError,
    );
    assert.deepEqual(existing.toObject(), before);
  });

  void it("compensates a create when post-write result serialization throws", async () => {
    const journals = FakeDocument.collections.get("JournalEntry")!;
    await assert.rejects(
      () =>
        executeAtomicTransaction(
          manifest([
            {
              operationId: "create-result-failure",
              kind: "document.create",
              documentType: "JournalEntry",
              data: {
                _id: "ResultFailure001",
                name: "Temporary",
                throwOnToObject: true,
              },
            },
          ]),
        ),
      ProtocolError,
    );
    assert.equal(journals.has("ResultFailure001"), false);
  });

  void it("compensates an embedded delete that rejects after removing the child", async () => {
    const journals = FakeDocument.collections.get("JournalEntry")!;
    const parent = new FakeDocument(
      "JournalEntry",
      "embedded-parent",
      { _id: "embedded-parent", name: "Parent" },
      journals,
    );
    journals.set(parent.id, parent);
    const children = parent.getEmbeddedCollection("JournalEntryPage");
    const childSource = { _id: "embedded-child", name: "Child", throwAfterDelete: true };
    const child = new FakeDocument("JournalEntryPage", "embedded-child", childSource, children);
    children.set(child.id, child);
    const expectedParentRevision = await transactionRevision(parent.toObject());
    const expectedRevision = await transactionRevision(child.toObject());
    await assert.rejects(
      () =>
        executeAtomicTransaction(
          manifest([
            {
              operationId: "embedded-delete",
              kind: "embedded.delete",
              parentType: "JournalEntry",
              parentId: parent.id,
              embeddedType: "JournalEntryPage",
              embeddedId: child.id,
              expectedParentRevision,
              expectedRevision,
            },
          ]),
        ),
      ProtocolError,
    );
    assert.deepEqual(children.get("embedded-child")?.toObject(), childSource);
  });

  void it("restores exact before images after an injected mid-manifest failure", async () => {
    const journals = FakeDocument.collections.get("JournalEntry")!;
    const runId = "test-transaction-rollback";
    const existing = new FakeDocument(
      "JournalEntry",
      "existing",
      { _id: "existing", name: "Before", _stats: { modifiedTime: 1 }, ...fixture(runId) },
      journals,
    );
    journals.set(existing.id, existing);
    const before = existing.toObject();
    const input = manifest([
      {
        operationId: "change",
        kind: "document.update",
        documentType: "JournalEntry",
        documentId: existing.id,
        expectedRevision: await transactionRevision(before),
        changes: { name: "After", extra: true },
      },
      {
        operationId: "created",
        kind: "document.create",
        documentType: "JournalEntry",
        data: { _id: "TempCreate000001", name: "Temporary", ...fixture(runId) },
        dependsOn: ["change"],
      },
    ]);
    input.failureInjection = {
      testRunId: runId,
      afterOperationId: "created",
      point: "postWriteBeforeRecord",
    };
    await assert.rejects(
      () => executeAtomicTransaction(input),
      (error: unknown) => {
        assert.ok(error instanceof ProtocolError);
        assert.equal(error.details?.["persistentPartialSuccess"], false);
        return true;
      },
    );
    assert.deepEqual(existing.toObject(), before);
    assert.equal(journals.size, 1);
  });

  void it("returns ROLLBACK_FAILED and an exact recovery manifest", async () => {
    const runId = "test-transaction-rollback-failure";
    const input = manifest([
      {
        operationId: "created",
        kind: "document.create",
        documentType: "JournalEntry",
        data: {
          _id: "TempCreate000002",
          name: "Temporary",
          rollbackDeleteNoop: true,
          ...fixture(runId),
        },
      },
    ]);
    input.failureInjection = { testRunId: runId, afterOperationId: "created" };
    await assert.rejects(
      () => executeAtomicTransaction(input),
      (error: unknown) => {
        assert.ok(error instanceof ProtocolError);
        assert.equal(error.code, "ROLLBACK_FAILED");
        const recovery = error.details?.["recoveryManifest"] as unknown[];
        assert.equal(recovery.length, 1);
        assert.doesNotMatch(JSON.stringify(error.details), /Temporary|beforeImage|flags/);
        return true;
      },
    );
  });

  void it("makes partial recovery progress idempotent across retries", async () => {
    const runId = "test-partial-recovery";
    const journals = FakeDocument.collections.get("JournalEntry")!;
    const value = manifest([
      {
        operationId: "first-created",
        kind: "document.create",
        documentType: "JournalEntry",
        data: {
          _id: "RecoverCreate001",
          name: "First",
          rollbackDeleteNoop: true,
          ...fixture(runId),
        },
      },
      {
        operationId: "second-created",
        kind: "document.create",
        documentType: "JournalEntry",
        data: {
          _id: "RecoverCreate002",
          name: "Second",
          rollbackDeleteNoop: true,
          ...fixture(runId),
        },
      },
    ]);
    value.failureInjection = { testRunId: runId, afterOperationId: "second-created" };
    await assert.rejects(() => executeAtomicTransaction(value), ProtocolError);
    const first = journals.get("RecoverCreate001")!;
    const second = journals.get("RecoverCreate002")!;
    await second.update({ rollbackDeleteNoop: false });
    await assert.rejects(
      () =>
        recoverAtomicTransaction({
          transactionId: value.correlationId,
          worldId: value.worldId,
        }),
      (error: unknown) => error instanceof ProtocolError && error.code === "ROLLBACK_FAILED",
    );
    assert.equal(second.deleteAttempts, 2);
    assert.equal(first.deleteAttempts, 2);
    await first.update({ rollbackDeleteNoop: false });
    const recovered = await recoverAtomicTransaction({
      transactionId: value.correlationId,
      worldId: value.worldId,
    });
    assert.deepEqual(
      new Set(recovered.recoveredOperationIds),
      new Set(["second-created", "first-created"]),
    );
    assert.equal(second.deleteAttempts, 2);
    assert.equal(first.deleteAttempts, 3);
  });

  void it("recreates a deleted fixture with the same ID and semantic state on rollback", async () => {
    const runId = "test-transaction-delete-rollback";
    const journals = FakeDocument.collections.get("JournalEntry")!;
    const before = {
      _id: "delete-me",
      name: "Restored",
      content: "same",
      _stats: { createdTime: 1, modifiedTime: 2 },
      ...fixture(runId),
    };
    const existing = new FakeDocument("JournalEntry", "delete-me", before, journals);
    journals.set(existing.id, existing);
    const value = manifest([
      {
        operationId: "delete",
        kind: "document.delete",
        documentType: "JournalEntry",
        documentId: existing.id,
        expectedRevision: await transactionRevision(before),
      },
    ]);
    value.failureInjection = { testRunId: runId, afterOperationId: "delete" };
    await assert.rejects(() => executeAtomicTransaction(value), ProtocolError);
    const restored = journals.get("delete-me");
    assert.ok(restored);
    assert.equal(await transactionRevision(restored.toObject()), await transactionRevision(before));
  });

  void it("fails closed when Foundry exposes no permission method", async () => {
    const config = CONFIG as unknown as Record<string, { documentClass: Record<string, unknown> }>;
    config["JournalEntry"]!.documentClass["canUserCreate"] = undefined;
    await assert.rejects(
      () =>
        preflightTransactionResult(
          manifest([
            {
              operationId: "no-permission-api",
              kind: "document.create",
              documentType: "JournalEntry",
              data: { _id: "NeverCreate00004", name: "Never" },
            },
          ]),
        ),
      (error: unknown) => error instanceof ProtocolError && error.code === "PERMISSION_DENIED",
    );
  });

  void it("rejects schema failures during preflight without persisting", async () => {
    const config = CONFIG as unknown as Record<string, { documentClass: Record<string, unknown> }>;
    config["JournalEntry"]!.documentClass["schema"] = {
      fields: { requiredFixtureField: { required: true, constructor: { name: "StringField" } } },
    };
    await assert.rejects(
      () =>
        executeAtomicTransaction(
          manifest([
            {
              operationId: "invalid",
              kind: "document.create",
              documentType: "JournalEntry",
              data: { _id: "InvalidCreate001", name: "Invalid" },
            },
          ]),
        ),
      (error: unknown) => error instanceof ProtocolError && error.code === "INVALID_PAYLOAD",
    );
    assert.equal(FakeDocument.collections.get("JournalEntry")?.size, 0);
  });

  void it("infers subtype from the before image when update changes omit type", async () => {
    const items = new Map<string, FakeDocument>();
    const existing = new FakeDocument(
      "Item",
      "weapon",
      { _id: "weapon", type: "weapon", name: "Sword", system: { damage: 4 } },
      items,
    );
    items.set(existing.id, existing);
    game.collections.set("Item", items as unknown as FoundryWorldCollection);
    const config = CONFIG as unknown as Record<string, Record<string, unknown>>;
    config["Item"] = {
      documentClass: { canUserCreate: () => true },
      dataModels: {
        weapon: {
          validate: () => false,
        },
      },
    };
    const expectedRevision = await transactionRevision(existing.toObject());
    await assert.rejects(
      () =>
        executeAtomicTransaction(
          manifest([
            {
              operationId: "invalid-weapon",
              kind: "document.update",
              documentType: "Item",
              documentId: existing.id,
              expectedRevision,
              changes: { system: { damage: -1 } },
            },
          ]),
        ),
      (error: unknown) => error instanceof ProtocolError && error.code === "INVALID_PAYLOAD",
    );
    assert.equal((existing.toObject()["system"] as { damage: number }).damage, 4);
  });

  void it("refuses failure injection unless every target belongs to the exact test run", async () => {
    const journals = FakeDocument.collections.get("JournalEntry")!;
    const existing = new FakeDocument(
      "JournalEntry",
      "canonical",
      { _id: "canonical", name: "Canonical" },
      journals,
    );
    journals.set(existing.id, existing);
    const value = manifest([
      {
        operationId: "change",
        kind: "document.update",
        documentType: "JournalEntry",
        documentId: existing.id,
        expectedRevision: await transactionRevision(existing.toObject()),
        changes: { name: "Forbidden" },
      },
    ]);
    value.failureInjection = { testRunId: "test-fake-ownership", afterOperationId: "change" };
    await assert.rejects(
      () => preflightTransactionResult(value),
      (error: unknown) => error instanceof ProtocolError && error.code === "PERMISSION_DENIED",
    );
    assert.equal(existing.toObject()["name"], "Canonical");
  });

  void it("rejects unsupported embedded relationships and duplicate targets during preflight", async () => {
    await assert.rejects(
      () =>
        preflightTransactionResult(
          manifest([
            {
              operationId: "bad-child",
              kind: "embedded.create",
              parentType: "JournalEntry",
              parentId: "anything",
              embeddedType: "Token",
              expectedParentRevision: "0".repeat(64),
              data: {},
            },
          ]),
        ),
      (error: unknown) => error instanceof ProtocolError && error.code === "UNSUPPORTED_TYPE",
    );
  });

  void it("rejects an uncompensated destructive operation before commit", async () => {
    await assert.rejects(
      () =>
        preflightTransactionResult(
          manifest([
            {
              operationId: "delete-scene",
              kind: "document.delete",
              documentType: "Scene",
              documentId: "scene",
              expectedRevision: "0".repeat(64),
            },
          ]),
        ),
      (error: unknown) => {
        assert.ok(error instanceof ProtocolError);
        assert.equal(error.code, "UNSUPPORTED_TYPE");
        assert.equal(error.details?.["uncompensated"], true);
        return true;
      },
    );
  });
});
