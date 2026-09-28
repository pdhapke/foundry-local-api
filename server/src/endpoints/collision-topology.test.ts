import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COLLISION_COMMANDS } from "@foundry-local-api/shared";
import { collisionTopologyEndpointDescriptors } from "./collision-topology.js";
import type { EndpointContext } from "./types.js";
void describe("collision endpoints", () => {
  void it("route exact typed commands as read-only", async () => {
    const calls: string[] = [];
    const ctx = {
      foundryClient: {
        call: (name: string) => {
          calls.push(name);
          return Promise.resolve({});
        },
      },
    } as unknown as EndpointContext;
    await collisionTopologyEndpointDescriptors[0]!.handler(
      {
        sceneId: "s",
        tokenId: "t",
        waypoints: [{ x: 1, y: 1 }],
        movementMode: "walk",
        simulatedDoors: { a: "barred", b: "sealed" },
      },
      ctx,
    );
    await collisionTopologyEndpointDescriptors[1]!.handler({ sceneId: "s" }, ctx);
    assert.deepEqual(calls, [
      COLLISION_COMMANDS.VALIDATE_PATH,
      COLLISION_COMMANDS.VALIDATE_TOPOLOGY,
    ]);
    assert.ok(collisionTopologyEndpointDescriptors.every((d) => d.annotations?.readOnlyHint));
  });
});
