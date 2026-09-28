import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type MovementEventPage } from "@foundry-local-api/shared";
import { MovementEventStore } from "../events/movement-event-store.js";
import {
  configureMovementEventStore,
  movementEventEndpointDescriptors,
} from "./movement-events.js";
import type { EndpointContext } from "./types.js";
afterEach(() => configureMovementEventStore(undefined));
void describe("movement endpoints", () => {
  void it("rejects spoofable manual ingestion and leaves the durable store unchanged", async () => {
    const store = new MovementEventStore(
      join(mkdtempSync(join(tmpdir(), "move-endpoint-")), "state.json"),
    );
    configureMovementEventStore(store);
    const input = {
      eventId: "event-0001",
      sceneId: "s",
      tokenId: "t",
      userId: "u",
      timestamp: 1,
      waypoints: [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
      ],
      regions: [],
    };
    const ctx = {} as EndpointContext;
    await assert.rejects(
      movementEventEndpointDescriptors[0]!.handler(input, ctx),
      (error: unknown) => (error as { code?: string }).code === "PERMISSION_DENIED",
    );
    const page = (await movementEventEndpointDescriptors[1]!.handler({}, ctx)) as MovementEventPage;
    assert.deepEqual(page.events, []);
  });
});
