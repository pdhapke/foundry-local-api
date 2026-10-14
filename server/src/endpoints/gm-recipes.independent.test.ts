import assert from "node:assert/strict";
import test from "node:test";
import { createGmRecipeEndpointDescriptors } from "./gm-recipes.js";
import { worldDocumentEndpointDescriptors } from "./world-documents.js";
import { gmSceneEndpointDescriptors } from "./gm-scene.js";
import { gmReceiptEndpointDescriptors } from "./gm-receipts.js";
import type { FoundryClient } from "../bridge/foundry-client.js";
import type { EndpointContext } from "./types.js";

function fixture() {
  let source: Record<string, unknown> = { name: "Before" },
    revision = "a".repeat(64);
  const retained = new Map<string, unknown>();
  const calls: Array<{
    command: string;
    payload: Record<string, any>;
    options?: Record<string, any>;
  }> = [];
  const owner = {
    clientId: "requester-client",
    userId: "gm",
    isGM: true,
    lane: "gm",
    optedIn: true,
    connectedAt: 1,
    capabilities: [
      "worldDocumentRead",
      "worldDocumentApply",
      "gmSceneRead",
      "gmSceneApply",
      "gmReceiptRead",
    ],
  };
  const other = { ...owner, clientId: "other-client", userId: "other-gm" };
  const foundry = {
    getCapabilityReport: () => ({ clients: [other, owner] }),
    async call(command: string, payload: Record<string, any>, options?: Record<string, any>) {
      calls.push({ command, payload, ...(options ? { options } : {}) });
      if (command === "status") return { worldId: "world", userId: options?.userId ?? "other-gm" };
      if (command === "user") return { active: true, isGM: true };
      if (command === "gmReceiptRead")
        return { status: retained.has(payload.action.idempotencyKey) ? "terminal" : "missing" };
      if (command === "gmSceneRead") return { sceneId: "scene", active: true };
      if (command === "gmSceneApply") {
        if (retained.has(payload.idempotencyKey))
          return {
            ...payload,
            before: payload.expectedState,
            after: null,
            outcome: "failure",
            data: { reservationAlreadyExists: true },
          };
        const receipt = {
          ...payload,
          before: payload.expectedState,
          after: payload.expectedState,
          outcome: "confirmed",
          data: { reservationOnly: true },
        };
        retained.set(payload.idempotencyKey, receipt);
        return receipt;
      }
      const scope = {
        worldId: "world",
        family: payload.family,
        targetId: payload.targetId,
        ...(payload.parentId ? { parentId: payload.parentId } : {}),
      };
      if (command === "worldDocumentApply") {
        source = payload.data;
        revision = "b".repeat(64);
      }
      return {
        ...scope,
        source,
        revision,
        operation: payload.operation,
        ...(command === "worldDocumentApply"
          ? {
              verified: true,
              idempotencyKey: payload.idempotencyKey,
              correlationId: payload.correlationId,
            }
          : {}),
      };
    },
  } as unknown as FoundryClient;
  const operations = [
    ...worldDocumentEndpointDescriptors,
    ...gmSceneEndpointDescriptors,
    ...gmReceiptEndpointDescriptors,
  ];
  const invoke = createGmRecipeEndpointDescriptors(operations).find(
    (d) => d.name === "foundry_gm_recipe_invoke",
  )!;
  const request = {
    schemaVersion: "gm-actions-v1",
    worldId: "world",
    userId: "gm",
    sceneId: "scene",
    recipeId: "native-document-preparation",
    idempotencyKey: "doc-recipe",
    correlationId: "doc-recipe",
    expectedInitialState: {
      worldId: "world",
      family: "journals",
      targetId: "story",
      source: { name: "Before" },
      revision,
    },
    steps: [
      {
        stepId: "update",
        action: {
          family: "journals",
          targetId: "story",
          operation: "update",
          data: { name: "After" },
        },
      },
    ],
  };
  return { request, calls, invoke, operations, ctx: { foundryClient: foundry } as EndpointContext };
}
void test("independent: specialized document recipe binds native reads/writes to the exact requesting GM client", async () => {
  const { request, calls, invoke, ctx } = fixture();
  const result = await invoke.handler(request, ctx);
  assert.equal(result.outcome, "confirmed");
  const documents = calls.filter((c) => c.command.startsWith("worldDocument"));
  assert.ok(documents.length >= 3);
  for (const call of documents) {
    assert.equal(
      call.options?.clientId,
      "requester-client",
      "document dispatch must not select another default GM client",
    );
    assert.equal(call.options?.userId, "gm");
    assert.equal(call.options?.lane, "gm");
  }
  assert.equal(
    documents.find((c) => c.command === "worldDocumentApply")?.options?.requireDurableAudit,
    true,
  );
});
void test("independent: specialized recipe rejects supplied alternate requester and security patches before native dispatch", async () => {
  for (const patch of [
    { requestingUserId: "other-gm" },
    { data: { "ownership.default": 3 } },
    { data: { flags: { dnd5e: { script: "run" } } } },
    { family: "scene-tokens", parentId: "other-scene" },
  ]) {
    const { request, calls, invoke, ctx } = fixture();
    request.steps[0]!.action = {
      ...request.steps[0]!.action,
      ...patch,
    } as (typeof request.steps)[0]["action"];
    await assert.rejects(async () => invoke.handler(request, ctx));
    assert.equal(calls.length, 0);
  }
});
void test("independent: fresh document recipe transport cannot repeat a no-op update then resume later mutation", async () => {
  const f = fixture();
  const original = f.ctx.foundryClient.call.bind(f.ctx.foundryClient);
  let applies = 0;
  const native = f.ctx.foundryClient as unknown as { call: (...args: any[]) => Promise<any> };
  native.call = async (command, payload, options) => {
    if (command !== "worldDocumentApply") return original(command, payload, options);
    applies++;
    if (applies === 2) throw Error("Second stage acknowledgement lost");
    const readback = (await original(
      "worldDocumentRead",
      { ...payload, operation: "get" },
      options,
    )) as Record<string, unknown>;
    return {
      ...readback,
      operation: "update",
      verified: true,
      idempotencyKey: payload.idempotencyKey,
      correlationId: payload.correlationId,
    };
  };
  f.request.steps[0]!.action.data = { name: "Before" };
  f.request.steps.push({ stepId: "later-stage", action: { ...f.request.steps[0]!.action } });
  assert.equal((await f.invoke.handler(f.request, f.ctx)).outcome, "uncertain");
  assert.equal(applies, 2);
  const fresh = createGmRecipeEndpointDescriptors(f.operations).find(
    (d) => d.name === "foundry_gm_recipe_invoke",
  )!;
  const newClient = { ...f.ctx.foundryClient, call: native.call } as FoundryClient;
  const restarted = await fresh.handler(f.request, { ...f.ctx, foundryClient: newClient });
  assert.equal(
    restarted.outcome,
    "uncertain",
    "fresh transport requires durable reconciliation before continuing original intent",
  );
  assert.equal(applies, 2, "must not redispatch previously reserved native document steps");
});
void test("independent: simultaneous fresh recipe transports admit only one native no-op mutation", async () => {
  const f = fixture();
  const original = f.ctx.foundryClient.call.bind(f.ctx.foundryClient);
  let applies = 0,
    lookups = 0;
  let admit!: () => void;
  const bothLookups = new Promise<void>((resolve) => {
    admit = resolve;
  });
  const call = async (
    command: string,
    payload: Record<string, any>,
    options?: Record<string, any>,
  ) => {
    if (command === "gmReceiptRead") {
      if (++lookups === 2) admit();
      await bothLookups;
      return { status: "missing" };
    }
    if (command !== "worldDocumentApply") return original(command, payload, options);
    applies++;
    const readback = (await original(
      "worldDocumentRead",
      { ...payload, operation: "get" },
      options,
    )) as Record<string, unknown>;
    return {
      ...readback,
      operation: "update",
      verified: true,
      idempotencyKey: payload.idempotencyKey,
      correlationId: payload.correlationId,
    };
  };
  f.request.steps[0]!.action.data = { name: "Before" };
  const results = await Promise.all(
    [0, 1].map(async () => {
      const invoke = createGmRecipeEndpointDescriptors(f.operations).find(
        (d) => d.name === "foundry_gm_recipe_invoke",
      )!;
      const client = { ...f.ctx.foundryClient, call } as unknown as FoundryClient;
      return invoke.handler(f.request, { ...f.ctx, foundryClient: client });
    }),
  );
  assert.equal(
    applies,
    1,
    "an already admitted native recipe marker must not authorize another workflow dispatcher",
  );
  assert.deepEqual(results.map((r) => r.outcome).sort(), ["confirmed", "uncertain"]);
});
