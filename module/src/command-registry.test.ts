// Phase 31 — module/ previously had zero tests. Unlike every other file
// under module/src/, command-registry.ts needs no Foundry global at all
// (no `game`/`Hooks`/`canvas`) — it's a plain string-keyed dispatch table —
// so it's fully unit-testable as-is.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { ProtocolError, type BridgeRequest } from "@foundry-local-api/shared";

import { dispatch, registerCommand, unregisterCommand } from "./command-registry.js";

// `ping` is registered for real (module-load side effect, see
// command-registry.ts's last line) and shared as a single process-wide Map,
// so every test here uses its own uniquely-named command to avoid cross-test
// interference, and cleans up after itself.
void describe("command-registry dispatch()", () => {
  const registered: string[] = [];
  afterEach(() => {
    for (const type of registered.splice(0)) {
      unregisterCommand(type);
    }
  });

  function register(type: string, handler: Parameters<typeof registerCommand>[1]): void {
    registerCommand(type, handler);
    registered.push(type);
  }

  void it("routes a request to the handler registered for its type and wraps a success reply", async () => {
    register("test.echo", (payload: unknown) => ({ echoed: payload }));

    const request: BridgeRequest = { id: "req-1", type: "test.echo", payload: { a: 1 } };
    const response = await dispatch(request);

    assert.deepEqual(response, { id: "req-1", ok: true, result: { echoed: { a: 1 } } });
  });

  void it("awaits an async handler before replying", async () => {
    register("test.async", async (payload: unknown) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return { got: payload };
    });

    const response = await dispatch({ id: "req-2", type: "test.async", payload: "x" });

    assert.deepEqual(response, { id: "req-2", ok: true, result: { got: "x" } });
  });

  void it("returns an UNKNOWN_COMMAND error reply, carrying the original request id, for an unregistered type", async () => {
    const response = await dispatch({ id: "req-3", type: "test.does-not-exist" });

    assert.equal(response.ok, false);
    if (!response.ok) {
      assert.equal(response.id, "req-3");
      assert.equal(response.error.code, "UNKNOWN_COMMAND");
      assert.match(response.error.message, /test\.does-not-exist/);
    }
  });

  void it("returns a HANDLER_ERROR error reply (never throws) when the handler throws", async () => {
    register("test.throws", () => {
      throw new Error("boom");
    });

    const response = await dispatch({ id: "req-4", type: "test.throws" });

    assert.equal(response.ok, false);
    if (!response.ok) {
      assert.equal(response.id, "req-4");
      assert.equal(response.error.code, "HANDLER_ERROR");
      assert.equal(response.error.message, "boom");
    }
  });

  void it("returns a HANDLER_ERROR error reply when a rejected async handler's rejection isn't an Error", async () => {
    register("test.rejects-non-error", () => Promise.reject("just a string"));

    const response = await dispatch({ id: "req-5", type: "test.rejects-non-error" });

    assert.equal(response.ok, false);
    if (!response.ok) {
      assert.equal(response.error.code, "HANDLER_ERROR");
      assert.equal(response.error.message, "just a string");
    }
  });

  void it("preserves safe typed protocol error metadata", async () => {
    registerCommand("typed-error-test", () => {
      throw new ProtocolError({
        code: "STALE_REVISION",
        message: "Revision changed.",
        retryable: true,
        fieldPath: "expectedRevision",
        details: { expected: "1", actual: "2" },
      });
    });
    const response = await dispatch({ id: "typed-1", type: "typed-error-test" });
    assert.deepEqual(response, {
      id: "typed-1",
      ok: false,
      error: {
        message: "Revision changed.",
        code: "STALE_REVISION",
        retryable: true,
        fieldPath: "expectedRevision",
        details: { expected: "1", actual: "2" },
      },
    });
    unregisterCommand("typed-error-test");
  });

  void it("unregisterCommand removes a handler so subsequent dispatches see it as unknown", async () => {
    register("test.removable", () => ({ ok: true }));
    unregisterCommand("test.removable");
    registered.pop();

    const response = await dispatch({ id: "req-6", type: "test.removable" });

    assert.equal(response.ok, false);
    if (!response.ok) {
      assert.equal(response.error.code, "UNKNOWN_COMMAND");
    }
  });

  void it("re-registering the same type replaces the previous handler", async () => {
    register("test.replace", () => ({ which: "first" }));
    register("test.replace", () => ({ which: "second" }));

    const response = await dispatch({ id: "req-7", type: "test.replace" });

    assert.deepEqual(response, { id: "req-7", ok: true, result: { which: "second" } });
  });

  void it("the module-load-registered 'ping' handler responds with pong: true and echoes the payload", async () => {
    const response = await dispatch({ id: "req-8", type: "ping", payload: { hello: "world" } });

    assert.deepEqual(response, {
      id: "req-8",
      ok: true,
      result: { pong: true, payload: { hello: "world" } },
    });
  });
});
