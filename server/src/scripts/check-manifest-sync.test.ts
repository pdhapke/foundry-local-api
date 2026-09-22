// Phase 33 — unit tests for `diffIntegrationManifestSync`, the pure
// comparison logic extracted from check-manifest-sync.ts's thin CLI shell
// (see that file's header comment for the "why a pure diff function" pattern
// this mirrors). No real files or registry are touched here — every case
// below just calls the function with small fake arrays.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { diffIntegrationManifestSync } from "./check-manifest-sync.js";

void describe("diffIntegrationManifestSync", () => {
  void it("reports no problems when both sides are empty", () => {
    assert.deepEqual(diffIntegrationManifestSync([], []), []);
  });

  void it("reports no problems for matching entries when the manifest side omits `implemented`", () => {
    const problems = diffIntegrationManifestSync(
      [{ id: "dnd5e", kind: "system" }],
      [{ id: "dnd5e", kind: "system" }],
    );
    assert.deepEqual(problems, []);
  });

  void it("reports no problems for matching entries when the manifest side has explicit `implemented: true`", () => {
    const problems = diffIntegrationManifestSync(
      [{ id: "dnd5e", kind: "system" }],
      [{ id: "dnd5e", kind: "system", implemented: true }],
    );
    assert.deepEqual(problems, []);
  });

  void it("reports exactly one problem naming the id when a code entry has no manifest counterpart", () => {
    const problems = diffIntegrationManifestSync([{ id: "dnd5e", kind: "system" }], []);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /dnd5e/);
  });

  void it("reports exactly one problem when a manifest entry with implemented: true has no code counterpart", () => {
    const problems = diffIntegrationManifestSync(
      [],
      [{ id: "dnd5e", kind: "system", implemented: true }],
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /dnd5e/);
  });

  void it("reports exactly one problem when a manifest entry omitting implemented has no code counterpart", () => {
    const problems = diffIntegrationManifestSync([], [{ id: "dnd5e", kind: "system" }]);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /dnd5e/);
  });

  void it("reports no problem for a manifest entry with implemented: false and no code counterpart (planned, not yet built)", () => {
    const problems = diffIntegrationManifestSync(
      [],
      [{ id: "dnd5e", kind: "system", implemented: false }],
    );
    assert.deepEqual(problems, []);
  });

  void it("reports exactly one problem when a code entry's manifest counterpart says implemented: false", () => {
    const problems = diffIntegrationManifestSync(
      [{ id: "dnd5e", kind: "system" }],
      [{ id: "dnd5e", kind: "system", implemented: false }],
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /dnd5e/);
    assert.match(problems[0]!, /implemented.*false/);
  });

  void it("reports exactly one problem when kind mismatches between a code entry and its manifest counterpart", () => {
    const problems = diffIntegrationManifestSync(
      [{ id: "dnd5e", kind: "system" }],
      [{ id: "dnd5e", kind: "module" }],
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /kind/);
  });

  void it("reports a problem for a duplicate id within the code list", () => {
    const problems = diffIntegrationManifestSync(
      [
        { id: "dnd5e", kind: "system" },
        { id: "dnd5e", kind: "system" },
      ],
      [{ id: "dnd5e", kind: "system" }],
    );
    assert.ok(problems.some((p) => /[Dd]uplicate/.test(p) && /dnd5e/.test(p)));
  });

  void it("reports a problem for a duplicate id within the manifest list", () => {
    const problems = diffIntegrationManifestSync(
      [{ id: "dnd5e", kind: "system" }],
      [
        { id: "dnd5e", kind: "system" },
        { id: "dnd5e", kind: "system" },
      ],
    );
    assert.ok(problems.some((p) => /[Dd]uplicate/.test(p) && /dnd5e/.test(p)));
  });
});
