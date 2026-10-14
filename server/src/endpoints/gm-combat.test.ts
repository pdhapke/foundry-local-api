import assert from "node:assert/strict";
import test from "node:test";
import {
  gmCombatEndpointDescriptors,
  gmCombatApplySchema,
  gmCombatStateSchema,
} from "./gm-combat.js";
void test("combat descriptors expose real REST and MCP names with bounded shared input", () => {
  assert.deepEqual(
    gmCombatEndpointDescriptors.map((d) => [d.name, d.path]),
    [
      ["foundry_gm_combat_state", "/gm/combat/state"],
      ["foundry_gm_combat_apply", "/gm/combat/apply"],
    ],
  );
  const input = {
    schemaVersion: "gm-actions-v1",
    worldId: "world",
    userId: "gm",
    sceneId: "scene",
    action: { kind: "read", combatId: "combat" },
  };
  assert.equal(gmCombatStateSchema.safeParse(input).success, true);
  assert.equal(gmCombatStateSchema.safeParse({ ...input, systemOverride: {} }).success, false);
  assert.equal(
    gmCombatApplySchema.safeParse({
      ...input,
      action: { kind: "initiative", combatId: "combat", combatantIds: ["one"] },
      expectedState: {},
      idempotencyKey: "once",
      correlationId: "once",
    }).success,
    false,
  );
  assert.equal(
    gmCombatApplySchema.safeParse({
      ...input,
      action: { kind: "next", combatId: "combat" },
      expectedState: {},
      idempotencyKey: "once",
      correlationId: "once",
    }).success,
    true,
  );
});
