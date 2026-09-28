import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { auditReferences } from "./reference-audit.js";
void describe("reference audit", () => {
  beforeEach(() => {
    (globalThis as any).fromUuidSync = (uuid: string) =>
      uuid === "Actor.1" ? { uuid } : undefined;
    (globalThis as any).game = {
      user: { isGM: true },
      users: new Map([
        ["gm", { isGM: true }],
        ["player", { isGM: false }],
      ]),
      collections: new Map<string, unknown>([
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
                  items: [
                    {
                      flags: { "foundry-local-api": { stableId: "embedded-dup" } },
                      parentUuid: "Actor.none",
                    },
                    { flags: { "foundry-local-api": { stableId: "embedded-dup" } } },
                  ],
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
        [
          "JournalEntry",
          new Map([
            [
              "journal-1",
              {
                uuid: "JournalEntry.journal-1",
                pages: new Map(),
                toObject: () => ({}),
              },
            ],
          ]),
        ],
        [
          "Scene",
          new Map([
            [
              "scene-1",
              {
                uuid: "Scene.scene-1",
                documentName: "Scene",
                toObject: () => ({
                  folder: "missing-folder",
                  notes: [{ entryId: "journal-1", pageId: "missing-page" }],
                  tokens: [{ actorId: "missing-actor" }],
                }),
              },
            ],
          ]),
        ],
        [
          "RollTable",
          new Map([
            [
              "table-1",
              {
                uuid: "RollTable.table-1",
                documentName: "RollTable",
                toObject: () => ({
                  results: [
                    { type: "document" },
                    {
                      type: 2,
                      documentCollection: "fixture.items",
                      documentId: "missing",
                    },
                  ],
                }),
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
    assert.ok(codes.includes("BROKEN_NOTE_PAGE"));
    assert.ok(codes.includes("BROKEN_TOKEN_ACTOR"));
    assert.ok(codes.includes("BROKEN_FOLDER"));
    assert.ok(codes.includes("BROKEN_EMBEDDED_REFERENCE"));
    assert.ok(codes.includes("MALFORMED_TABLE_RESULT"));
    assert.equal(
      result.issues.find((issue) => issue.code === "BROKEN_TABLE_RESULT")?.target,
      "Compendium.fixture.items.missing",
    );
    assert.equal(result.clean, null);
  });

  void it("fails closed when a document cannot be scanned", () => {
    (globalThis as any).game.collections = new Map([
      [
        "Actor",
        new Map([
          [
            "broken",
            {
              uuid: "Actor.broken",
              toObject: () => {
                throw new Error("secret absolute filesystem detail");
              },
            },
          ],
        ]),
      ],
    ]);
    const result = auditReferences({});
    for (const name of [
      "uuid",
      "embedded",
      "note",
      "ownership",
      "stableId",
      "tableResult",
    ] as const) {
      const coverage = result.classes.find(({ class: kind }) => kind === name);
      assert.equal(coverage?.complete, false, name);
      assert.ok(coverage?.reason, name);
      assert.doesNotMatch(coverage?.reason ?? "", /filesystem detail/);
    }
    assert.equal(result.complete, false);
    assert.equal(result.clean, null);
  });

  void it("marks UUID-dependent classes incomplete when the resolver is unavailable", () => {
    delete (globalThis as any).fromUuidSync;
    (globalThis as any).game.collections = new Map();
    const result = auditReferences({});
    for (const name of ["uuid", "embedded", "tableResult"] as const)
      assert.equal(result.classes.find(({ class: kind }) => kind === name)?.complete, false);
    assert.equal(result.clean, null);
  });
});
