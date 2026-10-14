import assert from "node:assert/strict";
import test from "node:test";
import { applyWorldDocument } from "./world-documents.js";
import { registerDocumentGuard } from "../document-guards.js";
const prep = "a".repeat(64);
// The API tests only generic extension invocation. AI DM owns and tests the
// actual preparation policy in its own module.
const fixturePolicy = (raw: unknown): void => {
  const value = raw as {
    input: { family: string; operation: string; preparationGuard: { preparationId: string } };
    data: Record<string, any>;
    source?: Record<string, any>;
  };
  const source =
    value.input.family === "scenes" && value.input.operation === "create"
      ? value.data
      : value.source;
  if (source?.active !== false) throw new Error("Fixture parent became active");
  if (
    source?.flags?.["preparation-fixture"]?.preparationId !==
    value.input.preparationGuard.preparationId
  )
    throw new Error("Fixture parent changed");
};
// Node's test runner owns completion of these registered tests.
void test("registered document policy denies active/mismatched parents and serializes conflicting writes", async (t) => {
  t.after(registerDocumentGuard("preparation", fixturePolicy));
  const documents = new Map<string, any>();
  const scene = {
    data: {
      _id: "scene",
      active: false,
      flags: { "preparation-fixture": { preparationId: prep } },
    },
    toObject() {
      return structuredClone(this.data);
    },
    getEmbeddedCollection() {
      return documents;
    },
  };
  const gm = { id: "gm", isGM: true, active: true };
  Object.assign(globalThis, {
    game: {
      world: { id: "w" },
      user: gm,
      users: new Map([["gm", gm]]),
      collections: new Map([["Scene", new Map([["scene", scene]])]]),
    },
    CONFIG: {
      Token: {
        documentClass: {
          create: async (data: any) => {
            await Promise.resolve();
            const doc = { toObject: () => structuredClone(data) };
            documents.set(data._id, doc);
            return doc;
          },
        },
      },
    },
  });
  const request = {
    worldId: "w",
    requestingUserId: "gm",
    family: "scene-tokens" as const,
    parentId: "scene",
    operation: "create" as const,
    targetId: "token",
    data: { actorLink: false, hidden: true },
    expectedRevision: null,
    correlationId: "corr",
    idempotencyKey: "key",
    preparationGuard: { sceneId: "scene", preparationId: prep },
  };
  scene.data.active = true;
  await assert.rejects(applyWorldDocument(request), /active/);
  assert.equal(documents.size, 0);
  scene.data.active = false;
  await assert.rejects(
    applyWorldDocument({
      ...request,
      preparationGuard: { sceneId: "scene", preparationId: "b".repeat(64) },
    }),
    /changed/,
  );
  const results = await Promise.allSettled([
    applyWorldDocument(request),
    applyWorldDocument(request),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(documents.size, 1);
});
void test("v14 native scene creation verifies levels despite schema-populated defaults", async (t) => {
  t.after(registerDocumentGuard("preparation", fixturePolicy));
  const documents = new Map<string, any>(),
    gm = { id: "gm", isGM: true, active: true };
  Object.assign(globalThis, {
    game: {
      world: { id: "w" },
      user: gm,
      users: new Map([["gm", gm]]),
      collections: new Map([["Scene", documents]]),
    },
    CONFIG: {
      Scene: {
        documentClass: {
          create: async (data: any) => {
            const source = structuredClone(data);
            source.levels[0].background.tint = "#ffffff";
            source.levels[0].background.color = "#999999";
            source.levels[0].elevation = { bottom: 0, top: 20 };
            source.levels[0].foreground = { src: null };
            const doc = { toObject: () => structuredClone(source) };
            documents.set(data._id, doc);
            return doc;
          },
        },
      },
    },
  });
  const result = await applyWorldDocument({
    worldId: "w",
    requestingUserId: "gm",
    family: "scenes",
    operation: "create",
    targetId: "scene",
    data: {
      active: false,
      navigation: false,
      ownership: { default: 0 },
      initialLevel: "0123456789abcdef",
      shiftX: 0,
      shiftY: 0,
      flags: { "preparation-fixture": { preparationId: prep } },
      levels: [
        {
          _id: "0123456789abcdef",
          name: "Map",
          background: { src: "map.webp" },
          textures: { scaleX: 1, scaleY: 1, fit: "fill" },
        },
      ],
    },
    expectedRevision: null,
    correlationId: "scene-create",
    idempotencyKey: "scene-create",
    reviewedDestructive: true,
    preparationGuard: { sceneId: "scene", preparationId: prep },
  });
  assert.equal(result.verified, true);
  assert.equal(Object.hasOwn(result.source!, "background"), false);
});
