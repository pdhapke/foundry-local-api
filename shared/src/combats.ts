// Phase 16 — Combat & Combat Tracker. Command names and payload/result
// shapes for the combat-specific extras layered on top of the Phase 8
// generic document CRUD (Combat CRUD itself reuses DOCUMENT_COMMANDS with
// documentType: "Combat", identical to Scene/Actor/Item/Macro): turn/round
// control (start/next-turn/next-round/end), embedded Combatant add/remove,
// and initiative rolling. Shared between the server's combat endpoints
// (server/src/endpoints/combats.ts) and the module's combat command handlers
// (module/src/commands/combats.ts).

export const COMBAT_COMMANDS = {
  START: "combatStart",
  NEXT_TURN: "combatNextTurn",
  NEXT_ROUND: "combatNextRound",
  END: "combatEnd",
  ADD_COMBATANT: "combatAddCombatant",
  REMOVE_COMBATANT: "combatRemoveCombatant",
  ROLL_INITIATIVE: "combatRollInitiative",
} as const;

export interface CombatIdInput {
  id: string;
}

export interface CombatAddCombatantInput {
  id: string;
  data: Record<string, unknown>;
}

export interface CombatRemoveCombatantInput {
  id: string;
  combatantId: string;
}

export interface CombatRollInitiativeInput {
  id: string;
  /** Combatant ids to roll for; omit to roll for every combatant missing initiative (`rollAll`). */
  combatantIds?: string[] | undefined;
}
