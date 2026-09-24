// Phase 16 — Combat & Combat Tracker. Command names and payload/result
// shapes for the combat-specific extras layered on top of the Phase 8
// generic document CRUD (Combat CRUD itself reuses DOCUMENT_COMMANDS with
// documentType: "Combat", identical to Scene/Actor/Item/Macro): turn/round
// control (start/next-turn/next-round/end), embedded Combatant add/remove,
// and initiative rolling. Shared between the server's combat endpoints
// (server/src/endpoints/combats.ts) and the module's combat command handlers
// (module/src/commands/combats.ts).
//
// Phase 39 added embedded Combatant update (Phase 16 only had add/remove).
// Phase 40 added previous-turn/previous-round to complement Phase 16's
// forward-only next-turn/next-round/start/end.

export const COMBAT_COMMANDS = {
  START: "combatStart",
  NEXT_TURN: "combatNextTurn",
  NEXT_ROUND: "combatNextRound",
  PREVIOUS_TURN: "combatPreviousTurn",
  PREVIOUS_ROUND: "combatPreviousRound",
  END: "combatEnd",
  ADD_COMBATANT: "combatAddCombatant",
  REMOVE_COMBATANT: "combatRemoveCombatant",
  UPDATE_COMBATANT: "combatUpdateCombatant",
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

export interface CombatUpdateCombatantInput {
  id: string;
  combatantId: string;
  data: Record<string, unknown>;
}

export interface CombatRollInitiativeInput {
  id: string;
  /** Combatant ids to roll for; omit to roll for every combatant missing initiative (`rollAll`). */
  combatantIds?: string[] | undefined;
}
