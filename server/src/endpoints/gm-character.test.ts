import assert from "node:assert/strict";
import test from "node:test";
import {
  gmCharacterEndpointDescriptors,
  gmCharacterApplySchema,
  gmCharacterReadSchema,
} from "./gm-character.js";

const input = {
  schemaVersion: "gm-actions-v1" as const,
  worldId: "world",
  userId: "gm",
  sceneId: "scene",
  action: {
    kind: "actor.check",
    tokenId: "token",
    check: "skill",
    key: "prc",
    rollMode: "blindroll",
    advantageMode: "normal",
  },
};
void test("character MCP and REST descriptors use the same exact authenticated native commands", async () => {
  const calls: any[] = [];
  const client: any = {
    getCapabilityReport: () => ({
      clients: [
        {
          userId: "gm",
          clientId: "tab",
          isGM: true,
          lane: "gm",
          optedIn: true,
          connectedAt: 1,
          capabilities: ["gmCharacterRead", "gmCharacterApply"],
        },
      ],
    }),
    call(command: string, payload: any, options: any) {
      calls.push({ command, payload, options });
      return command === "status"
        ? { worldId: "world", userId: "gm" }
        : command === "user"
          ? { isGM: true, active: true }
          : { hp: { value: 8 } };
    },
  };
  const read = gmCharacterEndpointDescriptors.find((d) => d.name === "foundry_gm_character_state")!;
  assert.equal(read.method, "post");
  assert.equal(read.path, "/gm/character/state");
  assert.equal(read.annotations?.readOnlyHint, true);
  assert.deepEqual(
    await read.handler(gmCharacterReadSchema.parse(input), { foundryClient: client }),
    { hp: { value: 8 } },
  );
  const dispatch = calls.find((c) => c.command === "gmCharacterRead");
  assert.equal(dispatch.options.userId, "gm");
  assert.equal(dispatch.options.clientId, "tab");
  assert.deepEqual(dispatch.payload, input);
});
void test("character schemas reject arbitrary document patches, impossible components and unconfirmed human decisions", () => {
  const apply = {
    ...input,
    expectedState: { hp: { value: 8 } },
    idempotencyKey: "request",
    correlationId: "request",
  };
  assert.equal(gmCharacterApplySchema.safeParse(apply).success, true);
  for (const action of [
    { ...input.action, system: { attributes: { hp: { value: 999 } } } },
    {
      kind: "actor.damage",
      tokenId: "token",
      components: [{ type: "fire", value: -1 }],
      multiplier: 1,
    },
    {
      kind: "actor.damage",
      tokenId: "token",
      components: [{ type: "fire", value: 3 }],
      multiplier: 0.25,
    },
    { kind: "actor.rest", tokenId: "token", restType: "long", eligibilityConfirmed: false },
    { kind: "actor.stabilize", tokenId: "token", rulingConfirmed: false },
    {
      kind: "actor.item.attune",
      tokenId: "token",
      itemId: "item",
      attuned: true,
      eligibilityConfirmed: false,
    },
    { kind: "actor.xp", tokenId: "token", value: -1 },
    { kind: "actor.hp.tempmax", tokenId: "token", value: 100001 },
    { kind: "actor.item.remove", tokenId: "token" },
    {
      kind: "actor.item.copy",
      tokenId: "token",
      sourceItemId: "item",
      grantItemId: "CopiedPotion0001",
      quantity: 1,
    },
    {
      kind: "actor.effect.duration",
      tokenId: "token",
      effectId: "effect",
      duration: { seconds: 1, rounds: 1 },
    },
    {
      kind: "actor.item.grant",
      tokenId: "token",
      sourceItemId: "source",
      grantItemId: "short",
      quantity: 1,
    },
    { kind: "party.roster" },
  ])
    assert.equal(
      gmCharacterApplySchema.safeParse({ ...apply, action }).success,
      false,
      JSON.stringify(action),
    );
  assert.equal(
    gmCharacterReadSchema.safeParse({ ...input, action: { kind: "party.roster" } }).success,
    true,
  );
});
void test("character apply authenticates a live opted-in GM and validates returned receipt scope", async () => {
  let gameplayCalls = 0;
  const apply = {
    ...input,
    expectedState: { hp: { value: 8 } },
    idempotencyKey: "request",
    correlationId: "request",
  };
  const descriptor = gmCharacterEndpointDescriptors.find(
    (d) => d.name === "foundry_gm_character_apply",
  )!;
  const client: any = {
    getCapabilityReport: () => ({
      clients: [
        {
          userId: "gm",
          clientId: "tab",
          isGM: true,
          lane: "gm",
          optedIn: true,
          connectedAt: 1,
          capabilities: ["gmCharacterApply"],
        },
      ],
    }),
    call(command: string) {
      if (command === "status") return { worldId: "world", userId: "gm" };
      if (command === "user") return { isGM: true, active: true };
      gameplayCalls++;
      return {
        ...apply,
        outcome: "confirmed",
        before: apply.expectedState,
        after: { hp: { value: 8 } },
        data: { total: 17 },
      };
    },
  };
  assert.equal((await descriptor.handler(apply, { foundryClient: client })).outcome, "confirmed");
  assert.equal(gameplayCalls, 1);
  const denied: any = {
    getCapabilityReport: () => ({ clients: [] }),
    call: () => {
      throw Error("must not dispatch");
    },
  };
  await assert.rejects(
    descriptor.handler(apply, { foundryClient: denied }),
    /exact opted-in native GM/,
  );
});
