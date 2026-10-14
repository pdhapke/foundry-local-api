import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertIdempotencyKey, ProtocolError, type BridgeHelloMessage } from "./foundations.js";

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

  void it("keeps browser-bound handoff material outside the projected client identity", () => {
    const hello: BridgeHelloMessage = {
      kind: "hello",
      browserSessionId: "browser-session-0001",
      identityHandoffProof: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      identity: {
        clientId: "client",
        userId: "user",
        userName: "User",
        isGM: true,
        lane: "gm",
        optedIn: true,
      },
      versions: {
        protocolVersion: 2,
        foundryVersion: "14.368",
        systemId: "dnd5e",
        systemVersion: "6.0.3",
        moduleVersion: "0.1.0",
        transport: "websocket",
      },
      capabilities: [],
    };
    assert.equal("identityHandoffProof" in hello.identity, false);
    assert.equal(hello.identityHandoffProof?.length, 43);
  });
});
