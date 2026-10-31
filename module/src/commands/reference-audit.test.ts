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

  void it("reports duplicate campaign IDs under any world flag key", () => {
    (globalThis as any).game.collections = new Map([
      [
        "Actor",
        new Map(
          ["a", "b"].map((id) => [
            id,
            {
              uuid: `Actor.${id}`,
              documentName: "Actor",
              toObject: () => ({ flags: { world: { exampleCampaignId: "shared" } } }),
            },
          ]),
        ),
      ],
    ]);
    const duplicate = auditReferences({}).issues.find(
      (issue) => issue.code === "DUPLICATE_STABLE_ID",
    );
    assert.equal(duplicate?.fieldPath, "flags.world.exampleCampaignId");
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

  void it("uses the collection type without touching a fragile documentName getter", () => {
    const table = {
      uuid: "RollTable.table-1",
      toObject: () => ({ results: [] }),
    } as Record<string, unknown>;
    Object.defineProperty(table, "documentName", {
      get: () => {
        throw new TypeError("Cannot read properties of null (reading 'type')");
      },
    });
    (globalThis as any).game.collections = new Map([["RollTable", new Map([["table-1", table]])]]);

    const result = auditReferences({ includeDocumentTypes: ["RollTable"] });

    assert.equal(result.scannedDocuments, 1);
    assert.equal(
      result.issues.some((issue) => issue.code === "MALFORMED_TABLE_RESULTS"),
      false,
    );
  });

  void it("reads authoritative embedded source data without touching wrapper fields", () => {
    const resultWrapper = {
      _source: {
        type: "text",
        description: "Safe text result",
        sourceReference: "@UUID[Item.none]",
      },
      siblingReference: "@UUID[Item.none]",
    } as Record<string, unknown>;
    Object.defineProperty(resultWrapper, "type", {
      enumerable: true,
      get: () => {
        throw new TypeError("Cannot read properties of null (reading 'type')");
      },
    });
    (globalThis as any).game.collections = new Map([
      [
        "RollTable",
        new Map([
          [
            "table-1",
            {
              uuid: "RollTable.table-1",
              toObject: () => ({ results: [resultWrapper] }),
            },
          ],
        ]),
      ],
    ]);

    const result = auditReferences({ includeDocumentTypes: ["RollTable"] });

    assert.equal(result.scannedDocuments, 1);
    assert.equal(
      result.issues.some((issue) => issue.code === "MALFORMED_TABLE_RESULT"),
      false,
    );
    assert.ok(
      result.issues.some(
        (issue) => issue.code === "BROKEN_UUID" && issue.fieldPath === "results.0.sourceReference",
      ),
    );
    assert.equal(
      result.issues.some((issue) => issue.fieldPath === "results.0.siblingReference"),
      false,
    );
  });

  void it("never reports a document-type-filtered scan as campaign-wide clean", () => {
    (globalThis as any).game.collections = new Map([
      ["Actor", new Map([["1", { uuid: "Actor.1", toObject: () => ({ name: "Safe" }) }]])],
    ]);

    const result = auditReferences({ includeDocumentTypes: ["Actor"] });

    assert.equal(result.scannedDocuments, 1);
    assert.equal(result.complete, false);
    assert.equal(result.clean, null);
    assert.ok(result.classes.every(({ reason }) => reason?.includes("campaign-wide coverage")));
  });

  void it("returns typed incomplete coverage when a live field getter is unreadable", () => {
    const unreadable = {} as Record<string, unknown>;
    Object.defineProperty(unreadable, "type", {
      enumerable: true,
      get: () => {
        throw new TypeError("private runtime detail");
      },
    });
    (globalThis as any).game.collections = new Map([
      [
        "RollTable",
        new Map([
          [
            "table-1",
            {
              uuid: "RollTable.table-1",
              toObject: () => ({ results: [unreadable] }),
            },
          ],
        ]),
      ],
    ]);

    const result = auditReferences({ includeDocumentTypes: ["RollTable"] });

    assert.equal(result.complete, false);
    assert.equal(result.clean, null);
    assert.ok(result.issues.some((issue) => issue.code === "DOCUMENT_AUDIT_ERROR"));
    assert.doesNotMatch(JSON.stringify(result), /private runtime detail/);
  });

  void it("fails closed on cyclic serialized data without traversing indefinitely", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    (globalThis as any).game.collections = new Map([
      ["Actor", new Map([["cyclic", { uuid: "Actor.cyclic", toObject: () => cyclic }]])],
    ]);

    const result = auditReferences({});

    assert.equal(result.complete, false);
    assert.equal(result.clean, null);
    assert.ok(result.issues.some((issue) => issue.code === "DOCUMENT_AUDIT_ERROR"));
  });

  void it("extracts asset targets from HTML and CSS wrappers without markup prefixes", () => {
    (globalThis as any).game.collections = new Map([
      [
        "JournalEntry",
        new Map([
          [
            "html",
            {
              uuid: "JournalEntry.html",
              toObject: () => ({
                content: '<img src="maps/scene.webp"><div style="url(icons/svg/d20-grey.svg)">',
              }),
            },
          ],
        ]),
      ],
    ]);

    const result = auditReferences({});
    const targets = result.issues
      .filter((issue) => issue.code === "ASSET_REQUIRES_SERVER_CHECK")
      .map((issue) => issue.target);

    assert.deepEqual(targets, ["maps/scene.webp", "icons/svg/d20-grey.svg"]);
  });

  void it("fails closed when cumulative strings exceed the per-document character budget", () => {
    const individuallyBounded = "x".repeat(1_500_000);
    (globalThis as any).game.collections = new Map([
      [
        "JournalEntry",
        new Map([
          [
            "oversized",
            {
              uuid: "JournalEntry.oversized",
              toObject: () => ({
                first: individuallyBounded,
                second: individuallyBounded,
                third: individuallyBounded,
              }),
            },
          ],
        ]),
      ],
    ]);

    const result = auditReferences({});

    assert.equal(result.complete, false);
    assert.equal(result.clean, null);
    assert.ok(result.issues.some((issue) => issue.code === "DOCUMENT_AUDIT_ERROR"));
  });
});
