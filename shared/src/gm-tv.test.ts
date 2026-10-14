import assert from "node:assert/strict";
import { test } from "node:test";
import { GM_TV_COMMANDS, TV_CONTROL_VERSION } from "./gm-tv.js";
void test("TV uses a dedicated bounded command and version", () => {
  assert.deepEqual(GM_TV_COMMANDS, { EXECUTE: "gmTvControl" });
  assert.equal(TV_CONTROL_VERSION, "tv-controls-v1");
});
