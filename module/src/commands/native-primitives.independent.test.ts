import assert from "node:assert/strict";
import test from "node:test";
import { readWorldDocument, applyWorldDocument } from "./world-documents.js";
import { readSessionAction, applySessionAction } from "./session-actions.js";

void test("independent: generic document and session primitives refuse another active native GM before reading documents", async () => {
  let reads = 0;
  const requested = { id: "requester", active: true, isGM: true },
    executing = { id: "other", active: true, isGM: true };
  Object.assign(globalThis, {
    game: {
      world: { id: "world" },
      user: executing,
      users: new Map([
        [requested.id, requested],
        [executing.id, executing],
      ]),
      collections: {
        get() {
          reads++;
          throw Error("Document collection must not be reached");
        },
      },
    },
  });
  const doc = {
    worldId: "world",
    requestingUserId: "requester",
    family: "journals" as const,
    targetId: "story",
    operation: "get" as const,
  };
  await assert.rejects(() => readWorldDocument(doc), /GM|authorization/i);
  await assert.rejects(
    () =>
      applyWorldDocument({
        ...doc,
        operation: "update",
        data: { name: "After" },
        expectedRevision: "a".repeat(64),
        idempotencyKey: "document",
        correlationId: "document",
      }),
    /GM|authorization/i,
  );
  const session = {
    worldId: "world",
    requestingUserId: "requester",
    action: { kind: "door.state" as const, sceneId: "scene", targetId: "door", value: 1 as const },
  };
  assert.throws(() => readSessionAction(session), /GM|authorization/i);
  await assert.rejects(
    () =>
      applySessionAction({
        ...session,
        expectedState: {},
        idempotencyKey: "session",
        correlationId: "session",
      }),
    /GM|authorization/i,
  );
  assert.equal(reads, 0);
});
