import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ASSET_COMMANDS } from "./asset-lifecycle.js";
void describe("asset lifecycle contract", () => {
  void it("uses a bounded reference command", () =>
    assert.equal(ASSET_COMMANDS.REFERENCES, "assets.references"));
});
