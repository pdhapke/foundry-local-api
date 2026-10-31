import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { EFFECTIVE_USER_COMMANDS } from "@foundry-local-api/shared";

import { dispatch } from "../command-registry.js";
import { executeEffectiveUserOperation } from "./effective-user.js";

const savedGame = Object.getOwnPropertyDescriptor(globalThis, "game");
const player = { id: "player-1", name: "Player", isGM: false };

function setGame(collections: Map<string, Map<string, unknown>>, user = player): void {
  Object.defineProperty(globalThis, "game", {
    configurable: true,
    writable: true,
    value: { user, collections },
  });
}

function document(
  id: string,
  source: Record<string, unknown>,
  permissions: Partial<Record<"OBSERVER" | "OWNER", boolean>>,
) {
  const current = structuredClone(source);
  return {
    id,
    toObject: () => structuredClone(current),
    update: (changes: Record<string, unknown>) => {
      if (Object.hasOwn(changes, "flags.foundry-local-api.ownerActionProbe")) {
        const flags = (current.flags ??= {}) as Record<string, unknown>;
        const moduleFlags = (flags["foundry-local-api"] ??= {}) as Record<string, unknown>;
        moduleFlags.ownerActionProbe = changes["flags.foundry-local-api.ownerActionProbe"];
      }
      return Promise.resolve();
    },
    testUserPermission: (_user: unknown, level: "OBSERVER" | "OWNER") =>
      permissions[level] === true,
  };
}

function sceneFixture(
  tokens: Map<string, unknown> = new Map(),
  notes: Map<string, unknown> = new Map(),
) {
  return {
    ...document("scene-1", { _id: "scene-1", name: "Fixture Scene" }, { OBSERVER: true }),
    getEmbeddedCollection: (type: string) => (type === "Token" ? tokens : notes),
  };
}

const base = (operation: Record<string, unknown>) => ({
  requestingUserId: "gm-1",
  effectiveUserId: "player-1",
  operation,
});

afterEach(() => {
  if (savedGame) Object.defineProperty(globalThis, "game", savedGame);
  else Reflect.deleteProperty(globalThis, "game");
});

void describe("effective-user player command", () => {
  void it("proves Actor OWNER control without exposing actor system data", async () => {
    const actor = document(
      "actor-1",
      { name: "Fixture Actor", system: { biography: "private" }, ownership: { secret: 3 } },
      { OBSERVER: true, OWNER: true },
    );
    setGame(new Map([["Actor", new Map([["actor-1", actor]])]]));
    const result = await executeEffectiveUserOperation(
      base({ kind: "inspectActorControl", actorId: "actor-1" }) as never,
    );
    assert.equal(result.data.kind, "actorControl");
    if (result.data.kind !== "actorControl") assert.fail("Expected actorControl result.");
    assert.equal(result.data.actorId, "actor-1");
    assert.equal(result.data.name, "Fixture Actor");
    assert.equal(result.data.canObserve, true);
    assert.equal(result.data.canControl, true);
    assert.match(result.data.revision, /^[a-f0-9]{64}$/);
    assert.equal(result.permissionDecision.requiredPermission, "OWNER");
    assert.deepEqual(result.mutationIds, []);
    assert.equal(JSON.stringify(result).includes("private"), false);
  });

  void it("applies a fixture-only OWNER action and independently reads it back", async () => {
    const actor = document(
      "actor-1",
      {
        name: "Fixture Actor",
        flags: { "foundry-local-api": { testRunId: "test-owner-action-0001" } },
      },
      { OBSERVER: true, OWNER: true },
    );
    setGame(new Map([["Actor", new Map([["actor-1", actor]])]]));
    const inspected = await executeEffectiveUserOperation(
      base({ kind: "inspectActorControl", actorId: "actor-1" }) as never,
    );
    assert.equal(inspected.data.kind, "actorControl");
    if (inspected.data.kind !== "actorControl") assert.fail("Expected actorControl result.");
    const applied = await executeEffectiveUserOperation(
      base({
        kind: "applyActorOwnerProbe",
        actorId: "actor-1",
        testRunId: "test-owner-action-0001",
        probeValue: "player-applied",
        expectedRevision: inspected.data.revision,
      }) as never,
    );
    assert.equal(applied.data.kind, "actorOwnerProbe");
    if (applied.data.kind !== "actorOwnerProbe") assert.fail("Expected actorOwnerProbe result.");
    assert.equal(applied.data.afterValue, "player-applied");
    assert.equal(applied.data.readbackVerified, true);
    assert.deepEqual(applied.mutationIds, ["actor-1"]);
  });

  void it("denies Actor control without OWNER permission", async () => {
    setGame(
      new Map([
        [
          "Actor",
          new Map([["actor-1", document("actor-1", { name: "Visible" }, { OBSERVER: true })]]),
        ],
      ]),
    );
    await assert.rejects(
      executeEffectiveUserOperation(
        base({ kind: "inspectActorControl", actorId: "actor-1" }) as never,
      ),
      (error: unknown) => (error as { code?: string }).code === "PERMISSION_DENIED",
    );
  });

  void it("reads only player-visible Journal pages and denies a GM-only Journal", async () => {
    const visiblePage = document(
      "page-visible",
      {
        name: "Public",
        type: "text",
        text: {
          format: 1,
          content: 'Player-safe content<section class="secret">SECRET-IN-VISIBLE-PAGE</section>',
        },
      },
      { OBSERVER: true },
    );
    const secretPage = document(
      "page-secret",
      { name: "GM Secret", type: "text", text: { format: 1, content: "SECRET-NEVER-RETURN" } },
      {},
    );
    const publicJournal = {
      ...document("journal-public", { name: "Player Journal" }, { OBSERVER: true }),
      pages: new Map([
        ["page-visible", visiblePage],
        ["page-secret", secretPage],
      ]),
    };
    const gmJournal = {
      ...document("journal-gm", { name: "GM Journal" }, {}),
      pages: new Map([["page-secret", secretPage]]),
    };
    setGame(
      new Map([
        [
          "JournalEntry",
          new Map([
            ["journal-public", publicJournal],
            ["journal-gm", gmJournal],
          ]),
        ],
      ]),
    );
    const result = await executeEffectiveUserOperation(
      base({ kind: "readJournalContent", journalEntryId: "journal-public" }) as never,
    );
    assert.equal(result.data.kind, "journalContent");
    if (result.data.kind === "journalContent") {
      assert.deepEqual(
        result.data.pages.map(({ pageId }) => pageId),
        ["page-visible"],
      );
      assert.equal(result.data.pages[0]?.content, "Player-safe content");
    }
    assert.equal(JSON.stringify(result).includes("SECRET-NEVER-RETURN"), false);
    assert.equal(JSON.stringify(result).includes("SECRET-IN-VISIBLE-PAGE"), false);
    await assert.rejects(
      executeEffectiveUserOperation(
        base({ kind: "readJournalContent", journalEntryId: "journal-gm" }) as never,
      ),
      (error: unknown) => (error as { code?: string }).code === "NOT_FOUND",
    );
  });

  void it("reports Scene Token control and bounded vision from the player context", async () => {
    const actor = document("actor-1", { name: "Actor" }, { OBSERVER: true, OWNER: true });
    const token = document(
      "token-1",
      {
        name: "Test Hero",
        actorId: "actor-1",
        hidden: false,
        x: 100,
        y: 200,
        elevation: 5,
        sight: { enabled: true, range: 60, angle: 270, visionMode: "darkvision" },
        actorData: { secret: "do-not-leak" },
      },
      { OBSERVER: true },
    );
    setGame(
      new Map([
        ["Actor", new Map([["actor-1", actor]])],
        ["Scene", new Map([["scene-1", sceneFixture(new Map([["token-1", token]]))]])],
      ]),
    );
    const result = await executeEffectiveUserOperation(
      base({ kind: "inspectSceneToken", sceneId: "scene-1", tokenId: "token-1" }) as never,
    );
    assert.deepEqual(result.data, {
      kind: "sceneToken",
      sceneId: "scene-1",
      tokenId: "token-1",
      name: "Test Hero",
      actorId: "actor-1",
      canObserve: true,
      canControl: true,
      hidden: false,
      position: { x: 100, y: 200, elevation: 5 },
      vision: { enabled: true, range: 60, angle: 270, mode: "darkvision" },
    });
    assert.equal(JSON.stringify(result).includes("do-not-leak"), false);

    const hiddenToken = document(
      "token-hidden",
      { name: "GM Token", actorId: "actor-1", hidden: true, sight: { enabled: true } },
      { OBSERVER: true, OWNER: true },
    );
    setGame(
      new Map([
        ["Actor", new Map([["actor-1", actor]])],
        ["Scene", new Map([["scene-1", sceneFixture(new Map([["token-hidden", hiddenToken]]))]])],
      ]),
    );
    await assert.rejects(
      executeEffectiveUserOperation(
        base({ kind: "inspectSceneToken", sceneId: "scene-1", tokenId: "token-hidden" }) as never,
      ),
      (error: unknown) => (error as { code?: string }).code === "NOT_FOUND",
    );
  });

  void it("inspects an exact embedded Note only when its linked Journal/Page are visible", async () => {
    const page = document("page-1", { name: "Public Page" }, { OBSERVER: true });
    const journal = {
      ...document("journal-1", { name: "Public Journal" }, { OBSERVER: true }),
      pages: new Map([["page-1", page]]),
    };
    const note = document(
      "note-1",
      { entryId: "journal-1", pageId: "page-1", x: 12, y: 34, hidden: false, text: "secret" },
      { OBSERVER: true },
    );
    setGame(
      new Map<string, Map<string, unknown>>([
        ["JournalEntry", new Map<string, unknown>([["journal-1", journal]])],
        [
          "Scene",
          new Map<string, unknown>([
            ["scene-1", sceneFixture(new Map(), new Map([["note-1", note]]))],
          ]),
        ],
      ]),
    );
    const result = await executeEffectiveUserOperation(
      base({ kind: "inspectNoteAccess", sceneId: "scene-1", noteId: "note-1" }) as never,
    );
    assert.deepEqual(result.data, {
      kind: "noteAccess",
      sceneId: "scene-1",
      noteId: "note-1",
      journalEntryId: "journal-1",
      pageId: "page-1",
      canObserve: true,
      hidden: false,
      position: { x: 12, y: 34 },
    });
    assert.equal(JSON.stringify(result).includes("secret"), false);

    const hiddenNote = document(
      "note-hidden",
      { entryId: "journal-1", pageId: "page-1", hidden: true, text: "GM-ONLY-NOTE" },
      { OBSERVER: true },
    );
    setGame(
      new Map<string, Map<string, unknown>>([
        ["JournalEntry", new Map<string, unknown>([["journal-1", journal]])],
        [
          "Scene",
          new Map<string, unknown>([
            ["scene-1", sceneFixture(new Map(), new Map([["note-hidden", hiddenNote]]))],
          ]),
        ],
      ]),
    );
    await assert.rejects(
      executeEffectiveUserOperation(
        base({ kind: "inspectNoteAccess", sceneId: "scene-1", noteId: "note-hidden" }) as never,
      ),
      (error: unknown) => (error as { code?: string }).code === "NOT_FOUND",
    );
  });

  void it("refuses GM escalation and arbitrary operation injection with typed errors", async () => {
    setGame(new Map(), { id: "gm-1", name: "GM", isGM: true });
    await assert.rejects(
      executeEffectiveUserOperation({
        requestingUserId: "gm-1",
        effectiveUserId: "gm-1",
        operation: { kind: "inspectActorControl", actorId: "actor-1" },
      }),
      (error: unknown) => (error as { code?: string }).code === "PERMISSION_DENIED",
    );
    setGame(new Map());
    const response = await dispatch({
      id: "request-1",
      type: EFFECTIVE_USER_COMMANDS.EXECUTE,
      payload: base({ kind: "runJavaScript", source: "game.user.update({role:4})" }),
    });
    assert.equal(response.ok, false);
    if (!response.ok) {
      assert.equal(response.error.code, "INVALID_PAYLOAD");
      assert.equal(response.error.fieldPath, "operation.kind");
    }
  });
});
