import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { buildLiveMovementEvent } from "./movement-events.js";
const saved = Object.getOwnPropertyDescriptor(globalThis, "game");
afterEach(() =>
  saved
    ? Object.defineProperty(globalThis, "game", saved)
    : Reflect.deleteProperty(globalThis, "game"),
);
void describe("movement event command", () => {
  void it("derives transitions from full segments without mutation", () => {
    const token = { id: "t", toObject: () => ({ _id: "t" }) };
    const scene = { id: "s", getEmbeddedCollection: () => new Map([["t", token]]) };
    Object.defineProperty(globalThis, "game", {
      configurable: true,
      value: { collections: new Map([["Scene", new Map([["s", scene]])]]) },
    });
    const result = buildLiveMovementEvent({
      eventId: "e",
      sceneId: "s",
      tokenId: "t",
      userId: "u",
      timestamp: 1,
      waypoints: [
        { x: 0, y: 1 },
        { x: 10, y: 1 },
      ],
      regions: [
        {
          id: "thin",
          polygons: [
            [
              { x: 4, y: 0 },
              { x: 5, y: 0 },
              { x: 5, y: 2 },
              { x: 4, y: 2 },
            ],
          ],
        },
      ],
    });
    assert.deepEqual(
      result.transitions.map((x) => x.kind),
      ["enter", "exit"],
    );
  });
});
