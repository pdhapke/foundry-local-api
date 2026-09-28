import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { findAssetReferences } from "./asset-lifecycle.js";

void describe("asset references", () => {
  beforeEach(() => {
    (globalThis as any).game = {
      collections: new Map([
        [
          "Scene",
          new Map([
            [
              "1",
              {
                uuid: "Scene.1",
                toObject: () => ({
                  background: { src: "assets/test.png" },
                  name: "safe scene",
                  journalHtml: '<img src="assets/test.png">',
                }),
              },
            ],
          ]),
        ],
      ]),
    };
  });
  void it("finds direct and HTML-embedded world asset references", () =>
    assert.deepEqual(findAssetReferences({ path: "assets/test.png" }).references, [
      { documentUuid: "Scene.1", fieldPath: "background.src" },
      { documentUuid: "Scene.1", fieldPath: "journalHtml" },
    ]));
});
