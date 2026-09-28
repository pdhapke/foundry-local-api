import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { ProtocolError } from "@foundry-local-api/shared";

import { discoverDocumentSchema, validateDocumentSchema } from "./schema-discovery.js";

const savedConfig = Object.getOwnPropertyDescriptor(globalThis, "CONFIG");
const savedGame = Object.getOwnPropertyDescriptor(globalThis, "game");
const savedFoundry = Object.getOwnPropertyDescriptor(globalThis, "foundry");
let mutationCalls: string[];
let jointValidationCalls: number;
let updateSourceCalls: number;
let coreFieldValidationCalls: number;
let coreJointValidationCalls: number;
let coreWorkflow: string[];
let allowParentAccess: boolean;

const VERSION_LOCK = {
  expectedFoundryVersion: "14.368",
  expectedSystemId: "dnd5e",
  expectedSystemVersion: "6.0.3",
} as const;

class MockValidationFailure {
  constructor(
    readonly fieldPath: string,
    readonly message: string,
  ) {}
}

class MockValidationError extends Error {
  constructor(
    message: string,
    private readonly failures: Record<string, MockValidationFailure>,
  ) {
    super(message);
  }
  getAllFailures() {
    return this.failures;
  }
}

class StringField {
  name?: string;
  readonly options: {
    required?: boolean;
    nullable?: boolean;
    initial?: unknown;
    choices?: string[] | (() => string[]);
  };
  constructor(options: StringField["options"] = {}) {
    this.options = options;
  }
  clean(value: unknown) {
    if (value === undefined) {
      return typeof this.options.initial === "function"
        ? this.options.initial()
        : this.options.initial;
    }
    return String(value);
  }
  validate(value: unknown) {
    coreFieldValidationCalls += 1;
    coreWorkflow.push("field");
    return typeof value === "string" || (value === null && this.options.nullable)
      ? undefined
      : new MockValidationFailure(this.name ?? "string", "must be a string");
  }
}
class NumberField {
  name?: string;
  readonly options: { required?: boolean; nullable?: boolean; initial?: number };
  constructor(options: NumberField["options"] = {}) {
    this.options = options;
  }
  clean(value: unknown) {
    if (value === undefined) return this.options.initial;
    return Number(value);
  }
  validate(value: unknown) {
    return typeof value === "number" && Number.isFinite(value)
      ? undefined
      : new MockValidationFailure(this.name ?? "number", "must be a finite number");
  }
}

class ArrayField {
  name?: string;
  readonly options: { required?: boolean; nullable?: boolean; initial?: unknown[] };
  constructor(options: ArrayField["options"] = {}) {
    this.options = options;
  }
  clean(value: unknown) {
    return value === undefined ? structuredClone(this.options.initial) : value;
  }
  validate(value: unknown) {
    return Array.isArray(value)
      ? undefined
      : new MockValidationFailure(this.name ?? "array", "must be an array");
  }
}

class SchemaField {
  name?: string;
  readonly options: { required?: boolean; nullable?: boolean; initial?: unknown };
  constructor(
    readonly fields: Record<string, StringField | NumberField | ArrayField>,
    options: SchemaField["options"] = {},
  ) {
    this.options = options;
  }
  clean(value: unknown) {
    const source = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    if (Object.keys(this.fields).length === 0) return structuredClone(source);
    return Object.fromEntries(
      Object.entries(this.fields)
        .map(([name, field]) => {
          field.name = this.name ? `${this.name}.${name}` : name;
          return [name, field.clean(source[name])];
        })
        .filter(([, child]) => child !== undefined),
    );
  }
}

class MockDocumentModel {
  static schema: {
    fields: Record<string, StringField | NumberField | ArrayField | SchemaField>;
    _validateModel?: (data: Record<string, unknown>) => void;
  } = { fields: {} };
  constructor() {
    mutationCalls.push("document-constructor");
  }
  static migrateDataSafe(data: Record<string, unknown>) {
    coreWorkflow.push("migrate");
    return structuredClone(data);
  }
  static cleanData(data: Record<string, unknown>, options: { partial?: boolean } = {}) {
    coreWorkflow.push("clean");
    const cleaned: Record<string, unknown> = {};
    for (const [name, field] of Object.entries(this.schema.fields)) {
      if (options.partial && !(name in data)) continue;
      field.name = name;
      const value = field.clean(data[name]);
      if (value !== undefined) cleaned[name] = value;
    }
    return cleaned;
  }
  static validateJoint(_data: Record<string, unknown>) {
    coreJointValidationCalls += 1;
    coreWorkflow.push("joint");
  }
}

class ActorDocumentModel extends MockDocumentModel {
  static metadata = { embedded: { Item: "items" } };
  static override schema = {
    fields: {
      name: new StringField({ required: true }),
      type: new StringField({ required: true, choices: ["character", "npc"] }),
      system: new SchemaField({}, { required: true }),
      generated: new StringField({
        initial: () => "runtime-default",
        choices: () => ["runtime-choice"],
      }),
      nullableDefault: new StringField({ nullable: true, initial: null }),
    },
  };
  static create() {
    mutationCalls.push("create");
  }
  static updateDocuments() {
    mutationCalls.push("update");
  }
}
class ItemDocumentModel extends MockDocumentModel {
  static metadata = { isEmbedded: true, embedded: { ActiveEffect: "effects" } };
  static override schema = { fields: { name: new StringField({ required: true }) } };
}
class ActiveEffectDocumentModel extends MockDocumentModel {
  static metadata = { isEmbedded: true };
  static override schema = { fields: { name: new StringField({ required: true }) } };
}
class CharacterDataModel {
  static schema = {
    fields: {
      hp: new SchemaField({ value: new NumberField({ initial: 10 }) }),
    },
  };
  readonly source: Record<string, unknown>;
  constructor(data: Record<string, unknown> = {}) {
    this.source = structuredClone(data);
  }
  static cleanData(data: Record<string, unknown>) {
    this.schema.fields.hp.name = "hp";
    return { hp: this.schema.fields.hp.clean(data.hp) };
  }
  static migrateDataSafe(data: Record<string, unknown>) {
    (
      globalThis as unknown as {
        foundry: { utils: { logCompatibilityWarning: (message: string) => void } };
      }
    ).foundry.utils.logCompatibilityWarning("Synthetic hp migration warning");
    return data;
  }
  updateSource(changes: Record<string, unknown>, options?: { dryRun?: boolean }) {
    updateSourceCalls += 1;
    const proposed = { ...this.source, ...structuredClone(changes) };
    const hp = (proposed.hp as { value?: number } | undefined)?.value;
    if (hp === 13) {
      throw new MockValidationError("joint validation failed", {
        "hp.value": new MockValidationFailure(
          "hp.value",
          "Thirteen is forbidden by the joint validator.",
        ),
      });
    }
    if (!options?.dryRun) Object.assign(this.source, proposed);
  }
  validate() {
    jointValidationCalls += 1;
    const hp = (this.source.hp as { value?: number } | undefined)?.value;
    if (hp === 13) {
      throw new MockValidationError("joint validation failed", {
        "hp.value": new MockValidationFailure(
          "hp.value",
          "Thirteen is forbidden by the joint validator.",
        ),
      });
    }
    return true;
  }
  toObject() {
    return structuredClone(this.source);
  }
}

class SceneDocumentModel extends MockDocumentModel {
  static metadata = { embedded: { Token: "tokens", Wall: "walls", Region: "regions" } };
  static override schema = { fields: { name: new StringField({ required: true }) } };
}
class JournalEntryPageDocumentModel extends MockDocumentModel {
  static override schema = {
    fields: {
      name: new StringField({ required: true }),
      type: new StringField({ required: true, choices: ["text", "image"] }),
    },
  };
}
class TokenDocumentModel extends MockDocumentModel {
  static override schema = {
    fields: {
      name: new StringField({ required: true }),
      x: new NumberField({ required: true }),
      y: new NumberField({ required: true }),
    },
  };
}
class WallDocumentModel extends MockDocumentModel {
  static override schema = { fields: { c: new ArrayField({ required: true }) } };
}
class RegionDocumentModel extends MockDocumentModel {
  static metadata = { embedded: { RegionBehavior: "behaviors" } };
  static override schema = {
    fields: {
      name: new StringField({ required: true }),
      shapes: new ArrayField({ required: true }),
    },
  };
}
class RegionBehaviorDocumentModel extends MockDocumentModel {
  static metadata = { isEmbedded: true };
  static override schema = { fields: { type: new StringField({ required: true }) } };
}
class PlaylistSoundDocumentModel extends MockDocumentModel {
  static override schema = {
    fields: {
      name: new StringField({ required: true }),
      path: new StringField({ required: true }),
    },
  };
}
class TableResultDocumentModel extends MockDocumentModel {
  static override schema = {
    fields: {
      text: new StringField({ required: true }),
      range: new ArrayField({ required: true }),
    },
  };
}
class CardDocumentModel extends MockDocumentModel {
  static override schema = { fields: { name: new StringField({ required: true }) } };
}

function setGlobal(name: "CONFIG" | "game" | "foundry", value: unknown): void {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

beforeEach(() => {
  mutationCalls = [];
  jointValidationCalls = 0;
  updateSourceCalls = 0;
  coreFieldValidationCalls = 0;
  coreJointValidationCalls = 0;
  coreWorkflow = [];
  allowParentAccess = true;
  setGlobal("CONFIG", {
    Actor: { documentClass: ActorDocumentModel, dataModels: { character: CharacterDataModel } },
    Item: { documentClass: ItemDocumentModel },
    ActiveEffect: { documentClass: ActiveEffectDocumentModel },
    Scene: { documentClass: SceneDocumentModel },
    JournalEntryPage: { documentClass: JournalEntryPageDocumentModel },
    Token: { documentClass: TokenDocumentModel },
    Wall: { documentClass: WallDocumentModel },
    Region: { documentClass: RegionDocumentModel },
    RegionBehavior: { documentClass: RegionBehaviorDocumentModel },
    PlaylistSound: { documentClass: PlaylistSoundDocumentModel },
    TableResult: { documentClass: TableResultDocumentModel },
    Card: { documentClass: CardDocumentModel },
  });
  setGlobal("foundry", {
    utils: { logCompatibilityWarning: (_message: string) => undefined },
  });
  setGlobal("game", {
    release: { version: "14.368" },
    system: { id: "dnd5e", version: "6.0.3" },
    modules: new Map([["foundry-local-api", { version: "0.1.0" }]]),
    user: { id: "gm", isGM: true },
    collections: new Map([
      [
        "Actor",
        new Map([
          [
            "actor-throws",
            {
              id: "actor-throws",
              testUserPermission: () => allowParentAccess,
              toObject: () => ({ _id: "actor-throws", _stats: { modifiedTime: 0 } }),
              getEmbeddedCollection: () => {
                throw new Error("unknown embedded collection");
              },
            },
          ],
          [
            "parent-1",
            {
              id: "parent-1",
              testUserPermission: () => allowParentAccess,
              toObject: () => ({ _id: "parent-1", _stats: { modifiedTime: 1 } }),
              getEmbeddedCollection: (type: string) =>
                type === "Item"
                  ? new Map([
                      [
                        "embedded-item-1",
                        {
                          id: "embedded-item-1",
                          testUserPermission: () => allowParentAccess,
                          toObject: () => ({ _id: "embedded-item-1" }),
                        },
                      ],
                    ])
                  : new Map(),
            },
          ],
        ]),
      ],
      [
        "Scene",
        new Map([
          [
            "scene-throws",
            {
              id: "scene-throws",
              testUserPermission: () => allowParentAccess,
              toObject: () => ({ _id: "scene-throws", _stats: { modifiedTime: 0 } }),
              getEmbeddedCollection: () => {
                throw new Error("unknown embedded collection");
              },
            },
          ],
          [
            "scene-1",
            {
              id: "scene-1",
              testUserPermission: () => allowParentAccess,
              toObject: () => ({ _id: "scene-1", _stats: { modifiedTime: 2 } }),
              getEmbeddedCollection: (type: string) =>
                type === "Region"
                  ? new Map([
                      [
                        "region-1",
                        {
                          id: "region-1",
                          testUserPermission: () => allowParentAccess,
                          toObject: () => ({ _id: "region-1" }),
                        },
                      ],
                    ])
                  : new Map(),
            },
          ],
        ]),
      ],
    ]),
  });
});

afterEach(() => {
  if (savedConfig) Object.defineProperty(globalThis, "CONFIG", savedConfig);
  else Reflect.deleteProperty(globalThis, "CONFIG");
  if (savedGame) Object.defineProperty(globalThis, "game", savedGame);
  else Reflect.deleteProperty(globalThis, "game");
  if (savedFoundry) Object.defineProperty(globalThis, "foundry", savedFoundry);
  else Reflect.deleteProperty(globalThis, "foundry");
});

void describe("MCP-REQ-003 module schema commands", () => {
  void it("discovers core and subtype system fields with runtime context", () => {
    const result = discoverDocumentSchema({
      ...VERSION_LOCK,
      documentType: "Actor",
      subtype: "character",
    });
    assert.equal(result.context.foundryVersion, "14.368");
    assert.equal(result.context.systemVersion, "6.0.3");
    assert.ok(result.fields.some(({ path }) => path === "name"));
    assert.ok(result.fields.some(({ path }) => path === "system.hp.value"));
    assert.equal(result.fields.find(({ path }) => path === "name")?.required, true);
    assert.deepEqual(result.fields.find(({ path }) => path === "type")?.choices, [
      "character",
      "npc",
    ]);
    const nullDefault = result.fields.find(({ path }) => path === "nullableDefault");
    assert.equal(nullDefault?.hasDefault, true);
    assert.equal(nullDefault?.defaultValue, null);
    assert.ok(result.limitations.some((value) => value.includes("Dynamic defaults")));
    assert.ok(result.limitations.some((value) => value.includes("Dynamic choice providers")));
    assert.equal(result.readOnly, true);
  });

  void it("validates an embedded document target and preserves its parent constraint", () => {
    const result = discoverDocumentSchema({
      documentType: "Item",
      parentDocumentType: "Actor",
      parentDocumentId: "parent-1",
      ...VERSION_LOCK,
    });
    assert.equal(result.context.embedded, true);
    assert.equal(result.context.parentDocumentType, "Actor");
    assert.equal(result.context.parentDocumentId, "parent-1");

    const behavior = discoverDocumentSchema({
      ...VERSION_LOCK,
      documentType: "RegionBehavior",
      parentDocumentType: "Region",
      parentDocumentId: "region-1",
    });
    assert.equal(behavior.context.parentDocumentType, "Region");

    const itemChild = discoverDocumentSchema({
      ...VERSION_LOCK,
      documentType: "ActiveEffect",
      parentDocumentType: "Item",
      parentDocumentId: "embedded-item-1",
    });
    assert.equal(itemChild.context.parentDocumentType, "Item");
  });

  void it("returns paths for required/enum errors, warnings, normalized defaults, and no mutation", () => {
    const input = { type: "vehicle", system: { hp: { extra: 1 } }, surprise: true };
    const copy = structuredClone(input);
    const result = validateDocumentSchema({
      documentType: "Actor",
      subtype: "character",
      mode: "create",
      data: input,
      ...VERSION_LOCK,
    });
    const candidate = result.results[0]!;
    assert.equal(candidate.valid, false);
    assert.ok(candidate.errors.some(({ code, path }) => code === "REQUIRED" && path === "name"));
    assert.ok(
      candidate.errors.some(({ code, path }) => code === "INVALID_ENUM" && path === "type"),
    );
    assert.ok(candidate.warnings.some(({ path }) => path === "surprise"));
    assert.equal("surprise" in candidate.normalized, false);
    const normalizedSystem = candidate.normalized.system as { hp: { value: number } };
    assert.equal(normalizedSystem.hp.value, 10);
    assert.deepEqual(input, copy);
    assert.equal(candidate.inputUnchanged, true);
    assert.equal(result.persisted, false);
    assert.deepEqual(candidate.migrationWarnings, ["Synthetic hp migration warning"]);
    assert.equal(jointValidationCalls, 1);
    assert.ok(coreFieldValidationCalls > 0);
    assert.ok(coreJointValidationCalls > 0);
    assert.deepEqual(mutationCalls, []);
  });

  void it("continues native validation when Foundry freezes its compatibility warning hook", () => {
    setGlobal("foundry", {
      utils: Object.freeze({ logCompatibilityWarning: (_message: string) => undefined }),
    });
    const result = validateDocumentSchema({
      documentType: "Actor",
      subtype: "character",
      mode: "create",
      data: { name: "Frozen Hook", type: "character", system: { hp: { value: 8 } } },
      ...VERSION_LOCK,
    });
    assert.equal(result.results[0]?.valid, true);
    assert.ok(
      result.results[0]?.errors.every(
        ({ message }) => !message.includes("logCompatibilityWarning"),
      ),
    );
  });

  void it("does not require caller-forged Foundry document statistics on create", () => {
    const result = validateDocumentSchema({
      documentType: "RegionBehavior",
      parentDocumentType: "Region",
      parentDocumentId: "region-1",
      mode: "create",
      data: { name: "Pause", type: "threshold", system: { threshold: 2 } },
      ...VERSION_LOCK,
    });
    assert.equal(
      result.results[0]?.errors.some(({ path }) => path === "_stats" || path.startsWith("_stats.")),
      false,
    );
  });

  void it("does not require missing fields in update mode", () => {
    const result = validateDocumentSchema({
      documentType: "Actor",
      subtype: "character",
      mode: "update",
      data: { name: "Renamed", system: { hp: { value: 5 } } },
      ...VERSION_LOCK,
    });
    assert.equal(result.results[0]?.valid, true);
    assert.equal(updateSourceCalls, 1);
    assert.ok(result.results[0]?.limitations.some((value) => value.includes("partial")));
  });

  void it("runs joint validation for a complete update candidate", () => {
    const before = coreJointValidationCalls;
    const result = validateDocumentSchema({
      ...VERSION_LOCK,
      documentType: "Actor",
      subtype: "character",
      mode: "update",
      data: { name: "Complete", type: "character", system: { hp: { value: 7 } } },
    });
    assert.equal(result.results[0]?.valid, true);
    assert.deepEqual(result.results[0]?.limitations, []);
    assert.ok(coreJointValidationCalls > before);
  });

  void it("accepts a known-good same-version create candidate", () => {
    const result = validateDocumentSchema({
      documentType: "Actor",
      subtype: "character",
      mode: "create",
      data: { name: "Synthetic Hero", type: "character", system: { hp: { value: 8 } } },
      ...VERSION_LOCK,
    });
    assert.equal(result.results[0]?.valid, true);
    assert.deepEqual(result.results[0]?.errors, []);
    assert.deepEqual(mutationCalls, []);
    assert.ok(coreWorkflow.indexOf("migrate") < coreWorkflow.indexOf("clean"));
    assert.ok(coreWorkflow.indexOf("clean") < coreWorkflow.indexOf("field"));
    assert.ok(coreWorkflow.indexOf("field") < coreWorkflow.indexOf("joint"));
  });

  void it("validates batches independently and flattens native joint failure paths", () => {
    const result = validateDocumentSchema({
      ...VERSION_LOCK,
      documentType: "Actor",
      subtype: "character",
      mode: "create",
      candidates: [
        { name: "Good", type: "character", system: { hp: { value: 8 } } },
        { name: "Bad", type: "character", system: { hp: { value: 13 } } },
      ],
    });
    assert.equal(result.validCount, 1);
    assert.equal(result.invalidCount, 1);
    assert.deepEqual(
      result.results[1]?.errors.map(({ path }) => path),
      ["system.hp.value"],
    );
    assert.deepEqual(
      result.results.map(({ index }) => index),
      [0, 1],
    );
    assert.equal(jointValidationCalls, 2);
    assert.deepEqual(mutationCalls, []);
  });

  void it("preserves exact post-clean core and nested system failure paths", () => {
    const wall = validateDocumentSchema({
      ...VERSION_LOCK,
      documentType: "Wall",
      mode: "create",
      data: { c: "not-an-array" },
    });
    assert.ok(wall.results[0]?.errors.some(({ path }) => path === "c"));

    const actor = validateDocumentSchema({
      ...VERSION_LOCK,
      documentType: "Actor",
      subtype: "character",
      mode: "create",
      data: { name: "Bad HP", type: "character", system: { hp: { value: 13 } } },
    });
    assert.ok(actor.results[0]?.errors.some(({ path }) => path === "system.hp.value"));
  });

  void it("discovers and validates realistic v14-shaped representative document fixtures", () => {
    const fixtures: Record<string, Record<string, unknown>> = {
      Scene: { name: "Synthetic Scene" },
      JournalEntryPage: { name: "Synthetic Page", type: "text" },
      Token: { name: "Synthetic Token", x: "10", y: 20 },
      Wall: { c: [0, 0, 100, 100] },
      Region: { name: "Synthetic Region", shapes: [] },
      PlaylistSound: { name: "Synthetic Sound", path: "fixtures/sound.ogg" },
      TableResult: { text: "Synthetic Result", range: [1, 1] },
      Card: { name: "Synthetic Card" },
    };
    const before = [...game.collections.values()].map((collection) => ({
      size: collection.size,
      revisions: [...collection.values()].map((document) => document.toObject()["_stats"]),
    }));
    for (const [documentType, data] of Object.entries(fixtures)) {
      const result = discoverDocumentSchema({ ...VERSION_LOCK, documentType });
      assert.equal(result.context.documentType, documentType);
      assert.ok(result.fields.length > 0);
      const validation = validateDocumentSchema({
        ...VERSION_LOCK,
        documentType,
        mode: "create",
        data,
      });
      assert.equal(validation.results[0]?.valid, true, documentType);
    }
    const token = validateDocumentSchema({
      ...VERSION_LOCK,
      documentType: "Token",
      mode: "create",
      data: fixtures["Token"]!,
    });
    assert.equal(
      token.results[0]?.normalized["x"],
      10,
      "coercible numbers clean before validation",
    );
    const after = [...game.collections.values()].map((collection) => ({
      size: collection.size,
      revisions: [...collection.values()].map((document) => document.toObject()["_stats"]),
    }));
    assert.deepEqual(after, before);
    assert.deepEqual(mutationCalls, []);
  });

  void it("rejects unknown types, subtypes, parent relations, and unsupported Foundry versions", () => {
    assert.throws(
      () => discoverDocumentSchema({ ...VERSION_LOCK, documentType: "Bogus" }),
      (error: unknown) => error instanceof ProtocolError && error.code === "UNSUPPORTED_TYPE",
    );
    assert.throws(
      () => discoverDocumentSchema({ ...VERSION_LOCK, documentType: "Actor", subtype: "vehicle" }),
      (error: unknown) => error instanceof ProtocolError && error.fieldPath === "subtype",
    );
    assert.throws(
      () =>
        discoverDocumentSchema({
          ...VERSION_LOCK,
          documentType: "Actor",
          parentDocumentType: "Item",
        }),
      (error: unknown) => error instanceof ProtocolError && error.code === "UNSUPPORTED_TYPE",
    );
    setGlobal("game", {
      release: { version: "13.999" },
      system: { id: "dnd5e", version: "5" },
      modules: new Map(),
      user: { id: "gm", isGM: true },
      collections: new Map(),
    });
    assert.throws(
      () => discoverDocumentSchema({ ...VERSION_LOCK, documentType: "Actor" }),
      (error: unknown) => error instanceof ProtocolError && error.code === "UNSUPPORTED_VERSION",
    );
  });

  void it("fails on exact version mismatch and inaccessible parent references without exposing data", () => {
    assert.throws(
      () =>
        discoverDocumentSchema({
          ...VERSION_LOCK,
          expectedSystemVersion: "6.0.2",
          documentType: "Actor",
        }),
      (error: unknown) =>
        error instanceof ProtocolError && error.fieldPath === "expectedSystemVersion",
    );
    assert.throws(
      () =>
        discoverDocumentSchema({
          ...VERSION_LOCK,
          documentType: "Item",
          parentDocumentType: "Actor",
          parentDocumentId: "secret-or-missing",
        }),
      (error: unknown) => error instanceof ProtocolError && error.code === "NOT_FOUND",
    );

    allowParentAccess = false;
    (game.user as { isGM: boolean }).isGM = false;
    assert.throws(
      () =>
        discoverDocumentSchema({
          ...VERSION_LOCK,
          documentType: "RegionBehavior",
          parentDocumentType: "Region",
          parentDocumentId: "region-1",
        }),
      (error: unknown) =>
        error instanceof ProtocolError &&
        error.code === "NOT_FOUND" &&
        !error.message.includes("region-1"),
    );
  });
});
