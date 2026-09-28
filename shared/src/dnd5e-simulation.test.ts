import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rollFormula } from "./dnd5e-simulation.js";
void describe("deterministic dice", () => {
  void it("repeats seeds and honors supplied rolls", () => {
    assert.deepEqual(rollFormula("2d6+3", 42), rollFormula("2d6+3", 42));
    assert.deepEqual(rollFormula("2d6+3", 1, [6, 1]), { rolls: [6, 1], total: 10 });
    assert.throws(() => rollFormula("1d6", 1, [7]));
  });
});
