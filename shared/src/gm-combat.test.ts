import assert from "node:assert/strict";
import test from "node:test";
import { validateGmCombatAction } from "./gm-combat.js";
void test("combat action schema bounds native primitives and explicit choices", () => {
  assert.doesNotThrow(() => validateGmCombatAction({ kind: "create", tokenIds: ["one"] }));
  assert.doesNotThrow(() =>
    validateGmCombatAction({
      kind: "initiative",
      combatId: "combat",
      combatantIds: ["one", "two"],
      rollMode: "gmroll",
    }),
  );
  for (const action of [
    { kind: "initiative", combatId: "combat", combatantIds: ["one"] },
    { kind: "create", tokenIds: ["one", "one"] },
    {
      kind: "budget-spend",
      combatId: "combat",
      combatantId: "one",
      resource: "action",
      amount: 0.5,
      ruling: "Feature",
    },
    {
      kind: "budget-spend",
      combatId: "combat",
      combatantId: "one",
      resource: "movement",
      amount: Infinity,
      ruling: "Move",
    },
    {
      kind: "budget-initialize",
      combatId: "combat",
      combatantId: "one",
      movementMode: "walk",
      actionCount: 11,
      ruling: "Feature",
    },
    {
      kind: "interrupt-open",
      combatId: "combat",
      combatantId: "one",
      choiceId: "choice",
      interruptKind: "unknown",
      trigger: "Door",
    },
    {
      kind: "special-decision",
      combatId: "combat",
      combatantId: "one",
      decisionKind: "legendary",
      ruling: "Native feature",
      arbitrary: true,
    },
  ])
    assert.throws(() => validateGmCombatAction(action));
});
