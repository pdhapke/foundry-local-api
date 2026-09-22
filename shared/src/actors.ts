// Phase 9 — Actors. Command names and payload/result shapes for the two
// actor-specific extras layered on top of the Phase 8 generic document CRUD
// (Actor CRUD itself reuses DOCUMENT_COMMANDS with documentType: "Actor",
// same as every other document type — no new commands needed for that
// part), shared between the server's actor endpoints
// (server/src/endpoints/actors.ts) and the module's actor command handlers
// (module/src/commands/actors.ts).

export const ACTOR_COMMANDS = {
  GET_ROLL_DATA: "actorGetRollData",
  LIST_ITEMS: "actorListItems",
} as const;

export interface ActorIdInput {
  id: string;
}

/** An actor's system-specific roll data, as returned by `Actor#getRollData()`. */
export type ActorRollData = Record<string, unknown>;
