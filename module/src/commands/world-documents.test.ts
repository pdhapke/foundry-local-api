import assert from "node:assert/strict";
import test from "node:test";
import { readWorldDocument, applyWorldDocument } from "./world-documents.js";
import type { WorldDocumentApply, WorldDocumentSource } from "@foundry-local-api/shared";
class Doc {
  children = new Map<string, Map<string, Doc>>();
  options: Record<string, unknown>[] = [];
  constructor(
    readonly id: string,
    readonly data: Record<string, unknown>,
    readonly collection: Map<string, Doc>,
  ) {}
  toObject() {
    return structuredClone(this.data);
  }
  getEmbeddedCollection(type: string) {
    return this.children.get(type) ?? new Map<string, Doc>();
  }
  update(data: Record<string, unknown>, options: Record<string, unknown>) {
    this.options.push(options);
    Object.assign(this.data, data);
    return Promise.resolve(this);
  }
  delete(options: Record<string, unknown>) {
    this.options.push(options);
    this.collection.delete(this.id);
    return Promise.resolve(this);
  }
}
function fixture() {
  const docs = new Map<string, Doc>();
  const doc = new Doc("a", { _id: "a", name: "Old", _stats: { modifiedTime: 1 } }, docs);
  docs.set(doc.id, doc);
  const gm = { id: "gm", isGM: true, active: true };
  Object.assign(globalThis, {
    game: {
      world: { id: "w" },
      user: gm,
      users: new Map([["gm", gm]]),
      collections: new Map([["Actor", docs]]),
    },
    CONFIG: {
      Actor: {
        documentClass: {
          create: (data: Record<string, unknown>, options: Record<string, unknown>) => {
            const created = new Doc(String(data["_id"]), data, docs);
            created.options.push(options);
            docs.set(created.id, created);
            return Promise.resolve(created);
          },
        },
      },
    },
  });
  return { docs, doc, gm };
}
const read = {
  worldId: "w",
  requestingUserId: "gm",
  family: "actors" as const,
  operation: "get" as const,
  targetId: "a",
};
void test("known-family world CRUD hashes source, scopes all-world parent/API and preserves executor provenance", async () => {
  const f = fixture();
  const before = (await readWorldDocument(read)) as WorldDocumentSource;
  f.doc.data["_stats"] = { modifiedTime: 2 };
  assert.equal(((await readWorldDocument(read)) as WorldDocumentSource).revision, before.revision);
  const base = {
    worldId: "w",
    requestingUserId: "gm",
    family: "actors" as const,
    correlationId: "corr",
    idempotencyKey: "key",
  };
  const updated = await applyWorldDocument({
    ...base,
    operation: "update",
    targetId: "a",
    data: { name: "New" },
    expectedRevision: before.revision,
  });
  assert.equal(updated.source?.["name"], "New");
  assert.equal(updated.verified, true);
  assert.deepEqual(f.doc.options[0]?.["foundryLocalApiOrigin"], {
    source: "foundry-local-api.world-document",
    phase: "apply",
    correlationId: "corr",
  });
  await assert.rejects(
    applyWorldDocument({
      ...base,
      operation: "update",
      targetId: "a",
      data: { name: "Stale" },
      expectedRevision: before.revision,
    }),
    /Stale/,
  );
  const created = await applyWorldDocument({
    ...base,
    operation: "create",
    targetId: "newdoc",
    data: { name: "Created" },
    expectedRevision: null,
  });
  assert.equal(created.targetId, "newdoc");
  const listed = await readWorldDocument({ ...read, operation: "list", limit: 1 });
  assert.equal("documents" in listed ? listed.documents.length : 0, 1);
  await assert.rejects(
    applyWorldDocument({
      ...base,
      operation: "delete",
      targetId: "newdoc",
      expectedRevision: created.revision,
    }),
    /review/,
  );
  const deleted = await applyWorldDocument({
    ...base,
    operation: "delete",
    targetId: "newdoc",
    expectedRevision: created.revision,
    reviewedDestructive: true,
  });
  assert.equal(deleted.source, null);
  assert.equal(deleted.revision, null);
});
void test("world mismatch, revoked GM, executable/prototype data and ownership without review deny before effects", async () => {
  const f = fixture();
  const before = (await readWorldDocument(read)) as WorldDocumentSource;
  const base: WorldDocumentApply = {
    ...read,
    operation: "update",
    data: { name: "New" },
    expectedRevision: before.revision,
    correlationId: "corr",
    idempotencyKey: "key",
  };
  await assert.rejects(applyWorldDocument({ ...base, worldId: "other" }));
  for (const data of [
    { command: "danger" },
    { changes: [{ key: "macro.execute", value: "danger" }] },
    { flags: { dae: { onUseMacroName: "danger" } } },
    { "flags.script": "danger" },
    { ownership: { gm: 0 } },
    JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>,
    { description: '<img onerror="danger">' },
  ])
    await assert.rejects(applyWorldDocument({ ...base, data }));
  f.gm.active = false;
  await assert.rejects(applyWorldDocument(base));
  assert.equal(f.doc.options.length, 0);
});
void test("mismatched returned update source is uncertain; backend does not retry", async () => {
  const f = fixture();
  const before = (await readWorldDocument(read)) as WorldDocumentSource;
  let calls = 0;
  f.doc.update = () => {
    calls++;
    return Promise.resolve(f.doc);
  };
  await assert.rejects(
    applyWorldDocument({
      ...read,
      operation: "update",
      data: { name: "New" },
      expectedRevision: before.revision,
      correlationId: "corr",
      idempotencyKey: "key",
    }),
    /uncertain/,
  );
  assert.equal(calls, 1);
});
