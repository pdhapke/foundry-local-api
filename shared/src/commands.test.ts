// Phase 31 — shared/ previously had zero tests. Most of shared/src/*.ts is
// pure type definitions (nothing to unit-test), but every domain also
// exports a "*_COMMANDS" constant map (e.g. `META_COMMANDS`, `ACTOR_COMMANDS`)
// whose string values are the bridge protocol's wire-level command names.
//
// These maps matter at runtime, not just as types: module/src/command-registry.ts
// dispatches every inbound BridgeRequest through a single global
// `Map<string, CommandHandler>`, keyed by these exact strings
// (module/src/commands/*.ts calls `registerCommand(SOME_COMMANDS.X, handler)`
// once per command, across every domain, into that one shared map). If two
// different domains' COMMANDS maps ever produced the same string value, the
// second `registerCommand()` call would silently clobber the first domain's
// handler — a real, hard-to-notice bug class this test exists to catch
// before it ships, not just a style nit.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ACTOR_COMMANDS,
  BULK_COMMANDS,
  CANVAS_COMMANDS,
  CARDS_COMMANDS,
  CHAT_COMMANDS,
  COMBAT_COMMANDS,
  DOCUMENT_COMMANDS,
  EMBEDDED_EFFECT_COMMANDS,
  EMBEDDED_ITEM_COMMANDS,
  EMBEDDED_PLACEABLE_COMMANDS,
  FILE_COMMANDS,
  FOLDER_COMMANDS,
  JOURNAL_PAGE_COMMANDS,
  LOCALIZATION_COMMANDS,
  MACRO_COMMANDS,
  META_COMMANDS,
  PACK_COMMANDS,
  PERMISSION_COMMANDS,
  PLAYLIST_COMMANDS,
  ROLL_COMMANDS,
  ROLL_TABLE_COMMANDS,
  SCENE_COMMANDS,
  SETTINGS_COMMANDS,
  SHARED_PACKAGE_NAME,
  TOKEN_COMMANDS,
  USER_COMMANDS,
  WORLD_TIME_COMMANDS,
} from "./index.js";

/** Every "*_COMMANDS" constant map exported from shared/src/index.ts, name -> map. */
const ALL_COMMAND_MAPS: Record<string, Record<string, string>> = {
  ACTOR_COMMANDS,
  BULK_COMMANDS,
  CANVAS_COMMANDS,
  CARDS_COMMANDS,
  CHAT_COMMANDS,
  COMBAT_COMMANDS,
  DOCUMENT_COMMANDS,
  EMBEDDED_EFFECT_COMMANDS,
  EMBEDDED_ITEM_COMMANDS,
  EMBEDDED_PLACEABLE_COMMANDS,
  FILE_COMMANDS,
  FOLDER_COMMANDS,
  JOURNAL_PAGE_COMMANDS,
  LOCALIZATION_COMMANDS,
  MACRO_COMMANDS,
  META_COMMANDS,
  PACK_COMMANDS,
  PERMISSION_COMMANDS,
  PLAYLIST_COMMANDS,
  ROLL_COMMANDS,
  ROLL_TABLE_COMMANDS,
  SCENE_COMMANDS,
  SETTINGS_COMMANDS,
  TOKEN_COMMANDS,
  USER_COMMANDS,
  WORLD_TIME_COMMANDS,
};

void describe("shared command constant maps", () => {
  void it("every command map has at least one entry, all non-empty string values", () => {
    for (const [mapName, map] of Object.entries(ALL_COMMAND_MAPS)) {
      const values = Object.values(map);
      assert.ok(values.length > 0, `${mapName} should not be empty`);
      for (const value of values) {
        assert.equal(typeof value, "string", `${mapName} values should all be strings`);
        assert.ok(value.length > 0, `${mapName} should not contain empty-string command names`);
      }
    }
  });

  void it("no command map has a duplicate value within itself", () => {
    for (const [mapName, map] of Object.entries(ALL_COMMAND_MAPS)) {
      const values = Object.values(map);
      const unique = new Set(values);
      assert.equal(
        unique.size,
        values.length,
        `${mapName} has duplicate command-name values within itself: ${values.join(", ")}`,
      );
    }
  });

  void it("every command name is globally unique across every domain's map (single dispatcher namespace)", () => {
    const owner = new Map<string, string>();
    const collisions: string[] = [];

    for (const [mapName, map] of Object.entries(ALL_COMMAND_MAPS)) {
      for (const value of Object.values(map)) {
        const existingOwner = owner.get(value);
        if (existingOwner !== undefined && existingOwner !== mapName) {
          collisions.push(`"${value}" is used by both ${existingOwner} and ${mapName}`);
        } else {
          owner.set(value, mapName);
        }
      }
    }

    assert.deepEqual(collisions, [], collisions.join("; "));
  });

  void it("SHARED_PACKAGE_NAME matches the actual package.json name", () => {
    assert.equal(SHARED_PACKAGE_NAME, "@foundry-local-api/shared");
  });
});
