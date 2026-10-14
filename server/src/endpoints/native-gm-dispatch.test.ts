import assert from "node:assert/strict";
import test from "node:test";
import { FoundryBridgeError } from "../bridge/errors.js";
import { dispatchNativeGm } from "./native-gm-dispatch.js";
import { isRoutineUncertain } from "./routine-mutation-lane.js";
import type { NativeGmApplyInput } from "@foundry-local-api/shared";

const input: NativeGmApplyInput = {
  schemaVersion: "gm-actions-v1",
  worldId: "world",
  userId: "gm",
  sceneId: "scene",
  action: {
    kind: "actor.damage",
    tokenId: "token",
    components: [{ type: "fire", value: 3 }],
    multiplier: 1,
  },
  expectedState: { hp: 20 },
  idempotencyKey: "stale-key",
  correlationId: "stale-correlation",
};
function refusal(overrides: Record<string, unknown> = {}) {
  return new FoundryBridgeError("STALE_REVISION", "Native expected state changed", {
    retryable: false,
    correlationId: input.correlationId,
    details: {
      nativeGmPreflight: "before-reservation-v1",
      gameplayDispatched: false,
      schemaVersion: input.schemaVersion,
      worldId: input.worldId,
      userId: input.userId,
      sceneId: input.sceneId,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
      ...overrides,
    },
  });
}
function fixture(error: Error) {
  let applies = 0;
  const client: any = {
    getCapabilityReport: () => ({
      clients: [
        {
          userId: "gm",
          clientId: "gm-tab",
          isGM: true,
          lane: "gm",
          optedIn: true,
          connectedAt: 1,
          capabilities: ["gmCharacterApply"],
        },
      ],
    }),
    call(command: string, payload: NativeGmApplyInput) {
      if (command === "status") return { worldId: "world", userId: "gm" };
      if (command === "user") return { isGM: true, active: true };
      if (++applies === 1) throw error;
      return { ...payload, outcome: "confirmed", before: payload.expectedState, after: { hp: 14 } };
    },
  };
  return { client, applies: () => applies };
}
void test("exact pre-reservation stale-state acknowledgement permits a fresh scoped intent without replay", async () => {
  const error = refusal(),
    f = fixture(error);
  await assert.rejects(
    dispatchNativeGm(f.client, "gmCharacterApply", input, true),
    (e) => e === error,
  );
  assert.equal(isRoutineUncertain(f.client), false);
  const next = {
    ...input,
    expectedState: { hp: 17 },
    idempotencyKey: "fresh-key",
    correlationId: "fresh-correlation",
  };
  const result: any = await dispatchNativeGm(f.client, "gmCharacterApply", next, true);
  assert.equal(result.outcome, "confirmed");
  assert.equal(f.applies(), 2);
});
void test("timeouts, generic errors and mismatched preflight provenance still fence all new mutations", async () => {
  for (const error of [
    new FoundryBridgeError("TIMEOUT", "Acknowledgement lost"),
    new FoundryBridgeError("HANDLER_ERROR", "Unknown effect outcome"),
    new FoundryBridgeError("STALE_REVISION", "Unmarked stale error"),
    refusal({ gameplayDispatched: true }),
    refusal({ worldId: "other" }),
    refusal({ idempotencyKey: "other" }),
    refusal({ correlationId: "other" }),
  ]) {
    const f = fixture(error);
    await assert.rejects(
      dispatchNativeGm(f.client, "gmCharacterApply", input, true),
      /acknowledgement uncertain/,
    );
    assert.equal(isRoutineUncertain(f.client), true);
    const next = { ...input, idempotencyKey: "new" };
    await assert.rejects(
      dispatchNativeGm(f.client, "gmCharacterApply", next, true),
      /requires reconciliation/,
    );
    assert.equal(f.applies(), 1);
  }
});
