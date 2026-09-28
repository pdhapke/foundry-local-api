import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { z } from "zod";

import { integrations } from "../registry.js";
import { trailsEndpointDescriptors } from "./endpoints.js";
import { trailsOfDestinyIntegration } from "./index.js";

const expectedSurface = [
  ["trails_get_config", "get", "/trails-of-destiny/config"],
  ["trails_get_actor_sheet", "get", "/trails-of-destiny/actors/:id/sheet"],
  ["trails_get_actor_inventory", "get", "/trails-of-destiny/actors/:id/inventory"],
  ["trails_list_catalogs", "get", "/trails-of-destiny/catalogs"],
  ["trails_get_catalog", "get", "/trails-of-destiny/catalogs/:packId"],
  ["trails_evaluate_creation", "get", "/trails-of-destiny/actors/:id/creation-readiness"],
  ["trails_roll_action", "post", "/trails-of-destiny/rolls/action"],
  ["trails_preview_initiative", "post", "/trails-of-destiny/previews/initiative"],
  ["trails_preview_threat_contest", "post", "/trails-of-destiny/previews/threat-contest"],
  ["trails_preview_damage", "post", "/trails-of-destiny/previews/damage"],
  ["trails_preview_recovery", "post", "/trails-of-destiny/previews/recovery"],
  ["trails_get_experience_progress", "get", "/trails-of-destiny/experience/:totalExperience"],
  ["trails_preview_builder", "post", "/trails-of-destiny/builder/preview"],
] as const;

function descriptor(name: string) {
  const match = trailsEndpointDescriptors.find((entry) => entry.name === name);
  assert.ok(match, `missing ${name}`);
  return match;
}

void describe("Trails integration descriptor metadata", () => {
  void it("declares and globally registers the exact optional-system identity", () => {
    assert.equal(trailsOfDestinyIntegration.id, "trails-of-destiny");
    assert.equal(trailsOfDestinyIntegration.kind, "system");
    assert.equal(trailsOfDestinyIntegration.toolPrefix, "trails_");
    assert.equal(trailsOfDestinyIntegration.minVersion, "0.1.0");
    assert.equal(trailsOfDestinyIntegration.maxVersion, undefined);
    assert.equal(trailsOfDestinyIntegration.detect("trails-of-destiny", []), true);
    assert.equal(trailsOfDestinyIntegration.detect("dnd5e", ["trails-of-destiny"]), false);
    assert.equal(
      integrations.some((integration) => integration.id === "trails-of-destiny"),
      true,
    );
  });

  void it("defines the exact 13-tool REST surface with non-destructive annotations", () => {
    assert.deepEqual(
      trailsEndpointDescriptors.map(({ name, method, path }) => [name, method, path]),
      expectedSurface,
    );
    for (const entry of trailsEndpointDescriptors) {
      assert.equal(entry.annotations?.readOnlyHint, true, entry.name);
      assert.equal(entry.annotations?.destructiveHint, false, entry.name);
      assert.equal(entry.annotations?.openWorldHint, false, entry.name);
      assert.match(entry.description, /does not|no recovery is applied/i, entry.name);
      if (entry.inputSchema !== undefined) {
        assert.equal(
          entry.inputSchema instanceof z.ZodObject,
          true,
          `${entry.name} must stay flat`,
        );
      }
    }
    assert.equal(descriptor("trails_roll_action").annotations?.idempotentHint, false);
    assert.equal(descriptor("trails_preview_initiative").annotations?.idempotentHint, false);
  });

  void it("bounds roll pools and does not accept caller-supplied action-roll dice", () => {
    const schema = descriptor("trails_roll_action").inputSchema;
    assert.ok(schema);
    const valid = {
      kind: "action",
      abilityId: "agi",
      skillId: "",
      abilityDice: 1,
      skillDice: 0,
      otherDice: 0,
      abilityChallenges: 0,
      challenges: 0,
      chances: 0,
      charges: 0,
      conditionalDice: [],
    };
    assert.equal(schema.safeParse(valid).success, true);
    assert.equal(schema.safeParse({ ...valid, chances: 4 }).success, false);
    assert.equal(schema.safeParse({ ...valid, actionDie: 20 }).success, true);
    assert.equal(
      "actionDie" in (schema.parse({ ...valid, actionDie: 20 }) as Record<string, unknown>),
      false,
    );
  });

  void it("bounds initiative, recovery evidence, experience, catalogs, and builder text", () => {
    const initiative = descriptor("trails_preview_initiative").inputSchema;
    const recovery = descriptor("trails_preview_recovery").inputSchema;
    const experience = descriptor("trails_get_experience_progress").inputSchema;
    const catalog = descriptor("trails_get_catalog").inputSchema;
    const builder = descriptor("trails_preview_builder").inputSchema;
    assert.ok(initiative && recovery && experience && catalog && builder);

    const participant = {
      id: "a",
      bonusDice: 0,
      challenges: 0,
      charges: 0,
      sources: [],
    };
    assert.equal(initiative.safeParse({ participants: [participant, participant] }).success, false);

    const resources = Object.fromEntries(
      ["durability", "health", "vigor", "mana", "energy"].map((key) => [
        key,
        { value: 0, max: 10 },
      ]),
    );
    const eligibility = Object.fromEntries(
      ["durability", "health", "vigor", "mana", "energy"].map((key) => [key, true]),
    );
    assert.equal(
      recovery.safeParse({
        kind: "sleep",
        resources,
        eligibility,
        staminaBonusDice: 2,
        staminaDice: [10],
      }).success,
      false,
    );
    assert.deepEqual(experience.parse({ totalExperience: "306250" }), {
      totalExperience: 306250,
    });
    assert.equal(experience.safeParse({ totalExperience: -1 }).success, false);
    assert.equal(catalog.safeParse({ packId: "world.private" }).success, false);
    assert.equal(builder.safeParse({ raw: "x".repeat(2_000_000) }).success, true);
    const oversizedAscii = builder.safeParse({ raw: "x".repeat(2_000_001) });
    assert.equal(oversizedAscii.success, false);
    if (!oversizedAscii.success) {
      assert.ok(
        oversizedAscii.error.issues.some((issue) => /2000000 UTF-8 bytes/.test(issue.message)),
      );
    }
    // The limit is bytes rather than JavaScript string length: each e-acute
    // occupies two UTF-8 bytes even though it is one UTF-16 code unit.
    assert.equal(builder.safeParse({ raw: "é".repeat(1_000_000) }).success, true);
    assert.equal(builder.safeParse({ raw: "é".repeat(1_000_001) }).success, false);
    assert.equal(builder.safeParse({ raw: 1 }).success, false);
    assert.equal(builder.safeParse({}).success, false);
  });

  void it("matches live threat and post-mitigation damage input validation", () => {
    const threat = descriptor("trails_preview_threat_contest").inputSchema;
    const damage = descriptor("trails_preview_damage").inputSchema;
    assert.ok(threat && damage);

    for (const classification of ["attack", "assault"] as const) {
      assert.equal(
        threat.safeParse({
          classification,
          actionTotal: 0,
          passiveDefense: 1_000_000,
          reactionTotal: null,
        }).success,
        true,
      );
    }
    assert.equal(
      threat.safeParse({
        classification: "spell",
        actionTotal: 1,
        passiveDefense: 1,
      }).success,
      false,
    );
    assert.equal(
      threat.safeParse({
        classification: "attack",
        actionTotal: -1,
        passiveDefense: 1,
      }).success,
      false,
    );
    assert.equal(
      threat.safeParse({
        classification: "attack",
        actionTotal: 1.5,
        passiveDefense: 1,
      }).success,
      false,
    );

    assert.deepEqual(damage.parse({ durability: 4, health: 3, damage: 2 }), {
      durability: 4,
      health: 3,
      damage: 2,
    });
    assert.equal(
      damage.safeParse({ durability: 0, health: 0, damage: 1, lifeState: "shock" }).success,
      true,
    );
    assert.equal(damage.safeParse({ durability: 0, health: 0, damage: -1 }).success, false);
    assert.equal(
      damage.safeParse({ durability: 0, health: 0, damage: 1, lifeState: "dying" }).success,
      false,
    );
  });
});
