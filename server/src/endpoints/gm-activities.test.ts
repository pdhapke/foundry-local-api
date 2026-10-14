import assert from "node:assert/strict";
import test from "node:test";
import {
  gmActivitiesEndpointDescriptors,
  gmActivityApplySchema,
  gmActivityReadSchema,
} from "./gm-activities.js";
import type { FoundryClient } from "../bridge/foundry-client.js";
import type { GmActivityInput } from "@foundry-local-api/shared";

const input: GmActivityInput = {
  schemaVersion: "gm-actions-v1",
  worldId: "world",
  userId: "gm",
  sceneId: "scene",
  action: {
    mode: "use",
    tokenId: "source",
    actorId: "actor",
    itemId: "item",
    activityId: "activity",
    targetTokenIds: ["target"],
    rulesDecisions: [
      {
        targetTokenId: "target",
        decisionId: "ruling",
        edition: "2024",
        range: "in-range",
        reach: "not-applicable",
        lineOfEffect: true,
        cover: "none",
        reason: "GM measured",
      },
    ],
    advantage: "normal",
    rollMode: "gmroll",
    spellSlot: "spell1",
  },
};
function client() {
  const calls: { command: string; input: unknown; options: unknown }[] = [];
  const connection = {
    clientId: "gm-client",
    connectedAt: 1,
    userId: "gm",
    isGM: true,
    optedIn: true,
    lane: "gm",
    capabilities: ["gmActivitiesRead", "gmActivitiesApply"],
  };
  const fake = {
    getCapabilityReport: () => ({ clients: [connection] }),
    async call(command: string, value: any, options: unknown) {
      calls.push({ command, input: value, options });
      if (command === "status") return { worldId: "world", userId: "gm" };
      if (command === "user") return { isGM: true, active: true };
      if (command === "gmActivitiesRead") return { resources: { spell1: 1 } };
      return {
        schemaVersion: value.schemaVersion,
        worldId: value.worldId,
        userId: value.userId,
        sceneId: value.sceneId,
        idempotencyKey: value.idempotencyKey,
        correlationId: value.correlationId,
        outcome: "confirmed",
        before: value.expectedState,
        after: { resources: { spell1: 0 } },
        data: { messageId: "native-use" },
      };
    },
  };
  return { fake: fake as unknown as FoundryClient, calls, connection };
}
void test("activity tool schemas expose strict bounded native activation decisions", () => {
  assert.equal(gmActivityReadSchema.safeParse(input).success, true);
  assert.equal(
    gmActivityReadSchema.safeParse({ ...input, action: { ...input.action, consume: false } })
      .success,
    false,
  );
  assert.equal(
    gmActivityApplySchema.safeParse({
      ...input,
      expectedState: {},
      idempotencyKey: "once",
      correlationId: "trace",
    }).success,
    true,
  );
  assert.equal(
    gmActivityReadSchema.safeParse({
      ...input,
      action: { ...input.action, targetTokenIds: Array(17).fill("target") },
    }).success,
    false,
  );
  assert.deepEqual(
    gmActivitiesEndpointDescriptors.map((d) => d.name),
    ["foundry_gm_activity_state", "foundry_gm_activity_apply"],
  );
});
void test("both generic MCP/REST descriptors dispatch exact negotiated GM native commands", async () => {
  const f = client(),
    read = gmActivitiesEndpointDescriptors[0]!,
    apply = gmActivitiesEndpointDescriptors[1]!;
  const state = await read.handler(input, { foundryClient: f.fake });
  const receipt = await apply.handler(
    { ...input, expectedState: state, idempotencyKey: "once", correlationId: "trace" },
    { foundryClient: f.fake },
  );
  assert.equal(receipt.outcome, "confirmed");
  const calls = f.calls.filter((c) => c.command.startsWith("gmActivities"));
  assert.deepEqual(
    calls.map((c) => c.command),
    ["gmActivitiesRead", "gmActivitiesApply"],
  );
  for (const call of calls)
    assert.equal((call.options as Record<string, unknown>)["clientId"], "gm-client");
  assert.equal((calls[1]!.options as Record<string, unknown>)["requireDurableAudit"], true);
});
void test("TV/player negotiated clients cannot acquire native GM activity authority", async () => {
  const f = client();
  f.connection.isGM = false;
  await assert.rejects(
    gmActivitiesEndpointDescriptors[1]!.handler(
      { ...input, expectedState: {}, idempotencyKey: "once", correlationId: "trace" },
      { foundryClient: f.fake },
    ),
    /native GM client/,
  );
  assert.equal(f.calls.length, 0);
});
void test("generic activity schemas expose explicit placement and exact held phases", () => {
  const placements = {
    placements: [{ x: 100, y: 100, direction: 0 }],
    ruling: "GM explicit native geometry",
  };
  assert.equal(
    gmActivityReadSchema.safeParse({ ...input, action: { ...input.action, template: placements } })
      .success,
    true,
  );
  assert.equal(
    gmActivityReadSchema.safeParse({
      ...input,
      action: {
        ...input.action,
        summon: {
          profileId: "wolf",
          actorId: "wolf",
          placements: [{ x: 100, y: 100, elevation: 0, rotation: 0 }],
          ruling: "GM actual native profile",
        },
      },
    }).success,
    true,
  );
  assert.equal(
    gmActivityReadSchema.safeParse({
      ...input,
      action: {
        ...input.action,
        phase: "ready",
        ready: { choiceId: "held", trigger: "Enemy moves", ruling: "GM adjudication" },
        targetTokenIds: [],
        rulesDecisions: [],
        concentration: { begin: true },
      },
    }).success,
    true,
  );
  assert.equal(
    gmActivityReadSchema.safeParse({
      ...input,
      action: {
        ...input.action,
        phase: "release",
        release: { readyId: "held", castReceipt: "original-cast" },
      },
    }).success,
    true,
  );
  assert.equal(
    gmActivityReadSchema.safeParse({ ...input, action: { ...input.action, phase: "release" } })
      .success,
    false,
  );
  assert.equal(
    gmActivityReadSchema.safeParse({
      ...input,
      action: {
        ...input.action,
        phase: "ready",
        ready: { choiceId: "held", trigger: "Enemy moves", ruling: "GM adjudication" },
      },
    }).success,
    false,
  );
  assert.equal(
    gmActivityReadSchema.safeParse({
      ...input,
      action: { ...input.action, template: { ...placements, ownership: { default: 3 } } },
    }).success,
    false,
  );
});
