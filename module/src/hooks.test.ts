// Phase 31 — module/ previously had zero tests. `registerHookForwarding()`
// itself needs a real `Hooks` global to exercise meaningfully (out of scope
// here, see PLAN.md's Phase 31 notes), but the two pure helpers it's built
// on — `hasToObject`/`normalizeHookArg` — were exported specifically to make
// them directly unit-testable (see their doc comments in hooks.ts). This
// file covers those directly.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hasToObject, normalizeHookArg } from "./hooks.js";

void describe("hasToObject", () => {
  void it("is true for an object exposing a toObject() function", () => {
    assert.equal(hasToObject({ toObject: () => ({}) }), true);
  });

  void it("is false for a plain object without toObject", () => {
    assert.equal(hasToObject({ id: "a1" }), false);
  });

  void it("is false for null/undefined/primitives", () => {
    assert.equal(hasToObject(null), false);
    assert.equal(hasToObject(undefined), false);
    assert.equal(hasToObject("a string"), false);
    assert.equal(hasToObject(42), false);
  });

  void it("is false when toObject is present but not a function", () => {
    assert.equal(hasToObject({ toObject: "not-a-function" }), false);
  });
});

void describe("normalizeHookArg", () => {
  void it("calls toObject() on a Document-like arg and returns its plain data", () => {
    const fakeDocument = { toObject: () => ({ _id: "a1", name: "Fireball" }) };
    assert.deepEqual(normalizeHookArg(fakeDocument), { _id: "a1", name: "Fireball" });
  });

  void it("passes non-Document args through unchanged", () => {
    const optionsArg = { diff: true };
    assert.equal(normalizeHookArg(optionsArg), optionsArg);
    assert.equal(normalizeHookArg("user-1"), "user-1");
    assert.equal(normalizeHookArg(42), 42);
    assert.equal(normalizeHookArg(null), null);
  });
});
