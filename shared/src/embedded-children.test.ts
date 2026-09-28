import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EMBEDDED_CHILD_COMMANDS } from "./embedded-children.js";
import type { EmbeddedChildCreateInput, EmbeddedChildMutationResult } from "./embedded-children.js";

void describe("embedded child contract", () => {
  void it("uses dedicated bounded CRUD commands", () => {
    assert.deepEqual(Object.keys(EMBEDDED_CHILD_COMMANDS), [
      "LIST",
      "GET",
      "CREATE",
      "UPDATE",
      "DELETE",
    ]);
    assert.equal(new Set(Object.values(EMBEDDED_CHILD_COMMANDS)).size, 5);
  });

  void it("models dry-run and structured mutation evidence", () => {
    const input = {
      family: "RegionBehavior",
      parentId: "region",
      sceneId: "scene",
      data: { _id: "behavior", type: "threshold" },
      expectedParentRevision: "a".repeat(64),
      idempotencyKey: "stable-key",
      dryRun: true,
    } satisfies EmbeddedChildCreateInput;
    const result = {
      family: input.family,
      parentId: input.parentId,
      childId: input.data._id,
      parentRevision: "a".repeat(64),
      childRevision: "b".repeat(64),
      data: input.data,
      replayed: false,
      dryRun: true,
      persisted: false,
      subtype: "threshold",
      before: null,
      after: input.data,
      diff: [{ path: "$", kind: "added", after: input.data }],
      warnings: [],
      migrationWarnings: [],
      siblingsVerified: true,
      siblingCount: 0,
    } satisfies EmbeddedChildMutationResult;
    assert.equal(result.persisted, false);
  });
});
