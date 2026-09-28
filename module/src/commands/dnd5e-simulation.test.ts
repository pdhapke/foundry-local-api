import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Dnd5eSimulationInput } from "@foundry-local-api/shared";
import { simulateDnd5eAction } from "./dnd5e-simulation.js";

const saved = Object.getOwnPropertyDescriptor(globalThis, "game");
afterEach(() =>
  saved
    ? Object.defineProperty(globalThis, "game", saved)
    : Reflect.deleteProperty(globalThis, "game"),
);

function installWorld(options: { player?: boolean; changingFamily?: string } = {}) {
  const writes: string[] = [];
  let changingReads = 0;
  const changing = (family: string) =>
    options.changingFamily === family ? { marker: `read-${changingReads++}` } : {};
  const itemSource = {
    _id: "weapon",
    _stats: { modifiedTime: 12 },
    system: {
      ability: "str",
      activities: {
        strike: {
          type: "attack",
          attackBonus: 6,
          damage: { parts: [{ number: 1, denomination: 6, bonus: "@mod", types: ["slashing"] }] },
        },
      },
    },
  };
  const item = {
    id: "weapon",
    toObject: () => ({ ...structuredClone(itemSource), ...changing("item") }),
    testUserPermission: () => true,
    update: () => writes.push("item.update"),
  };
  const actorSource = {
    _id: "actor",
    _stats: { modifiedTime: 10 },
    system: {
      abilities: { str: { mod: 2 }, dex: { save: 4 } },
      skills: { ste: { total: 5 } },
      attributes: { hp: { value: 8, max: 20 }, ac: { value: 12 }, prof: 3 },
      resources: { primary: { value: 3 } },
      traits: {
        di: { value: [], custom: "" },
        dr: { value: [], custom: "" },
        dv: { value: [], custom: "" },
      },
    },
  };
  const targetSource = {
    _id: "target",
    _stats: { modifiedTime: 11 },
    system: {
      attributes: { hp: { value: 30, max: 30 }, ac: { value: 14 } },
      traits: {
        di: { value: [], custom: "" },
        dr: { value: [], custom: "" },
        dv: { value: [], custom: "" },
      },
    },
  };
  const effect = {
    id: "effect",
    toObject: () => ({ _id: "effect", disabled: true, ...changing("effect") }),
  };
  const actor = {
    id: "actor",
    items: new Map([[item.id, item]]),
    effects: new Map([[effect.id, effect]]),
    system: actorSource.system,
    toObject: () => ({ ...structuredClone(actorSource), ...changing("actor") }),
    testUserPermission: () => !options.player,
    update: () => writes.push("actor.update"),
  };
  const target = {
    id: "target",
    items: new Map(),
    effects: new Map(),
    system: targetSource.system,
    toObject: () => structuredClone(targetSource),
    testUserPermission: () => true,
    update: () => writes.push("target.update"),
  };
  const token = {
    id: "token",
    toObject: () => ({
      _id: "token",
      actorId: "actor",
      _stats: { modifiedTime: 13 },
      ...changing("token"),
    }),
    testUserPermission: () => true,
  };
  const scene = {
    id: "scene",
    toObject: () => ({ _id: "scene", _stats: { modifiedTime: 1 } }),
    getEmbeddedCollection: () => new Map([[token.id, token]]),
  };
  const combatSource = {
    _id: "combat",
    _stats: { modifiedTime: 14 },
    active: false,
    round: 0,
    turn: 0,
    combatants: [{ _id: "one" }, { _id: "two" }],
  };
  const combat = {
    id: "combat",
    toObject: () => ({ ...structuredClone(combatSource), ...changing("combat") }),
    testUserPermission: () => true,
    update: () => writes.push("combat.update"),
  };
  const chat = { id: "chat", toObject: () => ({ _id: "chat", ...changing("chat") }) };
  const collections = new Map<string, Map<string, unknown>>([
    [
      "Actor",
      new Map([
        [actor.id, actor],
        [target.id, target],
      ]),
    ],
    ["Scene", new Map([[scene.id, scene]])],
    ["Combat", new Map([[combat.id, combat]])],
    ["ChatMessage", new Map([[chat.id, chat]])],
  ]);
  Object.defineProperty(globalThis, "game", {
    configurable: true,
    value: {
      user: { id: options.player ? "player" : "gm", isGM: !options.player },
      system: { id: "dnd5e", version: "6.0.3" },
      collections,
    },
  });
  return { targetSource, writes };
}

function request(overrides: Partial<Dnd5eSimulationInput> = {}): Dnd5eSimulationInput {
  return {
    effectiveUserId: "gm",
    actorId: "actor",
    targetActorId: "target",
    sceneId: "scene",
    tokenId: "token",
    combatId: "combat",
    actions: [{ kind: "save", ability: "dex", dc: 10 }],
    noPersist: true,
    expectedRevisions: [
      { kind: "actor", id: "actor", revision: "10" },
      { kind: "target", id: "target", revision: "11" },
      { kind: "token", id: "token", revision: "13" },
      { kind: "combat", id: "combat", revision: "14" },
    ],
    expectedSystemVersion: "6.0.3",
    ...overrides,
  };
}

void describe("dnd5e no-persist simulation sequences", () => {
  void it("projects deterministic attack/save/damage/effect steps twice using virtual state", async () => {
    const world = installWorld();
    const input = request({
      actions: [
        { kind: "attack", itemId: "weapon" },
        { kind: "save", ability: "dex", dc: 12 },
        { kind: "damage", amount: 3, damageType: "slashing" },
        { kind: "effect", effectId: "effect", active: true, targetActorId: "actor" },
      ],
      suppliedRolls: [15, 5],
      expectedRevisions: [
        ...request().expectedRevisions,
        { kind: "item", id: "weapon", revision: "12" },
      ],
    });
    const first = await simulateDnd5eAction(input),
      second = await simulateDnd5eAction(input);
    assert.deepEqual(first, second);
    assert.deepEqual(
      first.steps.map((step) => step.status),
      ["projected", "projected", "projected", "projected"],
    );
    assert.equal(first.completedSteps, 4);
    assert.equal(first.stoppedAtStep, null);
    assert.deepEqual(
      first.projectedDiffs
        .filter((diff) => diff.path.endsWith("hp.value"))
        .map((diff) => diff.before),
      [30, 23],
    );
    assert.equal(first.beforeRevision, first.afterRevision);
    assert.deepEqual(world.writes, []);
    assert.equal(world.targetSource.system.attributes.hp.value, 30);
  });

  void it("carries resource, rest, and combat transitions through ordered virtual state", async () => {
    installWorld();
    const result = await simulateDnd5eAction(
      request({
        actions: [
          { kind: "resource", path: "system.resources.primary.value", delta: -2, min: 0 },
          { kind: "damage", amount: 5 },
          { kind: "rest", restType: "long" },
          { kind: "combat", transition: "start" },
          { kind: "combat", transition: "next-turn" },
          { kind: "combat", transition: "next-round" },
          { kind: "combat", transition: "end" },
        ],
      }),
    );
    assert.equal(result.completedSteps, 7);
    assert.deepEqual(
      result.projectedDiffs.filter(
        (diff) => diff.path === "actors.target.system.attributes.hp.value",
      ),
      [{ path: "actors.target.system.attributes.hp.value", before: 30, after: 25 }],
    );
    assert.ok(
      result.projectedDiffs.some(
        (diff) => diff.path === "actors.actor.system.attributes.hp.value" && diff.after === 20,
      ),
    );
    assert.ok(
      result.projectedDiffs.some(
        (diff) => diff.path === "combats.combat.round" && diff.after === 2,
      ),
    );
    assert.ok(
      result.projectedDiffs.some(
        (diff) => diff.path === "combats.combat.active" && diff.after === false,
      ),
    );
  });

  void it("rejects missing and stale revisions before projection", async () => {
    installWorld();
    await assert.rejects(
      simulateDnd5eAction(request({ expectedRevisions: [] })),
      (error: unknown) => (error as { code?: string }).code === "INVALID_PAYLOAD",
    );
    await assert.rejects(
      simulateDnd5eAction(
        request({
          expectedRevisions: request().expectedRevisions.map((entry) =>
            entry.kind === "actor" ? { ...entry, revision: "stale" } : entry,
          ),
        }),
      ),
      (error: unknown) => (error as { code?: string }).code === "STALE_REVISION",
    );
  });

  void it("stops by default and isolates failed branches when continuing", async () => {
    installWorld();
    const actions: NonNullable<Dnd5eSimulationInput["actions"]> = [
      { kind: "resource", path: "system.resources.primary.value", delta: -1 },
      { kind: "resource", path: "system.currency.gp", delta: 100 },
      { kind: "resource", path: "system.resources.primary.value", delta: -1 },
    ];
    const stopped = await simulateDnd5eAction(request({ actions }));
    assert.equal(stopped.completedSteps, 1);
    assert.equal(stopped.stoppedAtStep, 1);
    assert.deepEqual(
      stopped.steps.map((step) => step.status),
      ["projected", "failed"],
    );
    const continued = await simulateDnd5eAction(request({ actions, continueOnError: true }));
    assert.equal(continued.completedSteps, 2);
    assert.equal(continued.stoppedAtStep, null);
    assert.deepEqual(
      continued.steps.map((step) => step.status),
      ["projected", "failed", "projected"],
    );
    assert.deepEqual(
      continued.projectedDiffs
        .filter((diff) => diff.path.endsWith("primary.value"))
        .map((diff) => [diff.before, diff.after]),
      [
        [3, 2],
        [2, 1],
      ],
    );
  });

  void it("enforces permissions and cryptographically covers all protected families", async () => {
    installWorld({ player: true });
    await assert.rejects(
      simulateDnd5eAction(request()),
      (error: unknown) => (error as { code?: string }).code === "PERMISSION_DENIED",
    );
    for (const family of ["actor", "item", "effect", "token", "combat", "chat"] as const) {
      installWorld({ changingFamily: family });
      const input = request();
      if (family === "item") {
        delete input.actions;
        input.action = { kind: "attack", itemId: "weapon" };
        input.expectedRevisions.push({ kind: "item", id: "weapon", revision: "12" });
      }
      await assert.rejects(
        simulateDnd5eAction(input),
        (error: unknown) => (error as { code?: string }).code === "INCOMPLETE_RESULT",
        `${family} was not protected`,
      );
    }
  });
});
