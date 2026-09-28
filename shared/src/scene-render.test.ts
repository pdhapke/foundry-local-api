import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SCENE_RENDER_COMMANDS, SCENE_RENDER_LIMITS } from "./scene-render.js";

void describe("scene render contract", () => {
  void it("separates snapshot and structured visibility reads", () => {
    assert.notEqual(SCENE_RENDER_COMMANDS.SNAPSHOT, SCENE_RENDER_COMMANDS.VISIBILITY);
  });

  void it("publishes finite secrecy-safe response limits", () => {
    for (const limit of Object.values(SCENE_RENDER_LIMITS)) {
      assert.equal(Number.isSafeInteger(limit), true);
      assert.ok(limit > 0);
    }
    assert.ok(SCENE_RENDER_LIMITS.maxImageBytes <= 2_000_000);
    assert.ok(SCENE_RENDER_LIMITS.maxQueryPoints <= 500);
  });

  void it("types selected-source isolation failures without exposing source identities", () => {
    const codes = [
      "SELECTED_VISION_EVALUATION_FAILED",
      "SELECTED_VISION_ISOLATION_INCOMPLETE",
      "SELECTED_VISION_ISOLATION_UNAVAILABLE",
    ] as const;
    assert.equal(new Set(codes).size, 3);
  });
});
