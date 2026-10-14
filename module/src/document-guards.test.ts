import assert from "node:assert/strict";
import test from "node:test";
import { registerDocumentGuard, validateDocumentGuard } from "./document-guards.js";

void test("missing and asynchronous domain policies refuse a mutation", () => {
  assert.throws(() => validateDocumentGuard("missing", {}), /unavailable/);
  const remove = registerDocumentGuard("async-fixture", (() => Promise.resolve()) as () => void);
  try { assert.throws(() => validateDocumentGuard("async-fixture", {}), /synchronously/); }
  finally { remove(); }
});
void test("current synchronous policy controls mutation and cleanup revokes it", () => {
  let checked = false;
  const remove = registerDocumentGuard("fixture", context => { assert.deepEqual(context, { revision: 2 }); checked = true; });
  assert.throws(() => registerDocumentGuard("fixture", () => {}), /duplicated/);
  validateDocumentGuard("fixture", { revision: 2 });
  assert.equal(checked, true);
  remove(); remove();
  assert.throws(() => validateDocumentGuard("fixture", {}), /unavailable/);
});
