import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { buildMovementEvent } from "@foundry-local-api/shared";

import { AiGmDeliveryService, UnavailableHostWakeAdapter } from "../services/ai-gm-delivery.js";
import { aiGmDeliveryEndpointDescriptors, configureAiGmDelivery } from "./ai-gm-delivery.js";

void describe("AI-GM delivery endpoints", () => {
  void it("exposes durable state and the exact unavailable-host limitation read-only", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "ai-gm-endpoint-")), "delivery.json");
    const service = new AiGmDeliveryService(path, "ai-gm-primary", { now: () => 100 });
    const event = {
      ...buildMovementEvent({
        eventId: "movement-1",
        sceneId: "scene",
        tokenId: "token",
        userId: "izzy",
        timestamp: 100,
        waypoints: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ],
        regions: [],
      }),
      sequence: 1,
    };
    const queued = service.enqueue(event, "session:1").item;
    const adapter = new UnavailableHostWakeAdapter("No host wake channel is configured.");
    configureAiGmDelivery(service, adapter);

    const listed = (await aiGmDeliveryEndpointDescriptors[0]!.handler({}, undefined as never)) as {
      consumerId: string;
      hostCapability: string;
      hostLimitation: string;
      items: Array<{ id: string }>;
    };
    assert.equal(listed.consumerId, "ai-gm-primary");
    assert.equal(listed.hostCapability, "unavailable");
    assert.match(listed.hostLimitation, /No host wake channel/);
    assert.deepEqual(
      listed.items.map((item) => item.id),
      [queued.id],
    );
    assert.ok(
      aiGmDeliveryEndpointDescriptors.every((descriptor) => descriptor.annotations?.readOnlyHint),
    );

    const fetched = (await aiGmDeliveryEndpointDescriptors[1]!.handler(
      { deliveryId: queued.id },
      undefined as never,
    )) as { id: string };
    assert.equal(fetched.id, queued.id);
    assert.throws(
      () =>
        aiGmDeliveryEndpointDescriptors[1]!.handler({ deliveryId: "missing" }, undefined as never),
      /not found/,
    );
  });
});
