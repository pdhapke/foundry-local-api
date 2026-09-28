/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { EMBEDDED_CHILD_COMMANDS } from "@foundry-local-api/shared";
import { dispatch } from "../command-registry.js";
import "./embedded-children.js";

class StringField {
  options: Record<string, unknown>;
  constructor(options = {}) {
    this.options = options;
  }
  validate(value: unknown) {
    return typeof value === "string" ? undefined : new Error("string required");
  }
}
class NumberField {
  options: Record<string, unknown>;
  constructor(options = {}) {
    this.options = options;
  }
  validate(value: unknown) {
    return typeof value === "number" ? undefined : new Error("number required");
  }
}
class Model {
  static metadata = { embedded: {} as Record<string, string> };
  static schema = {
    fields: {
      _id: new StringField({ required: true }),
      name: new StringField(),
      type: new StringField(),
      system: { constructor: { name: "SchemaField" }, fields: {} },
      flags: { constructor: { name: "ObjectField" } },
    },
    _validateModel: () => undefined,
  };
  static cleanData(data: Record<string, unknown>) {
    return structuredClone(data);
  }
  static migrateDataSafe(data: Record<string, unknown>) {
    if (data["legacyWarning"] === true)
      (globalThis as any).foundry.utils.logCompatibilityWarning("legacy embedded fixture field");
    return structuredClone(data);
  }
}
class BehaviorModel {
  static schema = {
    fields: { threshold: new NumberField({ required: true }), label: new StringField() },
  };
  static cleanData(data: Record<string, unknown>) {
    return structuredClone(data);
  }
  source: Record<string, unknown>;
  constructor(data: Record<string, unknown>) {
    this.source = structuredClone(data);
  }
  validate() {
    return true;
  }
  toObject() {
    return structuredClone(this.source);
  }
}
interface MockDoc {
  id: string;
  corruptNextUpdate: boolean;
  afterNextUpdate?: (() => void | Promise<void>) | undefined;
  afterNextDelete?: (() => void | Promise<void>) | undefined;
  toObject(): Record<string, unknown>;
  testUserPermission(): boolean;
  update(changes: Record<string, unknown>, options?: Record<string, unknown>): Promise<void>;
  delete(): Promise<void>;
}
function makeDoc(
  id: string,
  initial: Record<string, unknown>,
  owner?: Map<string, MockDoc>,
): MockDoc {
  let source = structuredClone(initial);
  const doc: MockDoc = {
    id,
    corruptNextUpdate: false,
    toObject: () => structuredClone(source),
    testUserPermission: () => true,
    update: async (changes: Record<string, unknown>, options?: Record<string, unknown>) => {
      source =
        options?.["diff"] === false
          ? structuredClone(changes)
          : { ...source, ...structuredClone(changes) };
      if (doc.corruptNextUpdate) {
        doc.corruptNextUpdate = false;
        source["unexpected"] = true;
      }
      const sideEffect = doc.afterNextUpdate;
      doc.afterNextUpdate = undefined;
      await sideEffect?.();
    },
    delete: async () => {
      owner?.delete(id);
      const sideEffect = doc.afterNextDelete;
      doc.afterNextDelete = undefined;
      await sideEffect?.();
    },
  };
  return doc;
}
function makeParent(id: string, family: string, region = false) {
  const children = new Map<string, MockDoc>();
  const parent = {
    id,
    name: "Stable Region",
    color: "#abcdef",
    failRestore: false,
    children,
    afterNextCreate: undefined as (() => void | Promise<void>) | undefined,
    toObject: () => ({
      _id: id,
      ...(region
        ? {
            name: parent.name,
            color: parent.color,
            behaviors: [...children.values()].map((x) => x.toObject()),
          }
        : { children: [...children.values()].map((x) => x.toObject()) }),
    }),
    testUserPermission: () => true,
    canUserModify: () => true,
    update: async (source: Record<string, unknown>) => {
      if (parent.failRestore) throw new Error("injected parent restore failure");
      if (typeof source["name"] === "string") parent.name = source["name"];
      if (typeof source["color"] === "string") parent.color = source["color"];
    },
    getEmbeddedCollection: (type: string) => {
      assert.equal(type, family);
      return children;
    },
    createEmbeddedDocuments: async (_type: string, items: Record<string, unknown>[]) => {
      const created = items.map((item) => {
        const child = makeDoc(item["_id"] as string, item, children);
        children.set(child.id, child);
        return child;
      });
      const sideEffect = parent.afterNextCreate;
      parent.afterNextCreate = undefined;
      await sideEffect?.();
      return created;
    },
  };
  return parent;
}
const families = [
  ["Tile", "Scene"],
  ["PlaylistSound", "Playlist"],
  ["TableResult", "RollTable"],
  ["Card", "Cards"],
] as const;

void describe("embedded child commands", () => {
  let parents: Map<string, ReturnType<typeof makeParent>>;
  let region: ReturnType<typeof makeParent>;
  beforeEach(() => {
    parents = new Map();
    const collections = new Map<string, Map<string, unknown>>();
    for (const [family, parentType] of families) {
      const parent = makeParent(`${family}-parent`, family);
      parent.children.set(
        "sibling",
        makeDoc("sibling", { _id: "sibling", name: "Keep" }, parent.children),
      );
      parents.set(family, parent);
      collections.set(parentType, new Map([[parent.id, parent]]));
    }
    region = makeParent("region", "RegionBehavior", true);
    region.children.set(
      "sibling",
      makeDoc(
        "sibling",
        {
          _id: "sibling",
          type: "threshold",
          name: "Keep",
          system: { threshold: 1, label: "original" },
        },
        region.children,
      ),
    );
    const scene = {
      id: "scene",
      toObject: () => ({ _id: "scene", regions: [region.toObject()] }),
      testUserPermission: () => true,
      getEmbeddedCollection: () => new Map([[region.id, region]]),
    };
    const scenes = collections.get("Scene") ?? new Map<string, unknown>();
    scenes.set(scene.id, scene);
    collections.set("Scene", scenes);
    Object.assign(globalThis, {
      game: {
        user: { isGM: true },
        release: { version: "14.368" },
        system: { id: "dnd5e", version: "6.0.3" },
        modules: new Map([["foundry-local-api", { version: "test" }]]),
        collections,
      },
      CONFIG: {
        Scene: {
          documentClass: class extends Model {
            static override metadata = { embedded: { Tile: "tiles", Region: "regions" } };
          },
        },
        Region: {
          documentClass: class extends Model {
            static override metadata = { embedded: { RegionBehavior: "behaviors" } };
          },
        },
        RegionBehavior: { documentClass: Model, dataModels: { threshold: BehaviorModel } },
        Playlist: {
          documentClass: class extends Model {
            static override metadata = { embedded: { PlaylistSound: "sounds" } };
          },
        },
        PlaylistSound: { documentClass: Model },
        RollTable: {
          documentClass: class extends Model {
            static override metadata = { embedded: { TableResult: "results" } };
          },
        },
        TableResult: { documentClass: Model },
        Cards: {
          documentClass: class extends Model {
            static override metadata = { embedded: { Card: "cards" } };
          },
        },
        Card: { documentClass: Model },
        Tile: { documentClass: Model },
      },
      foundry: { utils: { logCompatibilityWarning: () => undefined } },
    });
  });

  for (const [family] of families)
    void it(`round-trips ${family} CRUD and preserves its sibling`, async () => {
      const parent = parents.get(family)!;
      const list = await dispatch({
        id: `${family}-l`,
        type: EMBEDDED_CHILD_COMMANDS.LIST,
        payload: { family, parentId: parent.id },
      });
      assert.equal(list.ok, true);
      if (!list.ok) return;
      const create = await dispatch({
        id: `${family}-c`,
        type: EMBEDDED_CHILD_COMMANDS.CREATE,
        payload: {
          family,
          parentId: parent.id,
          expectedParentRevision: (list.result as any).parentRevision,
          idempotencyKey: `${family}-create-key`,
          data: { _id: "target", name: "Before" },
        },
      });
      assert.equal(create.ok, true);
      if (!create.ok) return;
      const update = await dispatch({
        id: `${family}-u`,
        type: EMBEDDED_CHILD_COMMANDS.UPDATE,
        payload: {
          family,
          parentId: parent.id,
          childId: "target",
          expectedParentRevision: (create.result as any).parentRevision,
          expectedChildRevision: (create.result as any).childRevision,
          idempotencyKey: `${family}-update-key`,
          changes: { name: "After" },
        },
      });
      assert.equal(update.ok, true);
      if (!update.ok) return;
      assert.deepEqual((update.result as any).diff, [
        { path: "name", kind: "changed", before: "Before", after: "After" },
      ]);
      const remove = await dispatch({
        id: `${family}-d`,
        type: EMBEDDED_CHILD_COMMANDS.DELETE,
        payload: {
          family,
          parentId: parent.id,
          childId: "target",
          expectedParentRevision: (update.result as any).parentRevision,
          expectedChildRevision: (update.result as any).childRevision,
          idempotencyKey: `${family}-delete-key`,
        },
      });
      assert.equal(remove.ok, true);
      assert.equal(parent.children.get("sibling")?.toObject()["name"], "Keep");
    });

  async function regionList(id: string) {
    return dispatch({
      id,
      type: EMBEDDED_CHILD_COMMANDS.LIST,
      payload: { family: "RegionBehavior", parentId: region.id, sceneId: "scene" },
    });
  }
  void it("validates a full merged RegionBehavior dry-run under its exact subtype", async () => {
    const before = region.toObject();
    const list = await regionList("rl1");
    assert.equal(list.ok, true);
    if (!list.ok) return;
    const selected = (list.result as any).children[0];
    const result = await dispatch({
      id: "rp",
      type: EMBEDDED_CHILD_COMMANDS.UPDATE,
      payload: {
        family: "RegionBehavior",
        parentId: region.id,
        sceneId: "scene",
        childId: "sibling",
        expectedParentRevision: (list.result as any).parentRevision,
        expectedChildRevision: selected.revision,
        idempotencyKey: "region-preview",
        dryRun: true,
        changes: { system: { threshold: 4 } },
      },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal((result.result as any).subtype, "threshold");
    assert.equal((result.result as any).persisted, false);
    assert.equal((result.result as any).after.system.label, "original");
    assert.deepEqual(region.toObject(), before);
  });
  void it("rejects an invalid RegionBehavior subtype without mutation", async () => {
    const list = await regionList("rl2");
    assert.equal(list.ok, true);
    if (!list.ok) return;
    const before = region.toObject();
    const result = await dispatch({
      id: "ri",
      type: EMBEDDED_CHILD_COMMANDS.CREATE,
      payload: {
        family: "RegionBehavior",
        parentId: region.id,
        sceneId: "scene",
        expectedParentRevision: (list.result as any).parentRevision,
        idempotencyKey: "invalid-subtype",
        data: { _id: "bad", type: "invalid", system: { threshold: 1 } },
      },
    });
    assert.equal(result.ok, false);
    assert.deepEqual(region.toObject(), before);
  });
  void it("rejects missing, blank, padded, and non-string RegionBehavior scene IDs", async () => {
    for (const [index, sceneId] of [undefined, "", " scene", 7].entries()) {
      const result = await dispatch({
        id: `invalid-scene-${index}`,
        type: EMBEDDED_CHILD_COMMANDS.LIST,
        payload: {
          family: "RegionBehavior",
          parentId: region.id,
          ...(sceneId === undefined ? {} : { sceneId }),
        },
      });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "INVALID_PAYLOAD");
        assert.equal(result.error.fieldPath, "sceneId");
      }
    }
  });
  void it("replays RegionBehavior create while retaining warnings, IDs, siblings, and Region fields", async () => {
    const list = await regionList("rl3");
    assert.equal(list.ok, true);
    if (!list.ok) return;
    const payload = {
      family: "RegionBehavior",
      parentId: region.id,
      sceneId: "scene",
      expectedParentRevision: (list.result as any).parentRevision,
      idempotencyKey: "stable-region-create",
      data: {
        _id: "target",
        type: "threshold",
        name: "Target",
        system: { threshold: 2 },
        extension: "warning",
      },
    };
    const first = await dispatch({ id: "rc1", type: EMBEDDED_CHILD_COMMANDS.CREATE, payload });
    const second = await dispatch({ id: "rc2", type: EMBEDDED_CHILD_COMMANDS.CREATE, payload });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal((second.result as any).replayed, true);
    assert.equal((first.result as any).childId, "target");
    assert.equal(
      (first.result as any).warnings.some((x: any) => x.path === "extension"),
      true,
    );
    assert.equal(region.name, "Stable Region");
    assert.equal(region.children.get("sibling")?.toObject()["name"], "Keep");
  });
  void it("round-trips RegionBehavior create, direct GET, update, and delete", async () => {
    const list = await regionList("region-roundtrip-list");
    assert.equal(list.ok, true);
    if (!list.ok) return;
    const create = await dispatch({
      id: "region-roundtrip-create",
      type: EMBEDDED_CHILD_COMMANDS.CREATE,
      payload: {
        family: "RegionBehavior",
        parentId: region.id,
        sceneId: "scene",
        expectedParentRevision: (list.result as any).parentRevision,
        idempotencyKey: "region-roundtrip-create-key",
        data: {
          _id: "roundtrip",
          type: "threshold",
          name: "Round Trip",
          system: { threshold: 2, label: "before" },
          flags: { "foundry-local-api": { testRunId: "embedded-region-roundtrip" } },
        },
      },
    });
    assert.equal(create.ok, true);
    if (!create.ok) return;
    const get = await dispatch({
      id: "region-roundtrip-get",
      type: EMBEDDED_CHILD_COMMANDS.GET,
      payload: {
        family: "RegionBehavior",
        parentId: region.id,
        sceneId: "scene",
        childId: "roundtrip",
      },
    });
    assert.equal(get.ok, true);
    if (!get.ok) return;
    assert.equal((get.result as any).data.system.threshold, 2);
    assert.equal(
      (get.result as any).data.flags["foundry-local-api"].testRunId,
      "embedded-region-roundtrip",
    );
    const update = await dispatch({
      id: "region-roundtrip-update",
      type: EMBEDDED_CHILD_COMMANDS.UPDATE,
      payload: {
        family: "RegionBehavior",
        parentId: region.id,
        sceneId: "scene",
        childId: "roundtrip",
        expectedParentRevision: (create.result as any).parentRevision,
        expectedChildRevision: (get.result as any).childRevision,
        idempotencyKey: "region-roundtrip-update-key",
        changes: { system: { threshold: 5 } },
      },
    });
    assert.equal(update.ok, true);
    if (!update.ok) return;
    assert.equal((update.result as any).data.system.threshold, 5);
    const remove = await dispatch({
      id: "region-roundtrip-delete",
      type: EMBEDDED_CHILD_COMMANDS.DELETE,
      payload: {
        family: "RegionBehavior",
        parentId: region.id,
        sceneId: "scene",
        childId: "roundtrip",
        expectedParentRevision: (update.result as any).parentRevision,
        expectedChildRevision: (update.result as any).childRevision,
        idempotencyKey: "region-roundtrip-delete-key",
      },
    });
    assert.equal(remove.ok, true);
    assert.equal(region.children.has("roundtrip"), false);
    assert.equal(region.children.get("sibling")?.toObject()["name"], "Keep");
  });
  void it("exactly compensates after an injected post-write verification failure", async () => {
    const target = region.children.get("sibling")!;
    const before = target.toObject();
    const list = await regionList("rl4");
    assert.equal(list.ok, true);
    if (!list.ok) return;
    const selected = (list.result as any).children[0];
    target.corruptNextUpdate = true;
    const result = await dispatch({
      id: "rr",
      type: EMBEDDED_CHILD_COMMANDS.UPDATE,
      payload: {
        family: "RegionBehavior",
        parentId: region.id,
        sceneId: "scene",
        childId: "sibling",
        expectedParentRevision: (list.result as any).parentRevision,
        expectedChildRevision: selected.revision,
        idempotencyKey: "rollback-region",
        changes: { system: { threshold: 9 } },
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok)
      assert.equal(result.error.code, "INCOMPLETE_RESULT", JSON.stringify(result.error));
    assert.deepEqual(target.toObject(), before);
  });

  const allFamilies = ["Tile", "RegionBehavior", "PlaylistSound", "TableResult", "Card"] as const;

  function selectedParent(family: (typeof allFamilies)[number]) {
    return family === "RegionBehavior" ? region : parents.get(family)!;
  }

  function parentPayload(family: (typeof allFamilies)[number], parentId: string) {
    return {
      family,
      parentId,
      ...(family === "RegionBehavior" ? { sceneId: "scene" } : {}),
    };
  }

  for (const family of allFamilies) {
    void it(`directly gets an exact projected ${family}`, async () => {
      const parent = selectedParent(family);
      const result = await dispatch({
        id: `${family}-direct-get`,
        type: EMBEDDED_CHILD_COMMANDS.GET,
        payload: {
          ...parentPayload(family, parent.id),
          childId: "sibling",
        },
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal((result.result as any).family, family);
      assert.equal((result.result as any).childId, "sibling");
      assert.equal((result.result as any).data.name, "Keep");
      assert.match((result.result as any).childRevision, /^[0-9a-f]{64}$/);
    });

    void it(`propagates safe validation warnings for ${family}`, async () => {
      const parent = selectedParent(family);
      const parentInput = parentPayload(family, parent.id);
      const list = await dispatch({
        id: `${family}-warning-list`,
        type: EMBEDDED_CHILD_COMMANDS.LIST,
        payload: parentInput,
      });
      assert.equal(list.ok, true);
      if (!list.ok) return;
      const data = {
        _id: "warning-target",
        name: "Warning Target",
        extension: "unknown-field",
        legacyWarning: true,
        ...(family === "RegionBehavior"
          ? { type: "threshold", system: { threshold: 2, label: "warning" } }
          : {}),
      };
      const payload = {
        ...parentInput,
        expectedParentRevision: (list.result as any).parentRevision,
        idempotencyKey: `${family}-warning-key`,
        data,
      };
      const first = await dispatch({
        id: `${family}-warning-create`,
        type: EMBEDDED_CHILD_COMMANDS.CREATE,
        payload,
      });
      const replay = await dispatch({
        id: `${family}-warning-replay`,
        type: EMBEDDED_CHILD_COMMANDS.CREATE,
        payload,
      });
      assert.equal(first.ok, true);
      assert.equal(replay.ok, true);
      if (!first.ok || !replay.ok) return;
      for (const result of [first.result as any, replay.result as any]) {
        assert.equal(
          result.warnings.some((warning: any) => warning.path === "extension"),
          true,
        );
        assert.deepEqual(result.migrationWarnings, ["legacy embedded fixture field"]);
      }
    });

    void it(`returns an idempotent already-absent deletion for ${family}`, async () => {
      const parent = selectedParent(family);
      const before = parent.toObject();
      const result = await dispatch({
        id: `${family}-absent-delete`,
        type: EMBEDDED_CHILD_COMMANDS.DELETE,
        payload: {
          ...parentPayload(family, parent.id),
          childId: "already-absent",
          expectedParentRevision: "stale-is-irrelevant-for-an-absent-no-op",
          expectedChildRevision: "known-prior-child-revision",
          idempotencyKey: `${family}-absent-delete-key`,
        },
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal((result.result as any).alreadyAbsent, true);
      assert.equal((result.result as any).deleted, false);
      assert.equal((result.result as any).persisted, false);
      assert.deepEqual(parent.toObject(), before);
    });

    void it(`restores the complete ${family} sibling set after collateral write damage`, async () => {
      const parent = selectedParent(family);
      const targetSource = {
        _id: "compensation-target",
        name: "Before",
        flags: { "foundry-local-api": { testRunId: `${family}-compensation-run` } },
        ...(family === "RegionBehavior"
          ? { type: "threshold", system: { threshold: 2, label: "before" } }
          : {}),
      };
      const target = makeDoc("compensation-target", targetSource, parent.children);
      parent.children.set(target.id, target);
      const completeBefore = new Map(
        [...parent.children].map(([id, document]) => [id, document.toObject()]),
      );
      const completeParentBefore = parent.toObject();
      const list = await dispatch({
        id: `${family}-compensation-list`,
        type: EMBEDDED_CHILD_COMMANDS.LIST,
        payload: parentPayload(family, parent.id),
      });
      assert.equal(list.ok, true);
      if (!list.ok) return;
      const selected = (list.result as any).children.find(
        (entry: any) => entry.childId === target.id,
      );
      target.afterNextUpdate = async () => {
        await parent.children.get("sibling")!.delete();
        parent.children.set(
          "unexpected-sibling",
          makeDoc(
            "unexpected-sibling",
            { _id: "unexpected-sibling", name: "Must be removed" },
            parent.children,
          ),
        );
        if (family === "RegionBehavior") {
          parent.name = "Collateral Region name";
          parent.color = "#000000";
        }
      };
      const result = await dispatch({
        id: `${family}-compensation-update`,
        type: EMBEDDED_CHILD_COMMANDS.UPDATE,
        payload: {
          ...parentPayload(family, parent.id),
          childId: target.id,
          expectedParentRevision: (list.result as any).parentRevision,
          expectedChildRevision: selected.revision,
          idempotencyKey: `${family}-compensation-key`,
          changes: family === "RegionBehavior" ? { system: { threshold: 8 } } : { name: "After" },
        },
      });
      assert.equal(result.ok, false);
      if (family === "RegionBehavior") {
        assert.deepEqual(parent.toObject(), completeParentBefore);
      }
      if (!result.ok)
        assert.equal(result.error.code, "INCOMPLETE_RESULT", JSON.stringify(result.error));
      assert.deepEqual(
        new Map([...parent.children].map(([id, document]) => [id, document.toObject()])),
        completeBefore,
      );
      if (family === "RegionBehavior") {
        if (!result.ok) assert.equal(result.error.details?.["compensationVerified"], true);

        const retry = await dispatch({
          id: `${family}-compensation-retry`,
          type: EMBEDDED_CHILD_COMMANDS.UPDATE,
          payload: {
            ...parentPayload(family, parent.id),
            childId: target.id,
            expectedParentRevision: (list.result as any).parentRevision,
            expectedChildRevision: selected.revision,
            idempotencyKey: `${family}-compensation-key`,
            changes: { system: { threshold: 8 } },
          },
        });
        assert.equal(retry.ok, true);
      }
    });

    void it(`restores the complete ${family} collection after create collateral damage`, async () => {
      const parent = selectedParent(family);
      const completeBefore = new Map(
        [...parent.children].map(([id, document]) => [id, document.toObject()]),
      );
      const list = await dispatch({
        id: `${family}-create-collateral-list`,
        type: EMBEDDED_CHILD_COMMANDS.LIST,
        payload: parentPayload(family, parent.id),
      });
      assert.equal(list.ok, true);
      if (!list.ok) return;
      parent.afterNextCreate = async () => {
        await parent.children.get("sibling")!.delete();
      };
      const result = await dispatch({
        id: `${family}-create-collateral`,
        type: EMBEDDED_CHILD_COMMANDS.CREATE,
        payload: {
          ...parentPayload(family, parent.id),
          expectedParentRevision: (list.result as any).parentRevision,
          idempotencyKey: `${family}-create-collateral-key`,
          data: {
            _id: "create-collateral-target",
            name: "Created",
            flags: { "foundry-local-api": { testRunId: `${family}-create-collateral-run` } },
            ...(family === "RegionBehavior"
              ? { type: "threshold", system: { threshold: 3, label: "created" } }
              : {}),
          },
        },
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "INCOMPLETE_RESULT");
      assert.deepEqual(
        new Map([...parent.children].map(([id, document]) => [id, document.toObject()])),
        completeBefore,
      );
    });

    void it(`restores the complete ${family} collection after delete collateral damage`, async () => {
      const parent = selectedParent(family);
      const targetSource = {
        _id: "delete-collateral-target",
        name: "Delete Target",
        flags: { "foundry-local-api": { testRunId: `${family}-delete-collateral-run` } },
        ...(family === "RegionBehavior"
          ? { type: "threshold", system: { threshold: 4, label: "delete" } }
          : {}),
      };
      const target = makeDoc("delete-collateral-target", targetSource, parent.children);
      parent.children.set(target.id, target);
      const completeBefore = new Map(
        [...parent.children].map(([id, document]) => [id, document.toObject()]),
      );
      const list = await dispatch({
        id: `${family}-delete-collateral-list`,
        type: EMBEDDED_CHILD_COMMANDS.LIST,
        payload: parentPayload(family, parent.id),
      });
      assert.equal(list.ok, true);
      if (!list.ok) return;
      const selected = (list.result as any).children.find(
        (entry: any) => entry.childId === target.id,
      );
      target.afterNextDelete = async () => {
        await parent.children.get("sibling")!.delete();
      };
      const result = await dispatch({
        id: `${family}-delete-collateral`,
        type: EMBEDDED_CHILD_COMMANDS.DELETE,
        payload: {
          ...parentPayload(family, parent.id),
          childId: target.id,
          expectedParentRevision: (list.result as any).parentRevision,
          expectedChildRevision: selected.revision,
          idempotencyKey: `${family}-delete-collateral-key`,
        },
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "INCOMPLETE_RESULT");
      assert.deepEqual(
        new Map([...parent.children].map(([id, document]) => [id, document.toObject()])),
        completeBefore,
      );
    });
  }

  void it("fails closed when complete Region restoration cannot be proven", async () => {
    const target = region.children.get("sibling")!;
    const list = await regionList("restore-failure-list");
    assert.equal(list.ok, true);
    if (!list.ok) return;
    const selected = (list.result as any).children[0];
    target.afterNextUpdate = () => {
      region.name = "Unrestorable collateral mutation";
      region.failRestore = true;
    };
    const result = await dispatch({
      id: "restore-failure-update",
      type: EMBEDDED_CHILD_COMMANDS.UPDATE,
      payload: {
        family: "RegionBehavior",
        parentId: region.id,
        sceneId: "scene",
        childId: target.id,
        expectedParentRevision: (list.result as any).parentRevision,
        expectedChildRevision: selected.revision,
        idempotencyKey: "restore-failure-key",
        changes: { system: { threshold: 5 } },
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "ROLLBACK_FAILED");
      assert.notEqual(result.error.details?.["compensationVerified"], true);
    }
  });

  void it("projects internal and transport secrets out of list, get, and mutation results", async () => {
    const parent = parents.get("Tile")!;
    const source = {
      _id: "secret-source",
      name: "Visible",
      _stats: { modifiedBy: "other-user" },
      ownership: { "other-user": 3 },
      credential: "must-not-leak",
      token: "token-must-not-leak",
      access_token: "access-token-must-not-leak",
      refreshToken: "refresh-token-must-not-leak",
      "client-secret": "client-secret-must-not-leak",
      private_key: "private-key-must-not-leak",
      Session_ID: "session-must-not-leak",
      Authorization: "authorization-must-not-leak",
      api_key: "api-key-must-not-leak",
      nested: { bearerTokenValue: "nested-token-must-not-leak", visible: "nested-visible" },
      flags: {
        "foundry-local-api": { idempotencyKey: "internal-key", testRunId: "safe-fixture-id" },
      },
    };
    parent.children.set("secret-source", makeDoc("secret-source", source, parent.children));
    const list = await dispatch({
      id: "secret-list",
      type: EMBEDDED_CHILD_COMMANDS.LIST,
      payload: { family: "Tile", parentId: parent.id },
    });
    const get = await dispatch({
      id: "secret-get",
      type: EMBEDDED_CHILD_COMMANDS.GET,
      payload: { family: "Tile", parentId: parent.id, childId: "secret-source" },
    });
    const mutation = await dispatch({
      id: "secret-mutation",
      type: EMBEDDED_CHILD_COMMANDS.CREATE,
      payload: {
        family: "Tile",
        parentId: parent.id,
        expectedParentRevision: list.ok ? (list.result as any).parentRevision : "unreachable",
        idempotencyKey: "secret-mutation-key",
        dryRun: true,
        data: {
          _id: "secret-preview",
          name: "Visible Preview",
          credential: "preview-must-not-leak",
          AccessToken: "preview-token-must-not-leak",
          flags: { "foundry-local-api": { idempotencyKey: "caller-secret" } },
        },
      },
    });
    assert.equal(list.ok, true);
    assert.equal(get.ok, true);
    assert.equal(mutation.ok, true, JSON.stringify(mutation));
    const serialized = JSON.stringify([list, get, mutation]);
    assert.equal(serialized.includes("must-not-leak"), false, serialized);
    assert.equal(serialized.includes("preview-must-not-leak"), false);
    assert.equal(serialized.includes("caller-secret"), false);
    assert.equal(serialized.includes("internal-key"), false);
    assert.equal(serialized.includes("other-user"), false);
    for (const secret of [
      "token-must-not-leak",
      "access-token-must-not-leak",
      "refresh-token-must-not-leak",
      "client-secret-must-not-leak",
      "private-key-must-not-leak",
      "session-must-not-leak",
      "authorization-must-not-leak",
      "api-key-must-not-leak",
      "nested-token-must-not-leak",
      "preview-token-must-not-leak",
    ])
      assert.equal(serialized.includes(secret), false, secret);
    assert.equal(serialized.includes("nested-visible"), true);
    assert.equal(serialized.includes("safe-fixture-id"), true);
  });

  void it("returns only bounded rollback codes when runtime failures contain secrets", async () => {
    const parent = parents.get("Tile")!;
    parent.children.set(
      "lost-sibling",
      makeDoc("lost-sibling", { _id: "lost-sibling", name: "Restore Me" }, parent.children),
    );
    const list = await dispatch({
      id: "safe-rollback-list",
      type: EMBEDDED_CHILD_COMMANDS.LIST,
      payload: { family: "Tile", parentId: parent.id },
    });
    assert.equal(list.ok, true);
    if (!list.ok) return;
    const target = parent.children.get("sibling")!;
    const selected = (list.result as any).children.find(
      (entry: any) => entry.childId === target.id,
    );
    target.afterNextUpdate = async () => {
      await parent.children.get("lost-sibling")!.delete();
    };
    parent.createEmbeddedDocuments = async () => {
      throw new Error("Authorization: Bearer runtime-secret-value");
    };
    const result = await dispatch({
      id: "safe-rollback-update",
      type: EMBEDDED_CHILD_COMMANDS.UPDATE,
      payload: {
        family: "Tile",
        parentId: parent.id,
        childId: target.id,
        expectedParentRevision: (list.result as any).parentRevision,
        expectedChildRevision: selected.revision,
        idempotencyKey: "safe-rollback-update-key",
        changes: { name: "Changed" },
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "ROLLBACK_FAILED");
      assert.equal(result.error.details?.["originalErrorCode"], "INCOMPLETE_RESULT");
      assert.equal(result.error.details?.["rollbackErrorCode"], "UNEXPECTED_ERROR");
      assert.equal(JSON.stringify(result).includes("runtime-secret-value"), false);
    }
  });
});
