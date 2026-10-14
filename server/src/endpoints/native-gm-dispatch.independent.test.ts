import assert from "node:assert/strict";
import test from "node:test";
import { dispatchNativeGm } from "./native-gm-dispatch.js";
import type { FoundryClient } from "../bridge/foundry-client.js";
import type { NativeGmApplyInput } from "@foundry-local-api/shared";

function fixture() {
  const input: NativeGmApplyInput = {
    schemaVersion: "gm-actions-v1",
    worldId: "w",
    userId: "gm",
    sceneId: "s",
    action: { kind: "review" },
    expectedState: {},
    idempotencyKey: "key",
    correlationId: "trace",
  };
  const owner = {
    clientId: "client",
    userId: "gm",
    isGM: true,
    lane: "gm",
    optedIn: true,
    connectedAt: "one",
    capabilities: ["gmReview"],
  };
  let clients = [owner],
    effects = 0,
    active = true,
    worldId = "w",
    inflight = 0,
    peak = 0;
  let behavior: () => Promise<unknown> = async () => ({
    ...input,
    outcome: "confirmed",
    before: {},
    after: { changed: true },
    data: null,
  });
  const client = {
    getCapabilityReport: () => ({ clients }),
    async call(command: string, _payload: unknown, options: Record<string, unknown>) {
      assert.equal(options.clientId, "client");
      assert.equal(options.userId, "gm");
      assert.equal(options.requestingUserId, "gm");
      if (command === "status") return { worldId, userId: "gm" };
      if (command === "user") return { isGM: true, active };
      if (options.requireDurableAudit !== undefined)
        assert.equal(options.requireDurableAudit, true);
      effects++;
      inflight++;
      peak = Math.max(peak, inflight);
      try {
        return await behavior();
      } finally {
        inflight--;
      }
    },
  } as unknown as FoundryClient;
  return {
    input,
    client,
    owner,
    counts: () => ({ effects, peak }),
    setClients: (v: typeof clients) => {
      clients = v;
    },
    setBehavior: (v: typeof behavior) => {
      behavior = v;
    },
    setActive: (v: boolean) => {
      active = v;
    },
    setWorld: (v: string) => {
      worldId = v;
    },
  };
}
void test("independent transport: duplicate GM tabs and world spoof refuse native dispatch", async () => {
  const f = fixture();
  f.setClients([f.owner, { ...f.owner, clientId: "other" }]);
  await assert.rejects(dispatchNativeGm(f.client, "gmReview", f.input, true), /One exact/);
  f.setClients([f.owner]);
  f.setWorld("wrong");
  await assert.rejects(dispatchNativeGm(f.client, "gmReview", f.input, true), /authority/);
  assert.equal(f.counts().effects, 0);
});
void test("independent transport: serialized native operations never overlap", async () => {
  const f = fixture();
  f.setBehavior(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { ...f.input, outcome: "confirmed", before: {}, after: { changed: true }, data: null };
  });
  await Promise.all([
    dispatchNativeGm(f.client, "gmReview", f.input, true),
    dispatchNativeGm(f.client, "gmReview", f.input, true),
  ]);
  assert.equal(f.counts().peak, 1);
});
void test("independent transport: timeout acknowledgement fences later mutations but preserves state reads", async () => {
  const f = fixture();
  f.setBehavior(async () => {
    throw Error("TIMEOUT");
  });
  await assert.rejects(dispatchNativeGm(f.client, "gmReview", f.input, true), /uncertain/);
  await assert.rejects(dispatchNativeGm(f.client, "gmReview", f.input, true), /uncertainty/);
  f.setBehavior(async () => ({ state: "readable" }));
  assert.deepEqual(await dispatchNativeGm(f.client, "gmReview", f.input), { state: "readable" });
  assert.equal(f.counts().effects, 2);
});
void test("independent transport: post-dispatch demotion withholds result and fences mutations", async () => {
  const f = fixture();
  f.setBehavior(async () => {
    f.setActive(false);
    return { ...f.input, outcome: "confirmed", after: {} };
  });
  await assert.rejects(dispatchNativeGm(f.client, "gmReview", f.input, true), /uncertain/);
  f.setActive(true);
  await assert.rejects(dispatchNativeGm(f.client, "gmReview", f.input, true), /uncertainty/);
  assert.equal(f.counts().effects, 1);
});
void test("independent transport: mismatched receipt scope never confirms", async () => {
  const f = fixture();
  f.setBehavior(async () => ({ ...f.input, sceneId: "secret", outcome: "confirmed", after: {} }));
  await assert.rejects(dispatchNativeGm(f.client, "gmReview", f.input, true), /uncertain/);
});
