// Phase 16 — Combat & Combat Tracker command handlers. Registered against
// the same command dispatcher registry Phase 2 set up
// (module/src/command-registry.ts) and imported for side effects from
// module/src/index.ts.
//
// Combat CRUD itself is NOT re-implemented here: it's already covered
// generically by Phase 8's documentList/Get/Create/Update/Delete commands
// with `documentType: "Combat"` (see server/src/endpoints/combats.ts, which
// calls the same `makeDocumentEndpoints()` factory JournalEntry/Actor/Item/
// Scene/Macro use). This file only adds the combat-specific extras PLAN.md's
// Phase 16 calls for: turn/round control, embedded Combatant add/remove, and
// initiative rolling.
import {
  COMBAT_COMMANDS,
  type CombatAddCombatantInput,
  type CombatIdInput,
  type CombatRemoveCombatantInput,
  type CombatRollInitiativeInput,
  type DocumentData,
  type DocumentDeleteResult,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";

function requireCombat(id: string): FoundryCombat {
  const collection = game.collections.get("Combat") as Map<string, FoundryCombat> | undefined;
  const combat = collection?.get(id);
  if (!combat) {
    throw new Error(`Combat "${id}" not found`);
  }
  return combat;
}

function requireCombatant(combat: FoundryCombat, combatantId: string): FoundryDocument {
  const combatant = combat.combatants.get(combatantId);
  if (!combatant) {
    throw new Error(`Combatant "${combatantId}" not found on combat "${combat.id}"`);
  }
  return combatant;
}

registerCommand(COMBAT_COMMANDS.START, async ({ id }: CombatIdInput): Promise<DocumentData> => {
  const combat = requireCombat(id);
  await combat.startCombat();
  return combat.toObject();
});

registerCommand(COMBAT_COMMANDS.NEXT_TURN, async ({ id }: CombatIdInput): Promise<DocumentData> => {
  const combat = requireCombat(id);
  await combat.nextTurn();
  return combat.toObject();
});

registerCommand(
  COMBAT_COMMANDS.NEXT_ROUND,
  async ({ id }: CombatIdInput): Promise<DocumentData> => {
    const combat = requireCombat(id);
    await combat.nextRound();
    return combat.toObject();
  },
);

registerCommand(
  COMBAT_COMMANDS.END,
  async ({ id }: CombatIdInput): Promise<DocumentDeleteResult> => {
    const combat = requireCombat(id);
    // Live-verified against Foundry V14 core: `Combat#endCombat()` is
    // hardcoded to show a `DialogV2.confirm` ("End this combat and empty the
    // turn tracker?") with no option to skip it — it blocks here forever
    // waiting for a human click on every headless call. Its own callback body
    // is nothing more than `this.delete()` (see
    // client/documents/combat.mjs), so calling `delete()` directly achieves
    // the exact same effect without the unskippable confirmation.
    await combat.delete();
    return { id };
  },
);

registerCommand(
  COMBAT_COMMANDS.ADD_COMBATANT,
  async ({ id, data }: CombatAddCombatantInput): Promise<DocumentData> => {
    const [created] = await requireCombat(id).createEmbeddedDocuments("Combatant", [data]);
    if (!created) {
      throw new Error("Failed to add combatant");
    }
    return created.toObject();
  },
);

registerCommand(
  COMBAT_COMMANDS.REMOVE_COMBATANT,
  async ({ id, combatantId }: CombatRemoveCombatantInput): Promise<DocumentDeleteResult> => {
    const combatant = requireCombatant(requireCombat(id), combatantId);
    await combatant.delete();
    return { id: combatantId };
  },
);

registerCommand(
  COMBAT_COMMANDS.ROLL_INITIATIVE,
  async ({ id, combatantIds }: CombatRollInitiativeInput): Promise<DocumentData> => {
    const combat = requireCombat(id);
    if (combatantIds && combatantIds.length > 0) {
      await combat.rollInitiative(combatantIds);
    } else {
      await combat.rollAll();
    }
    return combat.toObject();
  },
);
