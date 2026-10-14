import assert from "node:assert/strict";
import test from "node:test";
import {
  worldDocumentReadSchema,
  worldDocumentApplySchema,
  worldDocumentEndpointDescriptors,
} from "./world-documents.js";
void test("known world family schema excludes arbitrary collections/roots and bounds list scope", () => {
  const base = { worldId: "w", requestingUserId: "gm", family: "actors", operation: "list" };
  assert.equal(worldDocumentReadSchema.safeParse(base).success, true);
  for (const extra of [
    { family: "Users" },
    { limit: 21 },
    { offset: -1 },
    { root: "C:/escape" },
    { family: "macros" },
  ])
    assert.equal(worldDocumentReadSchema.safeParse({ ...base, ...extra }).success, false);
  assert.equal(
    worldDocumentApplySchema.safeParse({
      ...base,
      operation: "update",
      targetId: "a",
      data: { name: "New" },
      expectedRevision: "a".repeat(64),
      correlationId: "corr",
      idempotencyKey: "key",
    }).success,
    true,
  );
  assert.equal(worldDocumentEndpointDescriptors[0]?.name, "foundry_get_world_document");
  assert.equal(worldDocumentEndpointDescriptors[1]?.name, "foundry_apply_world_document");
});
