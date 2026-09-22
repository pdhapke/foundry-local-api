// Phase 9 — Actors command handlers. Registered against the same command
// dispatcher registry Phase 2 set up (module/src/command-registry.ts) and
// imported for side effects from module/src/index.ts.
//
// Actor CRUD itself is NOT re-implemented here: it's already covered
// generically by Phase 8's documentList/Get/Create/Update/Delete commands
// with `documentType: "Actor"` (see server/src/endpoints/actors.ts, which
// calls the same `makeDocumentEndpoints()` factory JournalEntry uses). This
// file only adds the two actor-specific extras PLAN.md's Phase 9 calls for:
// roll data and the embedded item collection.
import {
  ACTOR_COMMANDS,
  type ActorIdInput,
  type ActorRollData,
  type DocumentData,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";

function requireActor(id: string): FoundryActor {
  const collection = game.collections.get("Actor") as Map<string, FoundryActor> | undefined;
  const actor = collection?.get(id);
  if (!actor) {
    throw new Error(`Actor "${id}" not found`);
  }
  return actor;
}

registerCommand(ACTOR_COMMANDS.GET_ROLL_DATA, ({ id }: ActorIdInput): ActorRollData =>
  requireActor(id).getRollData(),
);

registerCommand(ACTOR_COMMANDS.LIST_ITEMS, ({ id }: ActorIdInput): DocumentData[] =>
  Array.from(requireActor(id).items.values()).map((item) => item.toObject()),
);
