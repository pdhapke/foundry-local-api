import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EFFECTIVE_USER_COMMANDS, type EffectiveUserOperation } from "./effective-user.js";

void describe("effective-user shared contract", () => {
  void it("uses one dedicated command instead of accepting an arbitrary command name", () => {
    assert.deepEqual(EFFECTIVE_USER_COMMANDS, { EXECUTE: "effectiveUserExecute" });
    assert.equal(Object.hasOwn(EFFECTIVE_USER_COMMANDS, "command"), false);
  });

  void it("defines only the four read-only permission-context operations", () => {
    const operations: EffectiveUserOperation[] = [
      { kind: "inspectActorControl", actorId: "actor" },
      { kind: "readJournalContent", journalEntryId: "journal" },
      { kind: "inspectSceneToken", sceneId: "scene", tokenId: "token" },
      { kind: "inspectNoteAccess", sceneId: "scene", noteId: "note" },
    ];
    assert.deepEqual(
      operations.map(({ kind }) => kind),
      ["inspectActorControl", "readJournalContent", "inspectSceneToken", "inspectNoteAccess"],
    );
  });
});
