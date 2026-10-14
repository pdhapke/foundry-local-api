import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

void test("independent installed dnd5e native evaluatedTargets hit/critical/fumble semantics", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../../../../systems/dnd5e/system.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(manifest.version, "6.0.3");
  const source = readFileSync(new URL("../../../../../systems/dnd5e/dnd5e.mjs", import.meta.url), "utf8");
  const start = source.indexOf("  get evaluatedTargets() {");
  assert.ok(start > 0);
  const end = source.indexOf("\n  }", start);
  const body = source.slice(source.indexOf("{", start) + 1, end);
  // Execute the installed system getter, not a separately written hit formula.
  const native = new Function("CONFIG", body);
  class NativeRoll { constructor(readonly total: number, readonly isCritical: boolean, readonly isFumble: boolean) {} }
  const config = { Dice: { D20Roll: NativeRoll } };
  const evaluate = (roll: NativeRoll, ac: number | null) => native.call({ parent: { rolls: [roll] }, targets: [{ ac }] }, config) as { isMiss: boolean }[];
  assert.equal(evaluate(new NativeRoll(16, false, false), 16)[0]?.isMiss, false);
  assert.equal(evaluate(new NativeRoll(15, false, false), 16)[0]?.isMiss, true);
  assert.equal(evaluate(new NativeRoll(30, false, true), 16)[0]?.isMiss, true);
  assert.equal(evaluate(new NativeRoll(1, true, false), 30)[0]?.isMiss, false);
  assert.equal(evaluate(new NativeRoll(20, true, false), null)[0]?.isMiss, true);
  assert.deepEqual(native.call({ parent: { rolls: [{}] }, targets: [{ ac: 16 }] }, config), []);
});
