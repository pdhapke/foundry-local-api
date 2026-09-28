import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REFERENCE_AUDIT_COMMAND } from "./reference-audit.js";
void describe("reference audit contract", () => {
  void it("has a stable command", () => assert.equal(REFERENCE_AUDIT_COMMAND, "references.audit"));
});
