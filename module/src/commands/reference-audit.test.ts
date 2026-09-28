import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { auditReferences } from "./reference-audit.js";
void describe("reference audit", () => {
  beforeEach(() => {
    (globalThis as any).fromUuidSync = () => undefined;
    (globalThis as any).game = {
      user: { isGM: true },
      collections: new Map([
        [
          "Actor",
          new Map([
            [
              "1",
              {
                uuid: "Actor.1",
                documentName: "Actor",
                toObject: () => ({
                  flags: { "foundry-local-api": { stableId: "dup", gmOnly: true } },
                  ownership: { default: 1 },
                  img: "missing.png",
                  description: "@UUID[Item.none]",
                }),
              },
            ],
            [
              "2",
              {
                uuid: "Actor.2",
                documentName: "Actor",
                toObject: () => ({ flags: { "foundry-local-api": { stableId: "dup" } } }),
              },
            ],
          ]),
        ],
      ]),
    };
  });
  void it("reports seeded problems and never calls a partial scan clean", () => {
    const result = auditReferences({});
    const codes = result.issues.map((x) => x.code);
    assert.ok(codes.includes("BROKEN_UUID"));
    assert.ok(codes.includes("DUPLICATE_STABLE_ID"));
    assert.ok(codes.includes("GM_ONLY_OWNERSHIP_LEAK"));
    assert.equal(result.clean, null);
  });

  void it("fails closed for every declared but unimplemented audit class", () => {
    (globalThis as any).fromUuidSync = () => ({ uuid: "resolved" });
    (globalThis as any).game.collections = new Map();
    const result = auditReferences({});
    for (const name of ["embedded", "note", "ownership", "stableId", "tableResult"] as const) {
      const coverage = result.classes.find(({ class: kind }) => kind === name);
      assert.equal(coverage?.complete, false, name);
      assert.ok(coverage?.reason, name);
    }
    assert.equal(result.complete, false);
    assert.equal(result.clean, null);
  });
});
