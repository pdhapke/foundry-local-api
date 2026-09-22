// Phase 32 — unit tests for the dotted-numeric version comparator.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isVersionInRange } from "./version.js";

void describe("isVersionInRange", () => {
  void it("returns true when neither bound is set", () => {
    assert.equal(isVersionInRange("1.2.3"), true);
    assert.equal(isVersionInRange("0.0.0"), true);
  });

  void it("enforces only minVersion when maxVersion is omitted", () => {
    assert.equal(isVersionInRange("3.10.0", "3.9.0"), true);
    assert.equal(isVersionInRange("3.9.0", "3.9.0"), true);
    assert.equal(isVersionInRange("3.8.9", "3.9.0"), false);
  });

  void it("enforces only maxVersion when minVersion is omitted", () => {
    assert.equal(isVersionInRange("2.0.0", undefined, "3.0.0"), true);
    assert.equal(isVersionInRange("3.0.0", undefined, "3.0.0"), true);
    assert.equal(isVersionInRange("3.0.1", undefined, "3.0.0"), false);
  });

  void it("enforces both bounds together", () => {
    assert.equal(isVersionInRange("2.5.0", "2.0.0", "3.0.0"), true);
    assert.equal(isVersionInRange("1.9.9", "2.0.0", "3.0.0"), false);
    assert.equal(isVersionInRange("3.0.1", "2.0.0", "3.0.0"), false);
  });

  void it("treats equal versions as in-range for both bounds", () => {
    assert.equal(isVersionInRange("1.0.0", "1.0.0", "1.0.0"), true);
  });

  void it("compares segment-by-segment, not lexicographically (numeric, not string, comparison)", () => {
    assert.equal(isVersionInRange("3.9.0", "3.10.0"), false);
    assert.equal(isVersionInRange("3.10.0", "3.9.0"), true);
  });

  void it("handles version strings with differing segment counts, treating missing segments as 0", () => {
    assert.equal(isVersionInRange("1.2", "1.2.0"), true);
    assert.equal(isVersionInRange("1.2.0.1", "1.2.0"), true);
    assert.equal(isVersionInRange("1.2", undefined, "1.2.0"), true);
    assert.equal(isVersionInRange("1.2.1", undefined, "1.2"), false);
  });

  void it("treats non-numeric segments as 0", () => {
    assert.equal(isVersionInRange("1.x.0", "1.0.0"), true);
    assert.equal(isVersionInRange("1.x.0", "1.1.0"), false);
  });
});
