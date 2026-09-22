// Phase 31 — module/ previously had zero tests. `BridgeClient` itself needs
// a real (or heavily mocked) `WebSocket`/`game.settings` global to exercise
// meaningfully, which is out of scope here (see PLAN.md's Phase 31 notes).
// But bridge-client.ts deliberately extracts two pure functions specifically
// so they're "unit-sanity-checkable without a real timer or socket" — its
// own doc comments say so — and nothing exercised them yet. This file does.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildBridgeConnectionUrl,
  computeBackoffDelayMs,
  DEFAULT_BACKOFF_OPTIONS,
} from "./bridge-client.js";

void describe("computeBackoffDelayMs", () => {
  void it("never exceeds the capped exponential ceiling for a given attempt", () => {
    const options = { baseDelayMs: 500, maxDelayMs: 30_000 };
    for (let attempt = 0; attempt < 10; attempt++) {
      const ceiling = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** attempt);
      for (let sample = 0; sample < 25; sample++) {
        const delay = computeBackoffDelayMs(attempt, options);
        assert.ok(delay >= 0, `attempt ${attempt} produced a negative delay: ${delay}`);
        assert.ok(
          delay < ceiling + 1,
          `attempt ${attempt} exceeded its ceiling (${ceiling}): ${delay}`,
        );
      }
    }
  });

  void it("caps growth at maxDelayMs once the exponential exceeds it", () => {
    const options = { baseDelayMs: 500, maxDelayMs: 2_000 };
    // 500 * 2^10 is far past maxDelayMs, so the ceiling must be maxDelayMs itself.
    for (let sample = 0; sample < 25; sample++) {
      const delay = computeBackoffDelayMs(10, options);
      assert.ok(
        delay <= options.maxDelayMs,
        `delay ${delay} exceeded maxDelayMs ${options.maxDelayMs}`,
      );
    }
  });

  void it("treats a negative attempt the same as attempt 0 (no negative exponent)", () => {
    for (let sample = 0; sample < 25; sample++) {
      const delay = computeBackoffDelayMs(-5, DEFAULT_BACKOFF_OPTIONS);
      assert.ok(delay >= 0 && delay <= DEFAULT_BACKOFF_OPTIONS.baseDelayMs);
    }
  });

  void it("defaults to DEFAULT_BACKOFF_OPTIONS when no options are given", () => {
    for (let sample = 0; sample < 25; sample++) {
      const delay = computeBackoffDelayMs(0);
      assert.ok(delay >= 0 && delay <= DEFAULT_BACKOFF_OPTIONS.baseDelayMs);
    }
  });
});

void describe("buildBridgeConnectionUrl", () => {
  void it("appends a URL-encoded apiKey query param when one is given", () => {
    const url = buildBridgeConnectionUrl("ws://127.0.0.1:3939/bridge", "s3cr3t key/with+chars");
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("apiKey"), "s3cr3t key/with+chars");
  });

  void it("omits the apiKey query param entirely when the key is an empty string", () => {
    const url = buildBridgeConnectionUrl("ws://127.0.0.1:3939/bridge", "");
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.has("apiKey"), false);
    assert.equal(url, "ws://127.0.0.1:3939/bridge");
  });

  void it("preserves an existing path/query on the base URL", () => {
    const url = buildBridgeConnectionUrl("ws://example.test:1234/bridge?foo=bar", "key1");
    const parsed = new URL(url);
    assert.equal(parsed.pathname, "/bridge");
    assert.equal(parsed.searchParams.get("foo"), "bar");
    assert.equal(parsed.searchParams.get("apiKey"), "key1");
  });
});
