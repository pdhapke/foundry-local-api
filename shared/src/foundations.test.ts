import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertIdempotencyKey, ProtocolError } from "./foundations.js";

void describe("Track 0 shared foundations", () => {
  void it("accepts stable portable idempotency keys", () => {
    assert.doesNotThrow(() => assertIdempotencyKey("fixture:txn-0001"));
  });

  void it("rejects short or unsafe idempotency keys with a typed field path", () => {
    assert.throws(
      () => assertIdempotencyKey("bad key"),
      (error: unknown) =>
        error instanceof ProtocolError &&
        error.code === "INVALID_PAYLOAD" &&
        error.fieldPath === "idempotencyKey" &&
        error.retryable === false,
    );
  });
});
