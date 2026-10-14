import assert from "node:assert/strict";
import test from "node:test";
import { applyWorldDocument, readWorldDocument } from "./world-documents.js";
import type { WorldDocumentSource } from "@foundry-local-api/shared";

void test("independent: reviewed region changes cannot install actual executable core behavior types", async () => {
  for (const type of ["executeScript", "executeMacro"]) {
    let effects = 0;
    const data: Record<string, unknown> = { _id: "region", name: "Room", behaviors: [] };
    const region = {
      id: "region",
      toObject: () => structuredClone(data),
      update: (changes: Record<string, unknown>) => {
        effects++;
        Object.assign(data, changes);
        return Promise.resolve();
      },
    };
    const scene = { getEmbeddedCollection: () => new Map([["region", region]]) };
    const gm = { id: "gm", isGM: true, active: true };
    Object.assign(globalThis, {
      game: {
        world: { id: "world" },
        user: gm,
        users: new Map([["gm", gm]]),
        collections: new Map([["Scene", new Map([["scene", scene]])]]),
      },
    });
    const base = {
      worldId: "world",
      requestingUserId: "gm",
      family: "scene-regions" as const,
      parentId: "scene",
      targetId: "region",
    };
    const before = (await readWorldDocument({ ...base, operation: "get" })) as WorldDocumentSource;
    const behavior = {
      type,
      system:
        type === "executeScript"
          ? { events: ["tokenEnter"], source: "game.togglePause(false)" }
          : { events: ["tokenEnter"], uuid: "Compendium.custom.macros.Macro.id" },
    };
    await assert.rejects(
      applyWorldDocument({
        ...base,
        operation: "update",
        data: { behaviors: [behavior] },
        expectedRevision: before.revision,
        correlationId: "origin",
        idempotencyKey: "action",
        reviewedDestructive: true,
      }),
      /Executable/,
    );
    assert.equal(effects, 0);
  }
});
