import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLIENT_READINESS_COMMANDS } from "./client-readiness.js";

void describe("client readiness contract", () => {
  void it("requires receiver-side commands for preload/read/apply/reload", () => {
    assert.equal(new Set(Object.values(CLIENT_READINESS_COMMANDS)).size, 4);
  });
});
