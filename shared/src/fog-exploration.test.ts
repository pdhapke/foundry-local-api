import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FOG_EXPLORATION_COMMANDS } from "./fog-exploration.js";

void describe("fog exploration contract", () => {
  void it("uses dedicated read/update commands", () => {
    assert.deepEqual(FOG_EXPLORATION_COMMANDS, {
      GET: "fogExplorationGet",
      UPDATE: "fogExplorationUpdate",
    });
  });
});
