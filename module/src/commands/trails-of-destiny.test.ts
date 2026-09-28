import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  TRAILS_COMMANDS,
  type TrailsActionRollInput,
  type TrailsActionRollResult,
  type TrailsActorInventoryResult,
  type TrailsActorSheetResult,
  type TrailsBuilderPreviewResult,
  type TrailsCatalogListResult,
  type TrailsCatalogResult,
  type TrailsConfigResult,
  type TrailsCreationReadinessResult,
  type TrailsDamagePreviewInput,
  type TrailsDamagePreviewResult,
  type TrailsExperienceProgressInput,
  type TrailsExperienceProgressResult,
  type TrailsInitiativeInput,
  type TrailsInitiativeResult,
  type TrailsRecoveryPreviewInput,
  type TrailsRecoveryPreviewResult,
  type TrailsThreatContestInput,
  type TrailsThreatContestResult,
} from "@foundry-local-api/shared";

import { dispatch } from "../command-registry.js";
import {
  TrailsCommandError,
  cloneAndRedactTrailsData,
  requireAccessibleTrailsPack,
  requireTrailsCapability,
  requireVisibleTrailsActor,
  toActionableTrailsError,
} from "./trails-of-destiny.js";

const savedConfig = Object.getOwnPropertyDescriptor(globalThis, "CONFIG");
const savedGame = Object.getOwnPropertyDescriptor(globalThis, "game");

function setGlobal(name: "CONFIG" | "game", value: unknown): void {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

function restoreGlobal(name: "CONFIG" | "game", descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}

function bridgeRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function forbiddenBuilderFunctions(calls: string[]): Record<string, (...args: unknown[]) => never> {
  return Object.fromEntries(
    [
      "prepareFoundryImport",
      "createFoundryActor",
      "reconcileGrantedConnections",
      "buildCreatePlan",
      "buildReconcilePlan",
      "executeBuilderRequest",
      "reconcileBuilderRequest",
      "createOwnedInstanceId",
      "defaultInstanceId",
    ].map((name) => [
      name,
      (..._args: unknown[]) => {
        calls.push(name);
        throw new Error(`Forbidden builder function called: ${name}`);
      },
    ]),
  );
}

afterEach(() => {
  restoreGlobal("CONFIG", savedConfig);
  restoreGlobal("game", savedGame);
});

void describe("Trails command foundations", () => {
  void it("imports without Foundry or Trails globals and reports an actionable missing capability", () => {
    Reflect.deleteProperty(globalThis, "CONFIG");
    Reflect.deleteProperty(globalThis, "game");

    assert.throws(
      () => requireTrailsCapability("creation", "evaluateCreation"),
      (error: unknown) => {
        assert.ok(error instanceof TrailsCommandError);
        assert.equal(error.code, "TRAILS_CAPABILITY_UNAVAILABLE");
        assert.match(error.message, /Activate trails-of-destiny 0\.1\.0 or newer/);
        return true;
      },
    );
  });

  void it("lazily resolves and binds a live capability", () => {
    setGlobal("CONFIG", {
      TRAILS: {
        gameplay: {
          prefix: "live",
          resolveActionRoll(this: { prefix: string }, suffix: string) {
            return `${this.prefix}-${suffix}`;
          },
        },
      },
    });

    const resolve = requireTrailsCapability<[string], string>("gameplay", "resolveActionRoll");
    assert.equal(resolve("roll"), "live-roll");
  });

  void it("allows GM and OBSERVER actors, but does not distinguish missing from forbidden actors", () => {
    const observerActor = {
      id: "observed",
      testUserPermission: (_user: unknown, level: string): boolean => level === "OBSERVER",
    };
    const hiddenActor = { id: "hidden", testUserPermission: () => false };
    const actors = new Map<string, object>([
      ["observed", observerActor],
      ["hidden", hiddenActor],
    ]);
    setGlobal("game", {
      user: { isGM: false },
      collections: new Map([["Actor", actors]]),
      packs: new Map(),
    });

    assert.equal(requireVisibleTrailsActor("observed").id, "observed");
    let hiddenMessage = "";
    let missingMessage = "";
    try {
      requireVisibleTrailsActor("hidden");
    } catch (error) {
      assert.ok(error instanceof TrailsCommandError);
      hiddenMessage = error.message;
    }
    try {
      requireVisibleTrailsActor("missing");
    } catch (error) {
      assert.ok(error instanceof TrailsCommandError);
      missingMessage = error.message;
    }
    assert.equal(hiddenMessage, missingMessage);
    assert.doesNotMatch(hiddenMessage, /hidden|missing/);

    setGlobal("game", {
      user: { isGM: true },
      collections: new Map([["Actor", new Map([["hidden", hiddenActor]])]]),
      packs: new Map(),
    });
    assert.equal(requireVisibleTrailsActor("hidden").id, "hidden");
  });

  void it("allows only visible allowlisted Trails packs without exposing why lookup failed", () => {
    const visiblePack = {
      visible: true,
      metadata: { id: "trails-of-destiny.social" },
    };
    const hiddenPack = {
      visible: false,
      metadata: { id: "trails-of-destiny.character-options" },
    };
    setGlobal("game", {
      user: { isGM: false },
      collections: new Map(),
      packs: new Map([
        ["trails-of-destiny.social", visiblePack],
        ["trails-of-destiny.character-options", hiddenPack],
        ["world.private", { visible: true, metadata: { id: "world.private" } }],
      ]),
    });

    assert.equal(
      requireAccessibleTrailsPack("trails-of-destiny.social").metadata.id,
      "trails-of-destiny.social",
    );
    const messages = [
      "trails-of-destiny.character-options",
      "trails-of-destiny.unknown",
      "world.private",
    ].map((packId) => {
      try {
        requireAccessibleTrailsPack(packId);
        assert.fail("lookup should have failed");
      } catch (error) {
        assert.ok(error instanceof TrailsCommandError);
        return error.message;
      }
    });
    assert.equal(new Set(messages).size, 1);
    assert.doesNotMatch(messages[0] ?? "", /private|character-options|unknown/);
  });

  void it("enforces explicit observer, owner, GM, and unauthorized actor bridge access", async () => {
    const user = { access: "observer", isGM: false };
    const actor = {
      id: "permission-actor",
      type: "character",
      system: {},
      items: new Map(),
      testUserPermission: (candidate: { access: string }, level: string) =>
        level === "OBSERVER" && (candidate.access === "observer" || candidate.access === "owner"),
    };
    setGlobal("CONFIG", { TRAILS: { rulesVersion: "rules-security", gameplay: {} } });
    setGlobal("game", {
      system: { version: "0.1.0" },
      user,
      collections: new Map([["Actor", new Map([[actor.id, actor]])]]),
      packs: new Map(),
    });

    for (const access of ["observer", "owner"]) {
      user.access = access;
      const response = await dispatch({
        id: `actor-${access}`,
        type: TRAILS_COMMANDS.ACTOR_INVENTORY,
        payload: { id: actor.id },
      });
      assert.equal(response.ok, true, `${access} should cross the bridge`);
    }

    user.access = "unauthorized";
    const denied = await dispatch({
      id: "actor-unauthorized",
      type: TRAILS_COMMANDS.ACTOR_INVENTORY,
      payload: { id: actor.id },
    });
    assert.equal(denied.ok, false);
    assert.doesNotMatch(JSON.stringify(denied), /permission-actor/);

    user.isGM = true;
    const gm = await dispatch({
      id: "actor-gm",
      type: TRAILS_COMMANDS.ACTOR_INVENTORY,
      payload: { id: actor.id },
    });
    assert.equal(gm.ok, true, "GM access should not depend on document permission callbacks");
  });

  void it("enforces explicit observer, owner, GM, and unauthorized catalog bridge access", async () => {
    const user = { access: "observer", isGM: false };
    const packId = "trails-of-destiny.character-options";
    const pack = {
      testUserPermission: (candidate: { access: string }, level: string) =>
        level === "OBSERVER" && (candidate.access === "observer" || candidate.access === "owner"),
    };
    setGlobal("CONFIG", {
      TRAILS: {
        rulesVersion: "rules-security",
        gameplay: {},
        creation: {
          loadRuntimeCatalogContext: () => ({
            catalogs: { talents: [{ catalogId: "public-entry", name: "Public Entry" }] },
          }),
        },
      },
    });
    setGlobal("game", {
      system: { version: "0.1.0" },
      user,
      collections: new Map(),
      packs: new Map([[packId, pack]]),
    });

    for (const access of ["observer", "owner"]) {
      user.access = access;
      const response = await dispatch({
        id: `pack-${access}`,
        type: TRAILS_COMMANDS.GET_CATALOG,
        payload: { packId },
      });
      assert.equal(response.ok, true, `${access} should cross the bridge`);
    }

    user.access = "unauthorized";
    const denied = await dispatch({
      id: "pack-unauthorized",
      type: TRAILS_COMMANDS.GET_CATALOG,
      payload: { packId },
    });
    assert.equal(denied.ok, false);
    assert.doesNotMatch(JSON.stringify(denied), /character-options/);

    user.isGM = true;
    const gm = await dispatch({
      id: "pack-gm",
      type: TRAILS_COMMANDS.GET_CATALOG,
      payload: { packId },
    });
    assert.equal(gm.ok, true, "GM access should not depend on pack permission callbacks");
  });

  void it("deep-clones allowed data while stripping every sensitive evidence field", () => {
    const source = {
      name: "Estelle",
      system: {
        details: { concept: "Bracer", biography: "private", campaign_notes: "private" },
        creation: {
          sourceSnapshot: "raw builder JSON",
          rawSnapshot: "raw runtime snapshot",
          abilityRolls: [8, 8, 8],
          issuedSelections: [{ ruling: "secret ruling" }],
          safeIdentity: "history-id",
        },
        adjudications: [{ note: "GM-only" }],
      },
      flags: { safe: true, secrets: { answer: 42 } },
      html: '<section class="secret">hidden prose</section>',
      nested: [{ public: "kept", selectionEvidence: { die: 8 } }],
    };

    const result = cloneAndRedactTrailsData(source);

    assert.notEqual(result, source);
    assert.deepEqual(result, {
      name: "Estelle",
      system: {
        details: { concept: "Bracer" },
        creation: { safeIdentity: "history-id" },
      },
      flags: { safe: true },
      html: "[REDACTED]",
      nested: [{ public: "kept" }],
    });
  });

  void it("rejects cyclic/unsupported response data and suppresses arbitrary runtime errors", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    assert.throws(
      () => cloneAndRedactTrailsData(cyclic),
      (error: unknown) =>
        error instanceof TrailsCommandError && error.code === "TRAILS_RESPONSE_UNSAFE",
    );

    const converted = toActionableTrailsError(
      new Error("sourceSnapshot contained private-world-data"),
      "preview creation readiness",
    );
    assert.equal(converted.code, "TRAILS_RUNTIME_ERROR");
    assert.match(converted.message, /could not preview creation readiness/);
    assert.doesNotMatch(converted.message, /private-world-data|sourceSnapshot/);
    assert.equal(toActionableTrailsError(converted, "anything"), converted);
  });

  void it("reports live config values, distinct versions, and exact capability flags", async () => {
    setGlobal("CONFIG", {
      TRAILS: {
        abilities: { str: "TRAILS.Ability.Strength", spd: "TRAILS.Ability.Speed" },
        itemTypes: { talent: "TRAILS.ItemType.Talent" },
        RULES_VERSION: "rules-2",
        creation: { evaluateCreation() {}, loadRuntimeCatalogContext() {} },
        gameplay: {
          GAMEPLAY_RULES_VERSION: "gameplay-3",
          DAMAGE_TYPES: [
            { id: "fire", label: "Fire", secret: "not public" },
            { id: "cold", label: "Cold" },
          ],
          DIE_RANKS: [4, 6, 8, 10, 12, 20],
          THREAT_CLASSIFICATIONS: {
            attack: {
              id: "attack",
              defense: "guard",
              reaction: "defense",
              reactionResource: "vigor",
              source: { chapter: 3, printedPages: [18, 19], section: "Attack" },
            },
            assault: {
              id: "assault",
              defense: "ward",
              reaction: "resistance",
              reactionResource: "mana",
              source: { chapter: 3, printedPage: 20 },
            },
          },
          resolveActionRoll() {},
          previewInitiative() {},
          previewThreatContest() {},
          previewPostMitigationDamage() {},
          buildRecoveryPlan() {},
          experienceProgress() {},
        },
        builder: {
          parseBuilderV1() {},
          validateBuilderV1() {},
          previewBuilderV1() {},
        },
      },
    });
    setGlobal("game", {
      system: { version: "0.1.9" },
      i18n: { localize: (key: string) => `localized:${key}` },
    });

    const response = await dispatch({ id: "config", type: TRAILS_COMMANDS.CONFIG });
    assert.equal(response.ok, true);
    const result = (response as { result: TrailsConfigResult }).result;
    assert.deepEqual(result.versions, {
      packageVersion: "0.1.9",
      rulesVersion: "rules-2",
      gameplayRulesVersion: "gameplay-3",
    });
    assert.deepEqual(result.abilities, [
      { id: "str", label: "localized:TRAILS.Ability.Strength" },
      { id: "spd", label: "localized:TRAILS.Ability.Speed" },
    ]);
    assert.deepEqual(result.damageTypes, [
      { id: "fire", label: "Fire" },
      { id: "cold", label: "Cold" },
    ]);
    assert.deepEqual(result.dieRanks, [4, 6, 8, 10, 12, 20]);
    assert.equal(result.threatClassifications[0]?.source.section, "Attack");
    assert.deepEqual(result.capabilities, {
      evaluateCreation: true,
      runtimeCatalogs: true,
      resolveActionRoll: true,
      previewInitiative: true,
      previewThreatContest: true,
      previewPostMitigationDamage: true,
      buildRecoveryPlan: true,
      experienceProgress: true,
      parseBuilderV1: true,
      validateBuilderV1: true,
      previewBuilderV1: true,
    });
  });

  void it("returns exact prepared character values and redacted readiness without persisting", async () => {
    let updates = 0;
    const actor = {
      id: "estelle",
      name: "Estelle",
      type: "character",
      testUserPermission: (_user: unknown, level: string) => level === "OBSERVER",
      update: () => {
        updates += 1;
      },
      system: {
        schemaVersion: 4,
        rulesVersion: "actor-rules-1",
        details: {
          level: 7,
          concept: "Bracer",
          history: "history-bracer",
          destiny: "destiny-hope",
          elementalAffinity: "fire",
          martialAffinity: "blade",
          nativeLanguage: "Liberlian",
          languages: ["Crossbellan"],
          biography: "private biography",
          campaignNotes: "private campaign notes",
        },
        creation: {
          sourceSnapshot: "private JSON",
          abilityRolls: [8, 8, 8],
          issuedSelections: [{ ruling: "private" }],
        },
        abilities: {
          str: { value: 10, bonus: 2, total: 17, bonusDice: 1 },
          spd: { value: 11, bonus: 0, total: 14, bonusDice: 0 },
        },
        resources: {
          durability: { value: 12, max: 31 },
          health: { value: 20, max: 25 },
          vigor: { value: 18, max: 35 },
          mana: { value: 16, max: 33 },
          energy: { value: 120, max: 170 },
        },
        defenses: { guard: 19, ward: 18, armor: 3 },
        actions: 3,
        reputation: 14,
        movement: { combat: 15, overland: 350 },
        carryingCapacity: 170,
        currency: { mira: 9000, equipmentAllowance: 500 },
        readiness: {
          ready: false,
          issues: [
            {
              code: "language-review",
              message: "Review language selection.",
              path: "details.languages",
              severity: "review",
              lane: "identity",
              source: { chapter: 1, section: "Languages", secret: "private" },
              sourceSnapshot: "private",
            },
          ],
          blockingIssues: [
            {
              code: "language-review",
              message: "Review language selection.",
              severity: "review",
            },
          ],
          retained: [{ path: "legacy.safe", reason: "Unknown field", value: { kept: true } }],
          counts: { error: 0, review: 1, manual: 0, reference: 0, retained: 1 },
          secrets: { answer: 42 },
        },
        adjudications: [{ note: "private GM note" }],
      },
    };
    setGlobal("CONFIG", {
      TRAILS: {
        abilities: { str: "Strength", spd: "Speed" },
        rulesVersion: "config-rules-2",
        gameplay: { GAMEPLAY_RULES_VERSION: "gameplay-3" },
      },
    });
    setGlobal("game", {
      system: { version: "0.1.9" },
      user: { isGM: false },
      i18n: { localize: (key: string) => key },
      collections: new Map([["Actor", new Map([["estelle", actor]])]]),
      packs: new Map(),
    });

    const response = await dispatch({
      id: "sheet",
      type: TRAILS_COMMANDS.ACTOR_SHEET,
      payload: { id: "estelle" },
    });
    assert.equal(response.ok, true);
    const result = (response as { result: TrailsActorSheetResult }).result;
    assert.equal(result.type, "character");
    assert.equal(result.abilities[0]?.total, 17, "uses prepared total, not value + bonus");
    assert.equal(result.resources[0]?.max, 31, "uses prepared maximum");
    assert.deepEqual(result.versions, {
      packageVersion: "0.1.9",
      rulesVersion: "config-rules-2",
      gameplayRulesVersion: "gameplay-3",
    });
    assert.equal(result.actorRulesVersion, "actor-rules-1");
    assert.equal(result.readiness.issues[0]?.source?.section, "Languages");
    assert.deepEqual(result.readiness.retained, [
      { path: "legacy.safe", reason: "Unknown field", value: { kept: true } },
    ]);
    assert.equal(updates, 0);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(
      serialized,
      /private biography|private campaign|private JSON|private GM|sourceSnapshot|abilityRolls|issuedSelections|secrets/,
    );
  });

  void it("supports sparse npc fixtures and marks missing readiness evidence for review", async () => {
    const actor = {
      id: "npc-1",
      name: "Jaeger",
      type: "npc",
      visible: true,
      system: { schemaVersion: 1, rulesVersion: "0.1", details: {}, abilities: {} },
    };
    setGlobal("CONFIG", { TRAILS: { abilities: {}, gameplay: {} } });
    setGlobal("game", {
      system: { version: "0.1.0" },
      user: { isGM: false },
      collections: new Map([["Actor", new Map([["npc-1", actor]])]]),
      packs: new Map(),
    });

    const response = await dispatch({
      id: "npc-sheet",
      type: TRAILS_COMMANDS.ACTOR_SHEET,
      payload: { id: "npc-1" },
    });
    assert.equal(response.ok, true);
    const result = (response as { result: TrailsActorSheetResult }).result;
    assert.equal(result.type, "npc");
    assert.deepEqual(result.languages, []);
    assert.deepEqual(
      result.resources.map(({ value, max }) => ({ value, max })),
      [
        { value: 0, max: 0 },
        { value: 0, max: 0 },
        { value: 0, max: 0 },
        { value: 0, max: 0 },
        { value: 0, max: 0 },
      ],
    );
    assert.equal(result.readiness.ready, false);
    assert.equal(result.readiness.issues[0]?.code, "prepared-readiness-unavailable");
    assert.equal(result.readiness.counts.review, 1);
  });

  void it("keeps duplicate owned catalog records separate with all identity and type boundaries", async () => {
    const shared = {
      catalogId: "novice-runic",
      schemaVersion: 1,
      status: "interpretation",
      provenance: "builder-v1:talents",
      source: { chapter: 9, printedPage: 156, section: "Runic", entry: "Novice Runic" },
    };
    const item = (id: string, instanceId: string, choice: string, purchaseOrder: number) => ({
      id,
      name: "Novice Runic",
      type: "talent",
      system: {
        ...shared,
        instanceId,
        origin: {
          kind: "builder-v1",
          sourceCatalogId: "novice-runic",
          sourceInstanceId: `source-${id}`,
          sourceUuid: `Compendium.local.${id}`,
          grantId: "",
          slotId: `talents[${purchaseOrder}]`,
        },
        category: "occult",
        rank: 1,
        skillPointCost: 1,
        choice,
        rolls: [4, 6],
        active: true,
        purchaseOrder,
      },
    });
    let updates = 0;
    const actor = {
      id: "duplicate-owner",
      type: "character",
      visible: true,
      system: { rulesVersion: "actor-rules" },
      items: new Map([
        ["owned-a", item("owned-a", "instance-a", "heat", 0)],
        ["owned-b", item("owned-b", "instance-b", "cold", 1)],
      ]),
      update: () => {
        updates += 1;
      },
    };
    setGlobal("CONFIG", {
      TRAILS: { rulesVersion: "rules-1", gameplay: { GAMEPLAY_RULES_VERSION: "gameplay-1" } },
    });
    setGlobal("game", {
      system: { version: "0.1.9" },
      user: { isGM: false },
      collections: new Map([["Actor", new Map([[actor.id, actor]])]]),
      packs: new Map(),
    });

    const response = await dispatch({
      id: "inventory",
      type: TRAILS_COMMANDS.ACTOR_INVENTORY,
      payload: { id: actor.id },
    });
    assert.equal(response.ok, true);
    const result = (response as { result: TrailsActorInventoryResult }).result;
    assert.equal(result.items.length, 2);
    assert.deepEqual(
      result.items.map(({ _id, catalogId, instanceId }) => ({ _id, catalogId, instanceId })),
      [
        { _id: "owned-a", catalogId: "novice-runic", instanceId: "instance-a" },
        { _id: "owned-b", catalogId: "novice-runic", instanceId: "instance-b" },
      ],
    );
    const first = result.items[0];
    assert.equal(first?.status, "interpretation");
    assert.equal(first?.source.section, "Runic");
    assert.equal(first?.origin.slotId, "talents[0]");
    assert.equal(first?.type, "talent");
    if (first?.type === "talent") {
      assert.deepEqual(first.details, {
        category: "occult",
        rank: 1,
        skillPointCost: 1,
        choice: "heat",
        rolls: [4, 6],
        active: true,
        purchaseOrder: 0,
      });
    }
    assert.equal(updates, 0);

    const bridged = bridgeRoundTrip(result);
    assert.deepEqual(
      bridged.items.map(({ _id, catalogId, instanceId }) => ({ _id, catalogId, instanceId })),
      [
        { _id: "owned-a", catalogId: "novice-runic", instanceId: "instance-a" },
        { _id: "owned-b", catalogId: "novice-runic", instanceId: "instance-b" },
      ],
      "bridge serialization must not coalesce owned copies with the same catalog id",
    );
    assert.deepEqual(bridged.versions, {
      packageVersion: "0.1.9",
      rulesVersion: "rules-1",
      gameplayRulesVersion: "gameplay-1",
    });
    assert.match(bridged.boundary, /duplicate catalog IDs are retained/i);
  });

  void it("projects every owned Item subtype without flattening subtype fields", async () => {
    const owned = (id: string, type: string, system: Record<string, unknown>): [string, object] => [
      id,
      {
        id,
        name: id,
        type,
        system: {
          schemaVersion: 1,
          catalogId: `catalog-${id}`,
          instanceId: `instance-${id}`,
          status: "reference",
          provenance: "catalog",
          source: {},
          origin: {},
          ...system,
        },
      },
    ];
    const actor = {
      id: "subtypes",
      type: "character",
      visible: true,
      system: {},
      items: new Map([
        owned("connection", "connection", {
          connectionType: "Contact",
          category: "Civic",
          quality: "Heroic",
          rank: 2,
          identity: "Cassius",
          active: true,
        }),
        owned("craft", "craft", {
          entitlementId: "entitlement",
          baseId: "fire-bolt",
          school: "Fire",
          affinityKind: "elemental",
          rank: "Adept",
          craftType: "Damage",
          resource: "mana",
          cost: 4,
          range: "Near",
          duration: "Instant",
          modifierId: "wide",
          modifierChoice: "cone",
          form: "art",
        }),
        owned("equipment", "equipment", {
          category: "Weapon",
          quality: "Rare",
          quantity: 2,
          price: 500,
          equipped: true,
          attuned: true,
          hands: 2,
          armor: 1,
          acquisition: "grant",
          grantingSource: "package-a",
        }),
        owned("quartz", "quartz", {
          element: "fire",
          rank: 3,
          socket: 2,
          equipped: true,
          arts: ["flare"],
          acquisition: "purchase",
        }),
        owned("core", "core", {
          coreType: "Jewel",
          element: "space",
          rank: 4,
          socket: 1,
          equipped: true,
          arts: ["forte"],
          acquisition: "grant",
        }),
      ]),
    };
    setGlobal("CONFIG", { TRAILS: { gameplay: {} } });
    setGlobal("game", {
      system: { version: "0.1.9" },
      user: { isGM: false },
      collections: new Map([["Actor", new Map([[actor.id, actor]])]]),
      packs: new Map(),
    });

    const response = await dispatch({
      id: "subtype-inventory",
      type: TRAILS_COMMANDS.ACTOR_INVENTORY,
      payload: { id: actor.id },
    });
    assert.equal(response.ok, true);
    const result = (response as { result: TrailsActorInventoryResult }).result;
    assert.deepEqual(
      result.items.map((entry) => [entry.type, entry.details]),
      [
        [
          "connection",
          {
            connectionType: "Contact",
            category: "Civic",
            quality: "Heroic",
            rank: 2,
            identity: "Cassius",
            active: true,
          },
        ],
        [
          "craft",
          {
            entitlementId: "entitlement",
            baseId: "fire-bolt",
            school: "Fire",
            affinityKind: "elemental",
            rank: "Adept",
            craftType: "Damage",
            resource: "mana",
            cost: 4,
            range: "Near",
            duration: "Instant",
            modifierId: "wide",
            modifierChoice: "cone",
            form: "art",
          },
        ],
        [
          "equipment",
          {
            category: "Weapon",
            quality: "Rare",
            quantity: 2,
            price: 500,
            equipped: true,
            attuned: true,
            hands: 2,
            armor: 1,
            acquisition: "grant",
            grantingSource: "package-a",
          },
        ],
        [
          "quartz",
          {
            element: "fire",
            rank: 3,
            socket: 2,
            equipped: true,
            arts: ["flare"],
            acquisition: "purchase",
          },
        ],
        [
          "core",
          {
            coreType: "Jewel",
            element: "space",
            rank: 4,
            socket: 1,
            equipped: true,
            arts: ["forte"],
            acquisition: "grant",
          },
        ],
      ],
    );
  });

  void it("lists only declared catalogs with access-aware safe counts", async () => {
    setGlobal("CONFIG", { TRAILS: { rulesVersion: "rules-1", gameplay: {} } });
    setGlobal("game", {
      system: { version: "0.1.9" },
      user: { isGM: false },
      collections: new Map(),
      packs: new Map([
        [
          "trails-of-destiny.character-options",
          {
            visible: true,
            getIndex: async () =>
              new Map([
                ["a", {}],
                ["b", {}],
              ]),
          },
        ],
        ["trails-of-destiny.social", { visible: false, getIndex: async () => assert.fail() }],
        ["world.private", { visible: true, getIndex: async () => new Map([["secret", {}]]) }],
      ]),
    });

    const response = await dispatch({ id: "catalogs", type: TRAILS_COMMANDS.LIST_CATALOGS });
    assert.equal(response.ok, true);
    const result = (response as { result: TrailsCatalogListResult }).result;
    assert.deepEqual(
      result.catalogs.map(({ packId, accessible, entryCount }) => ({
        packId,
        accessible,
        entryCount,
      })),
      [
        {
          packId: "trails-of-destiny.character-options",
          accessible: true,
          entryCount: 2,
        },
        { packId: "trails-of-destiny.social", accessible: false, entryCount: null },
        { packId: "trails-of-destiny.crafts-arts", accessible: false, entryCount: null },
        { packId: "trails-of-destiny.equipment-orbment", accessible: false, entryCount: null },
      ],
    );
  });

  void it("loads one accessible allowlisted catalog lazily and returns sanitized canonical data", async () => {
    let loads = 0;
    let receivedPacks: Map<string, unknown> | undefined;
    const pack = { visible: true, getIndex: async () => new Map() };
    setGlobal("CONFIG", {
      TRAILS: {
        rulesVersion: "rules-1",
        gameplay: { GAMEPLAY_RULES_VERSION: "gameplay-1" },
        creation: {
          async loadRuntimeCatalogContext({ packs }: { packs: Map<string, unknown> }) {
            loads += 1;
            receivedPacks = packs;
            return {
              catalogs: {
                talents: [
                  {
                    id: "acclimation",
                    catalogId: "acclimation",
                    name: "Acclimation",
                    category: "general",
                    status: "implemented",
                    source: { chapter: 9, printedPage: 159, section: "Acclimation" },
                    description: "Public rule text",
                    sourceSnapshot: "private builder evidence",
                    uuid: "Compendium.nonportable.Item.locator",
                  },
                ],
                coreSkills: [{ id: "duplicate-runtime-alias" }],
              },
              uuidMap: { "talents:acclimation": "Compendium.nonportable.Item.locator" },
            };
          },
        },
      },
    });
    setGlobal("game", {
      system: { version: "0.1.9" },
      user: { isGM: false },
      collections: new Map(),
      packs: new Map([["trails-of-destiny.character-options", pack]]),
    });
    assert.equal(loads, 0, "catalog API is not called during module/config setup");

    const response = await dispatch({
      id: "catalog",
      type: TRAILS_COMMANDS.GET_CATALOG,
      payload: { packId: "trails-of-destiny.character-options" },
    });
    assert.equal(response.ok, true);
    assert.equal(loads, 1);
    assert.deepEqual([...receivedPacks!.keys()], ["trails-of-destiny.character-options"]);
    const result = (response as { result: TrailsCatalogResult }).result;
    assert.equal(result.entries.length, 1, "coreSkills runtime alias is not duplicated");
    assert.deepEqual(result.entries[0], {
      catalogId: "acclimation",
      name: "Acclimation",
      catalog: "talents",
      itemType: "talent",
      status: "implemented",
      source: { chapter: 9, printedPage: 159, section: "Acclimation" },
      data: { category: "general", description: "Public rule text" },
    });
    assert.doesNotMatch(JSON.stringify(result), /sourceSnapshot|private builder|uuid|Compendium/);

    const denied = await dispatch({
      id: "denied-catalog",
      type: TRAILS_COMMANDS.GET_CATALOG,
      payload: { packId: "world.private" },
    });
    assert.equal(denied.ok, false);
    assert.equal(loads, 1, "disallowed packs fail before invoking the runtime catalog API");
  });

  void it("evaluates creation from visible redacted snapshots and preserves result evidence", async () => {
    let received: Record<string, unknown> | undefined;
    const updateCalls: unknown[] = [];
    const itemUpdateCalls: unknown[] = [];
    const item = {
      id: "owned-1",
      name: "Visible Talent",
      type: "talent",
      system: {
        catalogId: "talent-a",
        instanceId: "instance-a",
        status: "interpretation",
        source: { chapter: 9, printedPage: 120, section: "Talent A" },
        selectionEvidence: { secretChoice: true },
      },
      update: (...args: unknown[]) => itemUpdateCalls.push(args),
    };
    const actor = {
      id: "actor-creation",
      name: "Visible Hero",
      type: "character",
      system: {
        rulesVersion: "rules-actor",
        details: { concept: "Investigator", biography: "private biography" },
        creation: {
          generationMethod: "array",
          sourceSnapshot: '{"campaignNotes":"private builder notes"}',
          abilityRolls: [{ ability: "STR", dice: [20, 19] }],
          issuedSelections: [{ connectionId: "private-selection" }],
        },
        adjudications: [{ reason: "private ruling" }],
      },
      items: new Map([[item.id, item]]),
      testUserPermission: (_user: unknown, level: string) => level === "OBSERVER",
      update: (...args: unknown[]) => updateCalls.push(args),
    };
    const visiblePack = { visible: true };
    const hiddenPack = { visible: false };
    setGlobal("CONFIG", {
      TRAILS: {
        RULES_VERSION: "rules-config",
        gameplay: { GAMEPLAY_RULES_VERSION: "gameplay-2" },
        creation: {
          loadRuntimeCatalogContext: ({ packs }: { packs: Map<string, unknown> }) => {
            assert.deepEqual([...packs.keys()], ["trails-of-destiny.character-options"]);
            return {
              catalogs: {
                talents: [
                  {
                    id: "talent-a",
                    status: "reference",
                    source: { chapter: 9, printedPage: 120 },
                    builderEvidence: "private catalog evidence",
                  },
                ],
              },
            };
          },
          evaluateCreation(input: Record<string, unknown>) {
            received = input;
            return {
              identity: {
                status: "implemented",
                issues: [
                  {
                    code: "identity-reference",
                    path: "actor.system.details.history",
                    message: "Retained identity reference.",
                    severity: "reference",
                    source: { chapter: 6, printedPage: 52, section: "History" },
                  },
                ],
                boundary: "Identity remains a readiness finding only.",
                selected: { id: "history-a", status: "reference" },
              },
              training: {
                status: "interpretation",
                issues: [],
                purchases: [{ id: "talent-a", source: { chapter: 9, printedPage: 120 } }],
              },
              loadout: {
                status: "reference",
                issues: [
                  {
                    code: "manual-loadout",
                    message: "Check this selection manually.",
                    severity: "manual",
                  },
                ],
                manualBoundary: "No equipment is granted or equipped.",
                rawSnapshot: "private raw lane snapshot",
              },
              orbment: { status: "unresolved", issues: [], placements: [] },
              readiness: {
                ready: false,
                issues: [
                  {
                    code: "manual-loadout",
                    message: "Check this selection manually.",
                    severity: "manual",
                    lane: "loadout",
                  },
                ],
                blockingIssues: [],
                retained: [
                  { path: "builder.extra", reason: "Unknown builder extension", value: { x: 1 } },
                ],
                counts: { error: 0, review: 0, manual: 1, reference: 0, retained: 1 },
              },
              sourceInstances: ["internal-only"],
              entitlements: [{ id: "internal-only" }],
            };
          },
        },
      },
    });
    setGlobal("game", {
      system: { version: "0.1.9" },
      user: { isGM: false },
      collections: new Map([["Actor", new Map([[actor.id, actor]])]]),
      packs: new Map([
        ["trails-of-destiny.character-options", visiblePack],
        ["trails-of-destiny.social", hiddenPack],
      ]),
    });

    const response = await dispatch({
      id: "creation",
      type: TRAILS_COMMANDS.EVALUATE_CREATION,
      payload: { id: actor.id },
    });
    assert.equal(response.ok, true);
    assert.ok(received);
    assert.deepEqual(Object.keys(received).sort(), ["actor", "catalogs", "items"]);
    const serializedInput = JSON.stringify(received);
    assert.match(serializedInput, /Visible Hero|Visible Talent|talent-a/);
    assert.doesNotMatch(
      serializedInput,
      /sourceSnapshot|campaignNotes|biography|adjudications|abilityRolls|issuedSelections|selectionEvidence|builderEvidence|private/i,
    );

    const result = (response as { result: TrailsCreationReadinessResult }).result;
    assert.deepEqual(result.versions, {
      packageVersion: "0.1.9",
      rulesVersion: "rules-config",
      gameplayRulesVersion: "gameplay-2",
    });
    assert.equal(result.actorId, actor.id);
    assert.deepEqual(result.lanes[0], {
      id: "identity",
      status: "implemented",
      issues: [
        {
          code: "identity-reference",
          path: "actor.system.details.history",
          message: "Retained identity reference.",
          severity: "reference",
          source: { chapter: 6, printedPage: 52, section: "History" },
        },
      ],
      findings: { selected: { id: "history-a", status: "reference" } },
      boundary: "Identity remains a readiness finding only.",
    });
    const loadoutLane = result.lanes[2];
    assert.ok(loadoutLane);
    assert.equal(
      loadoutLane.findings["manualBoundary"] as string,
      "No equipment is granted or equipped.",
    );
    assert.deepEqual(result.unmapped, [
      { path: "builder.extra", reason: "Unknown builder extension", value: { x: 1 } },
    ]);
    assert.deepEqual(result.readiness.counts, {
      error: 0,
      review: 0,
      manual: 1,
      reference: 0,
      retained: 1,
    });
    assert.match(result.boundary, /no Actor.*owned Item.*changed/i);
    assert.doesNotMatch(JSON.stringify(result), /internal-only/);

    const bridged = bridgeRoundTrip(result);
    assert.deepEqual(bridged.versions, {
      packageVersion: "0.1.9",
      rulesVersion: "rules-config",
      gameplayRulesVersion: "gameplay-2",
    });
    assert.equal(bridged.lanes[0]?.issues[0]?.severity, "reference");
    assert.equal(bridged.lanes[0]?.issues[0]?.source?.section, "History");
    assert.equal(
      bridged.lanes[2]?.findings["manualBoundary"],
      "No equipment is granted or equipped.",
    );
    assert.match(bridged.boundary, /no Actor.*owned Item.*changed/i);
    assert.doesNotMatch(
      JSON.stringify(bridged),
      /sourceSnapshot|rawSnapshot|private raw lane snapshot|internal-only/i,
    );
    assert.deepEqual(updateCalls, []);
    assert.deepEqual(itemUpdateCalls, []);
  });

  void it("fails closed before evaluation for a hidden actor", async () => {
    let evaluations = 0;
    setGlobal("CONFIG", {
      TRAILS: {
        creation: {
          loadRuntimeCatalogContext: () => ({ catalogs: {} }),
          evaluateCreation: () => {
            evaluations += 1;
            return {};
          },
        },
      },
    });
    setGlobal("game", {
      user: { isGM: false },
      collections: new Map([
        [
          "Actor",
          new Map([
            [
              "hidden-creation",
              {
                id: "hidden-creation",
                system: {},
                items: new Map(),
                testUserPermission: () => false,
              },
            ],
          ]),
        ],
      ]),
      packs: new Map(),
    });

    const response = await dispatch({
      id: "hidden-creation",
      type: TRAILS_COMMANDS.EVALUATE_CREATION,
      payload: { id: "hidden-creation" },
    });
    assert.equal(response.ok, false);
    assert.equal(evaluations, 0);
    assert.doesNotMatch(
      (response as { error: { message: string } }).error.message,
      /hidden-creation/,
    );
  });
});

void describe("Trails action roll and initiative preview commands", () => {
  void it("uses runtime-owned RNG for action rolls and preserves all roll evidence", async () => {
    const updateCalls: unknown[] = [];
    const chatCalls: unknown[] = [];
    const input: TrailsActionRollInput = {
      kind: "skill",
      abilityId: "agility",
      skillId: "acrobatics",
      abilityDice: 2,
      skillDice: 1,
      otherDice: 1,
      abilityChallenges: 1,
      challenges: 2,
      chances: 1,
      charges: 3,
      vs: 42,
      conditionalDice: [
        {
          id: "talent-a",
          label: "Talent A",
          selected: true,
          dice: 2,
          source: { chapter: 1, printedPage: 9 },
        },
      ],
    };
    const runtimeResult = {
      contractVersion: 1,
      kind: "skill",
      abilityId: "agility",
      skillId: "acrobatics",
      dice: {
        ability: 2,
        skill: 1,
        conditional: 2,
        other: 1,
        total: 6,
        conditions: input.conditionalDice,
      },
      modifiers: {
        abilityChallenges: 1,
        challenges: 3,
        charges: 4,
        chances: 1,
        rank: {
          baseSides: 10,
          sides: 12,
          challenges: 3,
          charges: 4,
          cancelled: 3,
          remainingChallenges: 0,
          remainingCharges: 1,
        },
      },
      vs: { base: 42, adjusted: 57, success: true, tie: false, rule: "meet-or-exceed" },
      action: { sides: 20, value: 19, natural20: false, bursts: 0 },
      bonus: {
        count: 6,
        sides: 12,
        chains: [[12, 4], [8], [6], [5], [3], [2]],
        values: [16, 8, 6, 5, 3, 2],
        bursts: 1,
        total: 40,
      },
      total: 59,
      source: { chapter: 1, printedPages: [8, 9, 17], sections: ["Action Rolls"] },
      boundary:
        "Pure roll result only; no resource, Destined state, gameplay effect, timer, combat order, or chat message was changed.",
    };
    let received: unknown;
    setGlobal("CONFIG", {
      TRAILS: {
        RULES_VERSION: "rules-7",
        gameplay: {
          GAMEPLAY_RULES_VERSION: "gameplay-4",
          resolveActionRoll(value: unknown, options?: unknown) {
            assert.equal(arguments.length, 1);
            assert.equal(options, undefined);
            received = value;
            return runtimeResult;
          },
        },
      },
    });
    setGlobal("game", {
      system: { version: "0.1.9" },
      collections: new Map([
        ["Actor", { update: (...args: unknown[]) => updateCalls.push(args) }],
        ["Combat", { update: (...args: unknown[]) => updateCalls.push(args) }],
        ["ChatMessage", { create: (...args: unknown[]) => chatCalls.push(args) }],
      ]),
    });

    const response = await dispatch({
      id: "roll-action",
      type: TRAILS_COMMANDS.ROLL_ACTION,
      payload: input,
    });

    assert.equal(response.ok, true);
    assert.equal(received, input);
    const result = (response as { result: TrailsActionRollResult }).result;
    assert.deepEqual(result, {
      ...runtimeResult,
      versions: {
        packageVersion: "0.1.9",
        rulesVersion: "rules-7",
        gameplayRulesVersion: "gameplay-4",
      },
    });
    assert.deepEqual(updateCalls, []);
    assert.deepEqual(chatCalls, []);
  });

  void it("passes only participants to runtime initiative and preserves ties and boundaries", async () => {
    const mutationCalls: unknown[] = [];
    const input: TrailsInitiativeInput = {
      participants: [
        {
          id: "a",
          label: "A",
          bonusDice: 1,
          challenges: 0,
          charges: 0,
          chances: 0,
          sources: [{ chapter: 3, printedPage: 18 }],
        },
        {
          id: "b",
          bonusDice: 1,
          challenges: 1,
          charges: 1,
          sources: [],
        },
      ],
    };
    const participantResult = (id: string, inputIndex: number) => ({
      id,
      label: id.toUpperCase(),
      inputIndex,
      action: { sides: 20, value: 12, natural20: false, bursts: 0 },
      bonus: { count: 1, sides: 10, chains: [[8]], values: [8], bursts: 0, total: 8 },
      rank: {
        baseSides: 10,
        sides: 10,
        challenges: inputIndex,
        charges: inputIndex,
        cancelled: inputIndex,
        remainingChallenges: 0,
        remainingCharges: 0,
      },
      total: 20,
      sources: input.participants[inputIndex]?.sources ?? [],
    });
    const runtimeResult = {
      contractVersion: 1,
      source: { chapter: 3, printedPage: 18, section: "Initiative" },
      groups: [
        {
          total: 20,
          tied: true,
          requiresManualOrder: true,
          participants: [participantResult("a", 0), participantResult("b", 1)],
        },
      ],
      complete: false,
      boundary:
        "Initiative preview only; tied groups require recorded GM ordering and no Combat or round state was changed.",
    };
    let received: unknown;
    setGlobal("CONFIG", {
      TRAILS: {
        rulesVersion: "rules-8",
        gameplay: {
          GAMEPLAY_RULES_VERSION: "gameplay-5",
          previewInitiative(value: unknown, options?: unknown) {
            assert.equal(arguments.length, 1);
            assert.equal(options, undefined);
            received = value;
            return runtimeResult;
          },
        },
      },
    });
    setGlobal("game", {
      system: { version: "0.1.10" },
      collections: new Map([
        ["Actor", { update: (...args: unknown[]) => mutationCalls.push(args) }],
        ["Combat", { update: (...args: unknown[]) => mutationCalls.push(args) }],
        ["ChatMessage", { create: (...args: unknown[]) => mutationCalls.push(args) }],
      ]),
    });

    const response = await dispatch({
      id: "initiative",
      type: TRAILS_COMMANDS.PREVIEW_INITIATIVE,
      payload: input,
    });

    assert.equal(response.ok, true);
    assert.equal(received, input.participants);
    const result = (response as { result: TrailsInitiativeResult }).result;
    assert.deepEqual(result, {
      ...runtimeResult,
      versions: {
        packageVersion: "0.1.10",
        rulesVersion: "rules-8",
        gameplayRulesVersion: "gameplay-5",
      },
    });
    assert.equal(result.groups[0]?.tied, true);
    assert.equal(result.groups[0]?.requiresManualOrder, true);
    assert.equal(result.complete, false);
    assert.deepEqual(mutationCalls, []);
  });
});

void describe("Trails threat and damage preview commands", () => {
  void it("passes an attack contest to the live runtime and preserves classification semantics", async () => {
    const mutationCalls: unknown[] = [];
    const input: TrailsThreatContestInput = {
      classification: "attack",
      actionTotal: 32,
      passiveDefense: 18,
      reactionTotal: 32,
    };
    const runtimeResult = {
      contractVersion: 1,
      classification: {
        id: "attack",
        defense: "guard",
        reaction: "defense",
        reactionResource: "vigor",
        source: {
          chapter: 3,
          printedPages: [18, 19, 20],
          section: "Attack vs. Assault; Guard and Ward",
        },
      },
      actionTotal: 32,
      passiveDefense: 18,
      reactionTotal: 32,
      opposed: true,
      tie: true,
      hit: true,
      rule: "reaction-must-strictly-exceed; ties-favor-initiator",
      boundary:
        "Contest preview only; no reaction resource, target eligibility, action, damage, condition, or Actor state was changed.",
    };
    let received: unknown;
    setGlobal("CONFIG", {
      TRAILS: {
        RULES_VERSION: "rules-9",
        gameplay: {
          GAMEPLAY_RULES_VERSION: "gameplay-6",
          previewThreatContest(value: unknown) {
            assert.equal(arguments.length, 1);
            received = value;
            return runtimeResult;
          },
        },
      },
    });
    setGlobal("game", {
      system: { version: "0.1.11" },
      collections: new Map([
        ["Actor", { update: (...args: unknown[]) => mutationCalls.push(args) }],
        ["Combat", { update: (...args: unknown[]) => mutationCalls.push(args) }],
        ["ChatMessage", { create: (...args: unknown[]) => mutationCalls.push(args) }],
      ]),
    });

    const response = await dispatch({
      id: "threat-contest",
      type: TRAILS_COMMANDS.PREVIEW_THREAT_CONTEST,
      payload: input,
    });

    assert.equal(response.ok, true);
    assert.equal(received, input);
    const result = (response as { result: TrailsThreatContestResult }).result;
    assert.deepEqual(result, {
      ...runtimeResult,
      versions: {
        packageVersion: "0.1.11",
        rulesVersion: "rules-9",
        gameplayRulesVersion: "gameplay-6",
      },
    });
    assert.equal(result.classification.id, "attack");
    assert.equal(result.classification.defense, "guard");
    assert.equal(result.classification.reactionResource, "vigor");
    assert.equal(result.tie, true);
    assert.equal(result.hit, true);
    assert.deepEqual(mutationCalls, []);
  });

  void it("preserves post-mitigation shock, death, manual review, and no-application boundaries", async () => {
    const inputs: TrailsDamagePreviewInput[] = [
      { durability: 0, health: 0, damage: 2 },
      { durability: 0, health: 0, damage: 1, lifeState: "shock" },
      { durability: 0, health: 2, damage: 2 },
    ];
    const runtimeResults = [
      {
        contractVersion: 1,
        before: { durability: 0, health: 0, lifeState: "active" },
        after: { durability: 0, health: 0, lifeState: "active" },
        damage: 2,
        durabilityDamage: 0,
        healthDamage: 0,
        wounded: true,
        shock: false,
        dead: false,
        transition: "manual-review",
        issues: [
          {
            code: "zero-health-state-review",
            severity: "review",
            message: "A legacy active record at 0 Health needs its shock/death state adjudicated.",
          },
        ],
        source: {
          chapter: 3,
          printedPages: [26, 28],
          sections: ["Health and Durability", "Death"],
        },
        boundary:
          "Preview withheld; a legacy active record at 0 Health must be adjudicated before later damage can resolve.",
      },
      {
        contractVersion: 1,
        before: { durability: 0, health: 0, lifeState: "shock" },
        after: { durability: 0, health: 0, lifeState: "dead" },
        damage: 1,
        durabilityDamage: 0,
        healthDamage: 1,
        wounded: true,
        shock: false,
        dead: true,
        issues: [],
        source: {
          chapter: 3,
          printedPages: [26, 28],
          sections: ["Health and Durability", "Death"],
        },
        boundary:
          "Preview only; death timers, stabilization, Actor state, conditions, and chat remain manual.",
      },
      {
        contractVersion: 1,
        before: { durability: 0, health: 2, lifeState: "active" },
        after: { durability: 0, health: 0, lifeState: "shock" },
        damage: 2,
        durabilityDamage: 0,
        healthDamage: 2,
        wounded: true,
        shock: true,
        dead: false,
        issues: [],
        source: {
          chapter: 3,
          printedPages: [26, 28],
          sections: ["Health and Durability", "Death"],
        },
        boundary:
          "Preview only; Armor is already adjudicated and no Actor, equipment, condition, timer, or chat message was changed.",
      },
    ];
    const received: unknown[] = [];
    const mutationCalls: unknown[] = [];
    setGlobal("CONFIG", {
      TRAILS: {
        rulesVersion: "rules-10",
        gameplay: {
          GAMEPLAY_RULES_VERSION: "gameplay-7",
          previewPostMitigationDamage(value: unknown) {
            received.push(value);
            return runtimeResults[received.length - 1];
          },
        },
      },
    });
    setGlobal("game", {
      system: { version: "0.1.12" },
      collections: new Map([
        ["Actor", { update: (...args: unknown[]) => mutationCalls.push(args) }],
        ["ChatMessage", { create: (...args: unknown[]) => mutationCalls.push(args) }],
      ]),
    });

    const results: TrailsDamagePreviewResult[] = [];
    for (const [index, input] of inputs.entries()) {
      const response = await dispatch({
        id: `damage-${index}`,
        type: TRAILS_COMMANDS.PREVIEW_DAMAGE,
        payload: input,
      });
      assert.equal(response.ok, true);
      results.push((response as { result: TrailsDamagePreviewResult }).result);
    }

    assert.deepEqual(received, inputs);
    assert.deepEqual(results[0], {
      ...runtimeResults[0],
      versions: {
        packageVersion: "0.1.12",
        rulesVersion: "rules-10",
        gameplayRulesVersion: "gameplay-7",
      },
    });
    assert.equal(results[0]?.transition, "manual-review");
    assert.equal(results[0]?.issues[0]?.code, "zero-health-state-review");
    assert.equal(results[1]?.after.lifeState, "dead");
    assert.equal(results[1]?.dead, true);
    assert.equal(results[1]?.transition, null);
    assert.match(results[1]?.boundary ?? "", /Actor state.*remain manual/i);
    assert.equal(results[2]?.after.lifeState, "shock");
    assert.equal(results[2]?.shock, true);
    assert.equal(results[2]?.transition, null);
    assert.deepEqual(mutationCalls, []);
  });
});

void describe("Trails recovery and experience preview commands", () => {
  void it("preserves explicit recovery evidence, unverified claims, and the manual boundary without applying operations", async () => {
    const input: TrailsRecoveryPreviewInput = {
      kind: "sleep",
      resources: {
        durability: { value: 4, max: 34 },
        health: { value: 12, max: 25 },
        vigor: { value: 7, max: 35 },
        mana: { value: 9, max: 39 },
        energy: { value: 80, max: 150 },
      },
      stamina: 15,
      staminaBonusDice: 1,
      soulBonusDice: 2,
      staminaDice: [8],
      soulDice: [4, 10],
      eligibility: {
        durability: true,
        health: true,
        vigor: false,
        mana: true,
        energy: false,
      },
    };
    const runtimeResult = {
      ok: true,
      kind: "sleep",
      source: { chapter: 2, printedPage: 14, pdfPage: 15, section: "Rest and Recovery" },
      inputs: {
        stamina: 15,
        staminaBonusDice: 1,
        soulBonusDice: 2,
        staminaDice: [8],
        soulDice: [4, 10],
        eligibility: input.eligibility,
      },
      operations: [
        {
          resource: "vigor",
          before: 7,
          max: 35,
          requested: 35,
          recovered: 0,
          after: 7,
          eligible: false,
          reason: "Recovery eligibility was denied by the caller; no change is planned.",
        },
      ],
      claims: [{ id: "sleep-benefits", cadence: "once-per-day", verified: false }],
      manualBoundary:
        "A future authoritative transaction must validate and consume every unverified daily claim before applying this plan.",
    };
    let received: unknown;
    const mutationCalls: unknown[] = [];
    setGlobal("CONFIG", {
      TRAILS: {
        RULES_VERSION: "rules-11",
        gameplay: {
          GAMEPLAY_RULES_VERSION: "gameplay-8",
          buildRecoveryPlan(value: unknown) {
            assert.equal(arguments.length, 1);
            received = value;
            return runtimeResult;
          },
        },
      },
    });
    setGlobal("game", {
      system: { version: "0.1.13" },
      collections: new Map([
        ["Actor", { update: (...args: unknown[]) => mutationCalls.push(args) }],
        ["ChatMessage", { create: (...args: unknown[]) => mutationCalls.push(args) }],
      ]),
    });

    const response = await dispatch({
      id: "recovery",
      type: TRAILS_COMMANDS.PREVIEW_RECOVERY,
      payload: input,
    });

    assert.equal(response.ok, true);
    assert.equal(received, input);
    const result = (response as { result: TrailsRecoveryPreviewResult }).result;
    assert.deepEqual(result, {
      ...runtimeResult,
      versions: {
        packageVersion: "0.1.13",
        rulesVersion: "rules-11",
        gameplayRulesVersion: "gameplay-8",
      },
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.inputs.eligibility, input.eligibility);
      assert.deepEqual(result.inputs.staminaDice, [8]);
      assert.deepEqual(result.inputs.soulDice, [4, 10]);
      assert.deepEqual(result.claims, [
        { id: "sleep-benefits", cadence: "once-per-day", verified: false },
      ]);
      assert.match(result.manualBoundary, /before applying this plan/i);
    }
    assert.deepEqual(mutationCalls, []);
  });

  void it("preserves bounded-dice and explicit-eligibility recovery failures from the live kernel", async () => {
    const inputs = [
      {
        kind: "sleep",
        resources: {
          durability: { value: 1, max: 2 },
          health: { value: 1, max: 2 },
          vigor: { value: 1, max: 2 },
          mana: { value: 1, max: 2 },
          energy: { value: 1, max: 2 },
        },
        staminaBonusDice: 1,
        soulBonusDice: 2,
        staminaDice: [8],
        soulDice: [4],
        eligibility: {
          durability: true,
          health: true,
          vigor: true,
          mana: true,
          energy: true,
        },
      },
      {
        kind: "break",
        resources: {
          durability: { value: 1, max: 2 },
          health: { value: 1, max: 2 },
          vigor: { value: 1, max: 2 },
          mana: { value: 1, max: 2 },
          energy: { value: 1, max: 2 },
        },
        eligibility: { durability: true, health: true },
      },
    ] as unknown as TrailsRecoveryPreviewInput[];
    const runtimeResults = [
      {
        ok: false,
        source: { chapter: 2, printedPage: 14 },
        issues: [
          {
            code: "recovery-roll-evidence",
            path: "soulDice",
            message: "soulDice must contain exactly 2 recorded d10 results.",
            severity: "error",
          },
        ],
      },
      {
        ok: false,
        source: { chapter: 2, printedPage: 14 },
        issues: [
          {
            code: "recovery-eligibility",
            path: "eligibility",
            message: "Explicit eligibility is required for every resource.",
            severity: "error",
          },
        ],
      },
    ];
    const received: unknown[] = [];
    setGlobal("CONFIG", {
      TRAILS: {
        gameplay: {
          buildRecoveryPlan(value: unknown) {
            received.push(value);
            return runtimeResults[received.length - 1];
          },
        },
      },
    });
    setGlobal("game", { system: { version: "0.1.13" }, collections: new Map() });

    for (const [index, input] of inputs.entries()) {
      const response = await dispatch({
        id: `recovery-failure-${index}`,
        type: TRAILS_COMMANDS.PREVIEW_RECOVERY,
        payload: input,
      });
      assert.equal(response.ok, true);
      const result = (response as { result: TrailsRecoveryPreviewResult }).result;
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.issues[0]?.code, runtimeResults[index]?.issues[0]?.code);
    }
    assert.deepEqual(received, inputs);
  });

  void it("rejects invalid EXP through the live rules and preserves published-table exhaustion without extrapolation", async () => {
    const mutationCalls: unknown[] = [];
    const inputs: TrailsExperienceProgressInput[] = [
      { totalExperience: -1 },
      { totalExperience: 1.5 },
      { totalExperience: 999_999 },
    ];
    const runtimeResults = [
      {
        ok: false,
        issues: [
          {
            code: "experience-total",
            path: "totalExperience",
            message: "Experience must be a nonnegative integer.",
            severity: "error",
          },
        ],
      },
      {
        ok: false,
        issues: [
          {
            code: "experience-total",
            path: "totalExperience",
            message: "Experience must be a nonnegative integer.",
            severity: "error",
          },
        ],
      },
      {
        ok: true,
        source: {
          chapter: 14,
          printedPage: 337,
          pdfPage: 338,
          section: "Experience and Levels",
        },
        totalExperience: 999_999,
        level: 50,
        currentThreshold: 306_250,
        nextThreshold: null,
        earnedIntoLevel: 693_749,
        requiredForNext: null,
        remaining: null,
        publishedTableExhausted: true,
      },
    ];
    const received: unknown[] = [];
    setGlobal("CONFIG", {
      TRAILS: {
        rulesVersion: "rules-12",
        gameplay: {
          GAMEPLAY_RULES_VERSION: "gameplay-9",
          experienceProgress(totalExperience: unknown) {
            assert.equal(arguments.length, 1);
            received.push(totalExperience);
            return runtimeResults[received.length - 1];
          },
        },
      },
    });
    setGlobal("game", {
      system: { version: "0.1.14" },
      collections: new Map([
        ["Actor", { update: (...args: unknown[]) => mutationCalls.push(args) }],
        ["Combat", { update: (...args: unknown[]) => mutationCalls.push(args) }],
        ["ChatMessage", { create: (...args: unknown[]) => mutationCalls.push(args) }],
      ]),
    });

    const results: TrailsExperienceProgressResult[] = [];
    for (const [index, input] of inputs.entries()) {
      const response = await dispatch({
        id: `experience-${index}`,
        type: TRAILS_COMMANDS.EXPERIENCE_PROGRESS,
        payload: input,
      });
      assert.equal(response.ok, true);
      results.push((response as { result: TrailsExperienceProgressResult }).result);
    }

    assert.deepEqual(received, [-1, 1.5, 999_999]);
    assert.equal(results[0]?.ok, false);
    assert.equal(results[1]?.ok, false);
    assert.deepEqual(results[2], {
      ...runtimeResults[2],
      versions: {
        packageVersion: "0.1.14",
        rulesVersion: "rules-12",
        gameplayRulesVersion: "gameplay-9",
      },
    });
    if (results[2]?.ok) {
      assert.equal(results[2].level, 50);
      assert.equal(results[2].nextThreshold, null);
      assert.equal(results[2].requiredForNext, null);
      assert.equal(results[2].remaining, null);
      assert.equal(results[2].publishedTableExhausted, true);
    }
    assert.deepEqual(mutationCalls, []);
  });
});

void describe("Trails builder preview", () => {
  void it("runs the live creation parse/validate/preview pipeline with only visible runtime catalogs and no writes", async () => {
    const calls: string[] = [];
    const mutationCalls: unknown[] = [];
    const draft = { version: 1, name: "Estelle" };
    const catalogs = {
      talents: [{ id: "talent-bracer", name: "Bracer Training" }],
      items: [],
    };
    const visiblePack = { visible: true };
    const hiddenPack = { visible: false };

    setGlobal("CONFIG", {
      TRAILS: {
        rulesVersion: "rules-1",
        creation: {
          async loadRuntimeCatalogContext({ packs }: { packs: Map<string, unknown> }) {
            calls.push(`catalogs:${[...packs.keys()].join(",")}`);
            return { catalogs };
          },
          parseBuilderV1(raw: unknown) {
            calls.push("parse");
            assert.equal(raw, '{"version":1,"name":"Estelle"}');
            return draft;
          },
          validateBuilderV1(value: unknown) {
            calls.push("validate");
            assert.equal(value, draft);
            return [
              {
                code: "manual-review",
                path: "destinyChoice",
                message: "Review the retained destiny choice.",
                severity: "review",
              },
            ];
          },
          previewBuilderV1(value: unknown, receivedCatalogs: unknown) {
            calls.push("preview");
            assert.equal(value, draft);
            assert.equal(receivedCatalogs, catalogs);
            return {
              contractVersion: 1,
              builderVersion: 1,
              actor: {
                name: "Estelle",
                type: "character",
                system: {
                  schemaVersion: 1,
                  rulesVersion: "0.1",
                  details: {
                    concept: "Bracer",
                    history: "history-bracer",
                    destiny: "destiny-hope",
                    elementalAffinity: "wind",
                    martialAffinity: "staff",
                    nativeLanguage: "Zemurian",
                    languages: ["Zemurian"],
                    biography: "private biography",
                    campaignNotes: "private campaign notes",
                  },
                  abilities: { str: { value: 8 }, spd: { value: 11 } },
                },
              },
              items: [
                {
                  name: "Bracer Training",
                  type: "talent",
                  system: {
                    schemaVersion: 1,
                    catalogId: "talent-bracer",
                    status: "reference",
                    source: { chapter: 1, printedPage: 12 },
                    instanceId: "must-not-cross-preview-boundary",
                    origin: { sourceUuid: "Compendium.private" },
                    category: "general",
                    choice: "fieldwork",
                  },
                },
              ],
              sourceDraft: { campaignNotes: "private source snapshot" },
              issues: [],
              unmapped: [
                {
                  path: "method",
                  reason: "Ability generation evidence has no Actor field.",
                  value: "array",
                },
              ],
            };
          },
          createFoundryActor: (...args: unknown[]) => mutationCalls.push(args),
          executeBuilderRequest: (...args: unknown[]) => mutationCalls.push(args),
          reconcileBuilderRequest: (...args: unknown[]) => mutationCalls.push(args),
        },
      },
    });
    setGlobal("game", {
      user: { isGM: false },
      system: { version: "0.1.0" },
      packs: new Map([
        ["trails-of-destiny.character-options", visiblePack],
        ["trails-of-destiny.social", hiddenPack],
      ]),
      collections: new Map([
        ["Actor", { create: (...args: unknown[]) => mutationCalls.push(args) }],
        ["Item", { create: (...args: unknown[]) => mutationCalls.push(args) }],
      ]),
    });

    const response = await dispatch({
      id: "builder-preview",
      type: TRAILS_COMMANDS.PREVIEW_BUILDER,
      payload: { raw: '{"version":1,"name":"Estelle"}' },
    });

    assert.equal(response.ok, true);
    const result = (response as { result: TrailsBuilderPreviewResult }).result;
    assert.deepEqual(calls, [
      "catalogs:trails-of-destiny.character-options",
      "parse",
      "validate",
      "preview",
    ]);
    assert.equal(result.valid, true);
    assert.deepEqual(result.actor?.abilities, { str: 8, spd: 11 });
    assert.equal(result.issues[0]?.code, "manual-review");
    assert.equal(result.unmapped[0]?.path, "method");
    assert.deepEqual(result.items[0], {
      name: "Bracer Training",
      type: "talent",
      catalogId: "talent-bracer",
      status: "reference",
      source: { chapter: 1, printedPage: 12 },
      fields: { category: "general", choice: "fieldwork" },
    });
    assert.match(result.boundary, /no Actor or Item was created/i);
    assert.doesNotMatch(
      JSON.stringify(result),
      /sourceDraft|private biography|private campaign|instanceId|sourceUuid|Compendium/,
    );
    assert.deepEqual(mutationCalls, []);
  });

  void it("accepts an issue-free near-2 MB preview without treating success as persistence authorization", async () => {
    const raw = "x".repeat(1_999_900);
    const draft = { version: 1, marker: "near-limit" };
    const forbiddenCalls: string[] = [];
    const documentMutationCalls: string[] = [];
    const forbidden = forbiddenBuilderFunctions(forbiddenCalls);

    setGlobal("CONFIG", {
      TRAILS: {
        rulesVersion: "rules-near-limit",
        creation: {
          ...forbidden,
          async loadRuntimeCatalogContext() {
            return { catalogs: {} };
          },
          parseBuilderV1(received: unknown) {
            assert.equal(received, raw);
            return draft;
          },
          validateBuilderV1(received: unknown) {
            assert.equal(received, draft);
            return [];
          },
          previewBuilderV1(received: unknown, catalogs: unknown) {
            assert.equal(received, draft);
            assert.deepEqual(catalogs, {});
            return {
              contractVersion: 1,
              builderVersion: 1,
              actor: {
                name: "Near Limit",
                type: "character",
                system: {
                  schemaVersion: 1,
                  rulesVersion: "rules-near-limit",
                  details: {},
                  abilities: {},
                },
              },
              items: [],
              issues: [],
              unmapped: [],
            };
          },
        },
        builder: forbidden,
      },
    });
    setGlobal("game", {
      user: { isGM: true },
      system: { version: "0.1.0" },
      packs: new Map(),
      collections: new Map([
        [
          "Actor",
          {
            create: () => documentMutationCalls.push("Actor.create"),
            update: () => documentMutationCalls.push("Actor.update"),
            delete: () => documentMutationCalls.push("Actor.delete"),
          },
        ],
        [
          "Item",
          {
            create: () => documentMutationCalls.push("Item.create"),
            update: () => documentMutationCalls.push("Item.update"),
            delete: () => documentMutationCalls.push("Item.delete"),
          },
        ],
        ["ChatMessage", { create: () => documentMutationCalls.push("ChatMessage.create") }],
      ]),
    });

    const response = await dispatch({
      id: "builder-near-limit",
      type: TRAILS_COMMANDS.PREVIEW_BUILDER,
      payload: { raw },
    });

    assert.equal(response.ok, true);
    const result = (response as { result: TrailsBuilderPreviewResult }).result;
    assert.equal(result.valid, true);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.unmapped, []);
    assert.match(result.boundary, /preview only/i);
    assert.match(result.boundary, /no request was executed or reconciled/i);
    assert.match(result.boundary, /no identity was generated/i);
    assert.match(result.boundary, /no Foundry document or catalog was changed/i);
    assert.deepEqual(forbiddenCalls, []);
    assert.deepEqual(documentMutationCalls, []);
  });

  void it("preserves validation failures and unmapped evidence without invoking write or identity APIs", async () => {
    const forbiddenCalls: string[] = [];
    const documentMutationCalls: string[] = [];
    const forbidden = forbiddenBuilderFunctions(forbiddenCalls);
    const validationIssue = {
      code: "missing-history",
      path: "historyId",
      message: "A history selection is required.",
      severity: "error",
    } as const;

    setGlobal("CONFIG", {
      TRAILS: {
        creation: {
          ...forbidden,
          async loadRuntimeCatalogContext() {
            return { catalogs: {} };
          },
          parseBuilderV1() {
            return { version: 1, name: "Incomplete" };
          },
          validateBuilderV1() {
            return [validationIssue];
          },
          previewBuilderV1() {
            return {
              contractVersion: 1,
              builderVersion: 1,
              actor: {
                name: "Incomplete",
                type: "character",
                system: { schemaVersion: 1, rulesVersion: "rules-1", details: {}, abilities: {} },
              },
              items: [],
              issues: [
                {
                  code: "manual-choice",
                  path: "destinyId",
                  message: "Retain this choice for manual review.",
                  severity: "manual",
                },
              ],
              unmapped: [
                {
                  path: "legacy.customField",
                  reason: "No canonical builder field exists.",
                  value: { retained: true },
                },
              ],
            };
          },
        },
        builder: forbidden,
      },
    });
    setGlobal("game", {
      user: { isGM: true },
      system: { version: "0.1.0" },
      packs: new Map(),
      collections: new Map([
        ["Actor", { create: () => documentMutationCalls.push("Actor.create") }],
        ["Item", { create: () => documentMutationCalls.push("Item.create") }],
      ]),
    });

    const response = await dispatch({
      id: "builder-invalid-unmapped",
      type: TRAILS_COMMANDS.PREVIEW_BUILDER,
      payload: { raw: '{"version":1,"name":"Incomplete"}' },
    });

    assert.equal(response.ok, true);
    const result = (response as { result: TrailsBuilderPreviewResult }).result;
    assert.equal(result.valid, false);
    assert.deepEqual(
      result.issues.map(({ code, severity }) => ({ code, severity })),
      [
        { code: "missing-history", severity: "error" },
        { code: "manual-choice", severity: "manual" },
      ],
    );
    assert.deepEqual(result.unmapped, [
      {
        path: "legacy.customField",
        reason: "No canonical builder field exists.",
        value: { retained: true },
      },
    ]);
    assert.deepEqual(forbiddenCalls, []);
    assert.deepEqual(documentMutationCalls, []);
  });

  void it("returns stable issues and unmapped arrays for malformed raw JSON", async () => {
    let validateCalls = 0;
    const forbiddenCalls: string[] = [];
    const forbidden = forbiddenBuilderFunctions(forbiddenCalls);
    setGlobal("CONFIG", {
      TRAILS: {
        creation: {
          ...forbidden,
          async loadRuntimeCatalogContext() {
            return { catalogs: {} };
          },
          parseBuilderV1() {
            throw new Error("Character file is not valid JSON.");
          },
          validateBuilderV1() {
            validateCalls += 1;
            return [];
          },
          previewBuilderV1(raw: unknown) {
            assert.equal(raw, "{not-json");
            return {
              contractVersion: 1,
              builderVersion: 1,
              actor: null,
              items: [],
              issues: [
                {
                  code: "invalid-json",
                  path: "$",
                  message: "Character file is not valid JSON.",
                  severity: "error",
                },
              ],
            };
          },
        },
        builder: forbidden,
      },
    });
    setGlobal("game", {
      user: { isGM: true },
      system: { version: "0.1.0" },
      packs: new Map(),
      collections: new Map(),
    });

    const response = await dispatch({
      id: "builder-malformed",
      type: TRAILS_COMMANDS.PREVIEW_BUILDER,
      payload: { raw: "{not-json" },
    });
    assert.equal(response.ok, true);
    const result = (response as { result: TrailsBuilderPreviewResult }).result;
    assert.equal(result.valid, false);
    assert.equal(result.issues[0]?.code, "invalid-json");
    assert.match(result.issues[0]?.message ?? "", /not valid JSON/i);
    assert.deepEqual(result.unmapped, []);
    assert.equal(validateCalls, 0);
    assert.deepEqual(forbiddenCalls, []);
  });
});

void describe("Trails domain preview failure boundaries", () => {
  void it("turns every runtime capability failure into an operation-specific actionable error", async () => {
    const cases = [
      {
        command: TRAILS_COMMANDS.ROLL_ACTION,
        capability: "resolveActionRoll",
        action: "resolve an action roll",
        payload: {},
      },
      {
        command: TRAILS_COMMANDS.PREVIEW_INITIATIVE,
        capability: "previewInitiative",
        action: "preview initiative",
        payload: { participants: [] },
      },
      {
        command: TRAILS_COMMANDS.PREVIEW_THREAT_CONTEST,
        capability: "previewThreatContest",
        action: "preview a threat contest",
        payload: {},
      },
      {
        command: TRAILS_COMMANDS.PREVIEW_DAMAGE,
        capability: "previewPostMitigationDamage",
        action: "preview post-mitigation damage",
        payload: {},
      },
      {
        command: TRAILS_COMMANDS.PREVIEW_RECOVERY,
        capability: "buildRecoveryPlan",
        action: "preview recovery",
        payload: {},
      },
      {
        command: TRAILS_COMMANDS.EXPERIENCE_PROGRESS,
        capability: "experienceProgress",
        action: "calculate experience progress",
        payload: { totalExperience: 0 },
      },
    ] as const;
    const mutationCalls: unknown[] = [];

    for (const testCase of cases) {
      const gameplay: Record<string, (...args: unknown[]) => never> = {
        [testCase.capability]: () => {
          throw new Error("private Actor resource and sourceSnapshot details");
        },
      };
      setGlobal("CONFIG", { TRAILS: { gameplay } });
      setGlobal("game", {
        collections: new Map([
          ["Actor", { update: (...args: unknown[]) => mutationCalls.push(args) }],
          ["Combat", { update: (...args: unknown[]) => mutationCalls.push(args) }],
          ["ChatMessage", { create: (...args: unknown[]) => mutationCalls.push(args) }],
        ]),
      });

      const response = await dispatch({
        id: `failure-${testCase.capability}`,
        type: testCase.command,
        payload: testCase.payload,
      });

      assert.equal(response.ok, false);
      const error = (response as { error: { code: string; message: string } }).error;
      assert.equal(error.code, "HANDLER_ERROR");
      assert.match(error.message, new RegExp(`could not ${testCase.action}`));
      assert.match(error.message, /reload the world, and try again/i);
      assert.doesNotMatch(error.message, /private Actor|sourceSnapshot/);
    }

    assert.deepEqual(mutationCalls, []);
  });
});
