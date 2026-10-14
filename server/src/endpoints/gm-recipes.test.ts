import { test } from "node:test";
import assert from "node:assert/strict";
import { createGmRecipeEndpointDescriptors, gmRecipeInvokeSchema } from "./gm-recipes.js";
import type { AnyEndpointDescriptor, EndpointContext } from "./types.js";
type CatalogResult = { recipes: { id: string; markedForLookup: boolean }[] };
type RecipeResult = { outcome: string; receipts: { receipt: { idempotencyKey: string } }[] };
function reservationFixture() {
  const retained = new Map<string, string>();
  const operations: AnyEndpointDescriptor[] = [
    {
      name: "foundry_gm_receipt_read",
      description: "durable lookup",
      handler: (args) => ({ status: retained.get(args.action.idempotencyKey) ?? "missing" }),
    },
    {
      name: "foundry_gm_scene_state",
      description: "journal-only state",
      handler: () => ({ sceneId: "scene", active: true }),
    },
    {
      name: "foundry_gm_scene_apply",
      description: "journal-only reservation",
      handler: (args) => {
        assert.equal(args.action.kind, "recipe.reservation");
        assert.match(args.action.requestFingerprint, /^[a-f0-9]{64}$/);
        retained.set(args.idempotencyKey, "terminal");
        return {
          ...args,
          outcome: "confirmed",
          before: args.expectedState,
          after: args.expectedState,
          data: { reservationOnly: true },
        };
      },
    },
  ];
  return { retained, operations };
}

function fixture(
  options: { fail?: number; uncertain?: number; mismatch?: boolean; changed?: boolean } = {},
) {
  let value = 0,
    applies = 0,
    reads = 0;
  const operations: AnyEndpointDescriptor[] = [
    {
      name: "foundry_gm_receipt_read",
      description: "receipt",
      handler: () => ({ status: "missing" }),
    },
    {
      name: "foundry_gm_character_state",
      description: "state",
      handler: () => {
        reads++;
        return { value };
      },
    },
    {
      name: "foundry_gm_character_apply",
      description: "apply",
      handler: (input) => {
        applies++;
        const before = { value };
        if (options.fail === applies)
          return { ...input, before, after: null, outcome: "failure", data: null };
        value++;
        const after = { value };
        return {
          ...input,
          before,
          after,
          outcome: options.uncertain === applies ? "uncertain" : "confirmed",
          data: null,
          ...(options.mismatch ? { userId: "other" } : {}),
        };
      },
    },
  ];
  if (options.changed) value = 2;
  const tools = createGmRecipeEndpointDescriptors(operations);
  const ctx = { foundryClient: {} } as EndpointContext;
  const run = (name: string, input: unknown) => {
    const descriptor = tools.find((d) => d.name === name)!;
    return descriptor.handler(descriptor.inputSchema!.parse(input), ctx);
  };
  return { run, calls: () => ({ applies, reads, value }), ctx, tools };
}
const input = {
  schemaVersion: "gm-actions-v1",
  worldId: "world",
  userId: "gm",
  sceneId: "scene",
  recipeId: "inventory-rewards",
  idempotencyKey: "request",
  correlationId: "correlation",
  expectedInitialState: { value: 0 },
  steps: [
    {
      stepId: "grant",
      action: { kind: "actor.currency", tokenId: "pc", denomination: "gp", value: 1 },
    },
    {
      stepId: "equip",
      action: { kind: "actor.item.equip", tokenId: "pc", itemId: "sword", equipped: true },
    },
  ],
};
void test("catalog list/search/read exposes bounded marked recipes and exact required tools", async () => {
  const f = fixture();
  const list = (await f.run("foundry_gm_recipe_list", {})) as CatalogResult;
  assert(list.recipes.some((r) => r.id === "tv-camera-vision"));
  assert(list.recipes.some((r) => r.id === "scene-time-elevation"));
  assert(list.recipes.every((r) => r.markedForLookup));
  const search = (await f.run("foundry_gm_recipe_search", {
    query: "currency",
    limit: 1,
  })) as CatalogResult;
  assert.equal(search.recipes[0]!.id, "inventory-rewards");
  const read = (await f.run("foundry_gm_recipe_read", { recipeId: "inventory-rewards" })) as Record<
    string,
    unknown
  >;
  for (const field of [
    "purpose",
    "triggers",
    "requiredTools",
    "parameters",
    "preconditions",
    "steps",
    "verification",
    "permissions",
    "recovery",
    "versionCompatibility",
  ])
    assert(read[field]);
  assert.deepEqual(read.requiredTools, [
    "foundry_gm_character_state",
    "foundry_gm_character_apply",
    "foundry_gm_receipt_read",
  ]);
  assert.throws(() => f.run("foundry_gm_recipe_read", { recipeId: "unknown" }), /Unknown/);
});
void test("end-to-end recipe executes same native handlers sequentially and caches exact invocation without duplicate spends", async () => {
  const f = fixture(),
    result = (await f.run("foundry_gm_recipe_invoke", input)) as RecipeResult;
  assert.equal(result.outcome, "confirmed");
  assert.equal(result.receipts.length, 2);
  assert.equal(f.calls().applies, 2);
  assert.deepEqual(await f.run("foundry_gm_recipe_invoke", input), result);
  assert.equal(f.calls().applies, 2);
  assert.notEqual(
    result.receipts[0]!.receipt.idempotencyKey,
    result.receipts[1]!.receipt.idempotencyKey,
  );
  await assert.rejects(
    async () => f.run("foundry_gm_recipe_invoke", { ...input, steps: input.steps.slice(0, 1) }),
    /Changed recipe/,
  );
});
void test("failure retains first receipt and stops later actions; uncertainty and malformed scope never continue", async () => {
  for (const options of [{ fail: 2 }, { uncertain: 1 }, { mismatch: true }]) {
    const f = fixture(options),
      result = (await f.run("foundry_gm_recipe_invoke", input)) as RecipeResult;
    assert.equal(result.outcome, "fail" in options ? "failure" : "uncertain");
    assert.equal(f.calls().applies, "fail" in options ? 2 : 1);
    await f.run("foundry_gm_recipe_invoke", input);
    assert.equal(f.calls().applies, "fail" in options ? 2 : 1);
  }
});
void test("invalid initial state/action/oversize/duplicate steps refuse before mutations", async () => {
  const f = fixture({ changed: true });
  assert.equal(
    ((await f.run("foundry_gm_recipe_invoke", input)) as RecipeResult).outcome,
    "failure",
  );
  assert.equal(f.calls().applies, 0);
  await assert.rejects(
    async () =>
      f.run("foundry_gm_recipe_invoke", {
        ...input,
        steps: [{ stepId: "x", action: { kind: "actor.rest" } }],
      }),
    /belong/,
  );
  assert.equal(
    gmRecipeInvokeSchema.safeParse({ ...input, steps: [input.steps[0], input.steps[0]] }).success,
    false,
  );
  await assert.rejects(
    async () =>
      f.run("foundry_gm_recipe_invoke", {
        ...input,
        expectedInitialState: { tooLarge: "x".repeat(40000) },
      }),
    /byte limit/,
  );
});
void test("new endpoint instance after restart uses stable keys and native journal refusal instead of retrying effects", async () => {
  let spends = 0;
  const prior = new Map<string, string>();
  const operations: AnyEndpointDescriptor[] = [
    {
      name: "foundry_gm_receipt_read",
      description: "receipt",
      handler: (args) => ({
        status: prior.has(args.action.idempotencyKey) ? "terminal" : "missing",
      }),
    },
    { name: "foundry_gm_character_state", description: "state", handler: () => ({ spends }) },
    {
      name: "foundry_gm_character_apply",
      description: "apply",
      handler: (args) => {
        const before = { spends },
          fingerprint = JSON.stringify(args),
          key = args.idempotencyKey;
        if (prior.has(key)) return { ...args, before, after: null, outcome: "failure", data: null };
        prior.set(key, fingerprint);
        spends++;
        return { ...args, before, after: { spends }, outcome: "confirmed", data: null };
      },
    },
  ];
  const invoke = async (expectedInitialState: unknown) =>
    createGmRecipeEndpointDescriptors(operations)
      .find((d) => d.name === "foundry_gm_recipe_invoke")!
      .handler({ ...input, expectedInitialState, steps: input.steps.slice(0, 1) }, {
        foundryClient: {},
      } as EndpointContext) as Promise<RecipeResult>;
  assert.equal((await invoke({ spends: 0 })).outcome, "confirmed");
  assert.equal((await invoke({ spends: 1 })).outcome, "uncertain");
  assert.equal(spends, 1);
});
void test("restart fences retained unchanged-state roll and reserved step before missing later stages", async () => {
  const nativeState = { hp: 10 },
    retained = new Map<string, string>();
  let rolls = 0,
    laterStages = 0,
    stopSecondRead = true;
  const operations: AnyEndpointDescriptor[] = [
    {
      name: "foundry_gm_receipt_read",
      description: "receipt",
      handler: (args) => ({ status: retained.get(args.action.idempotencyKey) ?? "missing" }),
    },
    {
      name: "foundry_gm_character_state",
      description: "state",
      handler: (args) => {
        if (args.action.key === "stealth" && stopSecondRead)
          throw Error("Disconnected before later stage");
        return nativeState;
      },
    },
    {
      name: "foundry_gm_character_apply",
      description: "apply",
      handler: (args) => {
        if (args.action.key === "perception") rolls++;
        else laterStages++;
        retained.set(args.idempotencyKey, "terminal");
        return {
          ...args,
          before: nativeState,
          after: nativeState,
          outcome: "confirmed",
          data: { roll: 12 },
        };
      },
    },
  ];
  const request = {
    ...input,
    recipeId: "native-checks",
    expectedInitialState: nativeState,
    steps: [
      { stepId: "roll", action: { kind: "actor.check", key: "perception" } },
      { stepId: "later", action: { kind: "actor.check", key: "stealth" } },
    ],
  };
  const invoke = async () =>
    createGmRecipeEndpointDescriptors(operations)
      .find((d) => d.name === "foundry_gm_recipe_invoke")!
      .handler(request, { foundryClient: {} } as EndpointContext) as Promise<{
      outcome: string;
      recoveryReceipt?: { status: string };
    }>;
  assert.equal((await invoke()).outcome, "failure");
  assert.equal(rolls, 1);
  assert.equal(laterStages, 0);
  stopSecondRead = false;
  const recovered = await invoke();
  assert.equal(recovered.outcome, "uncertain");
  assert.equal(recovered.recoveryReceipt?.status, "terminal");
  assert.equal(rolls, 1);
  assert.equal(laterStages, 0);
  for (const key of retained.keys()) retained.set(key, "reserved");
  assert.equal((await invoke()).recoveryReceipt?.status, "reserved");
  assert.equal(rolls, 1);
  assert.equal(laterStages, 0);
});
void test("executable TV recipe keeps one exact requester/client and camera preconditions with independent PC union readback", async () => {
  let camera = { sceneId: "scene", x: 0, y: 0, scale: 1 },
    applies = 0;
  const calls: Record<string, unknown>[] = [];
  const native: AnyEndpointDescriptor = {
    name: "foundry_tv_control",
    description: "TV",
    handler: (args) => {
      calls.push(args);
      if (args.action !== "inspect") {
        assert.deepEqual(args.expectedState, camera);
        applies++;
        if (args.action === "camera") camera = { sceneId: "scene", ...args.camera };
      }
      return {
        ...args,
        camera,
        vision: {
          mode: "native-pc-union",
          status: "verified",
          sourceCount: 2,
          permissionsChanged: false,
          nativeWallsFogDetection: true,
        },
        calibration: { physicalVerified: false, rulerAcceptanceRequired: true },
      };
    },
  };
  const reservation = reservationFixture();
  const endpoints = createGmRecipeEndpointDescriptors([native, ...reservation.operations]),
    ctx = { foundryClient: {} } as EndpointContext;
  const invoke = endpoints.find((d) => d.name === "foundry_gm_recipe_invoke")!;
  const request = {
    ...input,
    recipeId: "tv-camera-vision",
    expectedInitialState: { ...camera },
    steps: [
      { stepId: "union", action: { action: "unionVision", tvUserId: "tv", tvClientId: "client" } },
      {
        stepId: "pan",
        action: {
          action: "camera",
          tvUserId: "tv",
          tvClientId: "client",
          camera: { x: 10, y: 20, scale: 0.5 },
        },
      },
    ],
  };
  const result = (await invoke.handler(request, ctx)) as Record<string, unknown>;
  assert.equal(result["outcome"], "confirmed");
  assert.equal(applies, 2);
  const restarted = createGmRecipeEndpointDescriptors([native, ...reservation.operations]).find(
    (d) => d.name === "foundry_gm_recipe_invoke",
  )!;
  assert.equal(
    ((await restarted.handler({ ...request, expectedInitialState: camera }, ctx)) as RecipeResult)
      .outcome,
    "uncertain",
  );
  assert.equal(applies, 2);
  assert(calls.every((call) => call.requestingUserId === "gm" && call.tvClientId === "client"));
  assert.deepEqual(await invoke.handler(request, ctx), result);
  assert.equal(applies, 2);
  await assert.rejects(
    async () =>
      invoke.handler(
        {
          ...request,
          steps: [
            request.steps[0],
            { ...request.steps[1], action: { ...request.steps[1]!.action, tvClientId: "other" } },
          ],
        },
        ctx,
      ),
    /one exact/,
  );
});
void test("executable document recipe uses exact native revision/source and rejects unsafe/create/delete/unscoped actions", async () => {
  let revision = "a".repeat(64),
    source = { name: "Existing story" },
    updates = 0;
  const scope = {
    worldId: "world",
    family: "journal-pages",
    targetId: "page",
    parentId: "journal",
  };
  const operations: AnyEndpointDescriptor[] = [
    {
      name: "foundry_get_world_document",
      description: "read",
      handler: (args) => ({ ...scope, operation: args.operation, source, revision }),
    },
    {
      name: "foundry_apply_world_document",
      description: "update",
      handler: (args) => {
        assert.equal(args.requestingUserId, "gm");
        assert.equal(args.expectedRevision, revision);
        source = args.data;
        revision = "b".repeat(64);
        updates++;
        return {
          ...scope,
          source,
          revision,
          verified: true,
          idempotencyKey: args.idempotencyKey,
          correlationId: args.correlationId,
        };
      },
    },
  ];
  const reservation = reservationFixture();
  const endpoints = createGmRecipeEndpointDescriptors([...operations, ...reservation.operations]),
    invoke = endpoints.find((d) => d.name === "foundry_gm_recipe_invoke")!,
    ctx = { foundryClient: {} } as EndpointContext;
  const initial = { ...scope, source: { ...source }, revision },
    request = {
      ...input,
      recipeId: "native-document-preparation",
      expectedInitialState: initial,
      steps: [
        {
          stepId: "log",
          action: {
            family: "journal-pages",
            targetId: "page",
            parentId: "journal",
            operation: "update",
            data: { name: "Verified story" },
          },
        },
      ],
    };
  assert.equal(
    ((await invoke.handler(request, ctx)) as Record<string, unknown>)["outcome"],
    "confirmed",
  );
  assert.equal(updates, 1);
  const restarted = createGmRecipeEndpointDescriptors([
    ...operations,
    ...reservation.operations,
  ]).find((d) => d.name === "foundry_gm_recipe_invoke")!;
  assert.equal(
    (
      (await restarted.handler(
        { ...request, expectedInitialState: { ...scope, source, revision } },
        ctx,
      )) as RecipeResult
    ).outcome,
    "uncertain",
  );
  assert.equal(updates, 1);
  for (const action of [
    { ...request.steps[0]!.action, data: { ownership: { default: 3 } } },
    { ...request.steps[0]!.action, data: { flags: { script: "execute" } } },
    { ...request.steps[0]!.action, data: { "items.0.name": "Nested collection" } },
    { ...request.steps[0]!.action, data: { system: { effects: [] } } },
    {
      family: "scene-tokens",
      parentId: "scene",
      targetId: "pc",
      operation: "update",
      data: { x: 30 },
    },
    {
      family: "scene-tokens",
      parentId: "scene",
      targetId: "pc",
      operation: "update",
      data: { elevation: 30 },
    },
    { ...request.steps[0]!.action, operation: "create" },
    { ...request.steps[0]!.action, operation: "delete" },
    {
      family: "scene-tokens",
      targetId: "pc",
      parentId: "otherScene",
      operation: "update",
      data: { name: "PC" },
    },
  ])
    await assert.rejects(async () =>
      invoke.handler(
        { ...request, idempotencyKey: "invalid", steps: [{ stepId: "unsafe", action }] },
        ctx,
      ),
    );
  assert.equal(updates, 1);
});
void test("specialized native reservation fences no-op then uncertain later stage after restart even with unchanged initial state", async () => {
  const reservation = reservationFixture();
  let updates = 0;
  const snapshot = {
    worldId: "world",
    family: "journals",
    targetId: "story",
    source: { name: "Story" },
    revision: "a".repeat(64),
  };
  const operations: AnyEndpointDescriptor[] = [
    ...reservation.operations,
    { name: "foundry_get_world_document", description: "read", handler: () => snapshot },
    {
      name: "foundry_apply_world_document",
      description: "apply",
      handler: (args) => {
        updates++;
        if (updates === 2) throw Error("Disconnected after possible dispatch");
        return {
          ...snapshot,
          verified: true,
          idempotencyKey: args.idempotencyKey,
          correlationId: args.correlationId,
        };
      },
    },
  ];
  const request = {
    ...input,
    recipeId: "native-document-preparation",
    expectedInitialState: snapshot,
    steps: [
      {
        stepId: "noop",
        action: {
          family: "journals",
          targetId: "story",
          operation: "update",
          data: { name: "Story" },
        },
      },
      {
        stepId: "later",
        action: {
          family: "journals",
          targetId: "story",
          operation: "update",
          data: { name: "Later" },
        },
      },
    ],
  };
  const run = async () =>
    createGmRecipeEndpointDescriptors(operations)
      .find((d) => d.name === "foundry_gm_recipe_invoke")!
      .handler(request, { foundryClient: {} } as EndpointContext) as Promise<RecipeResult>;
  assert.equal((await run()).outcome, "uncertain");
  assert.equal(updates, 2);
  assert.equal((await run()).outcome, "uncertain");
  assert.equal(updates, 2);
  for (const key of reservation.retained.keys()) reservation.retained.set(key, "reserved");
  assert.equal((await run()).outcome, "uncertain");
  assert.equal(updates, 2);
});
void test("session no-op correction also reserves durable native recipe identity before dispatch", async () => {
  const reservation = reservationFixture();
  let corrections = 0;
  const action = { kind: "door.state", targetId: "door", value: 1, sceneId: "scene" };
  const state = { worldId: "world", action, state: { ds: 1 } };
  const operations: AnyEndpointDescriptor[] = [
    ...reservation.operations,
    { name: "foundry_get_session_action_state", description: "state", handler: () => state },
    {
      name: "foundry_apply_session_action",
      description: "apply",
      handler: (args) => {
        corrections++;
        return { ...args, verified: true, state: state.state };
      },
    },
  ];
  const request = {
    ...input,
    recipeId: "doors-light-corrections",
    expectedInitialState: state,
    steps: [{ stepId: "door", action: { kind: "door.state", targetId: "door", value: 1 } }],
  };
  const run = async () =>
    createGmRecipeEndpointDescriptors(operations)
      .find((d) => d.name === "foundry_gm_recipe_invoke")!
      .handler(request, { foundryClient: {} } as EndpointContext) as Promise<RecipeResult>;
  assert.equal((await run()).outcome, "confirmed");
  assert.equal(corrections, 1);
  assert.equal((await run()).outcome, "uncertain");
  assert.equal(corrections, 1);
});
void test("concurrent fresh recipe instances dispatch only the atomically admitted native reservation", async () => {
  const retained = new Set<string>();
  let lookups = 0,
    updates = 0;
  let release: () => void = () => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const snapshot = {
    worldId: "world",
    family: "journals",
    targetId: "story",
    source: { name: "Story" },
    revision: "a".repeat(64),
  };
  const nativeState = { sceneId: "scene", active: true };
  const operations: AnyEndpointDescriptor[] = [
    { name: "foundry_get_world_document", description: "read", handler: () => snapshot },
    {
      name: "foundry_apply_world_document",
      description: "apply",
      handler: (args) => {
        updates++;
        return {
          ...snapshot,
          verified: true,
          idempotencyKey: args.idempotencyKey,
          correlationId: args.correlationId,
        };
      },
    },
    {
      name: "foundry_gm_receipt_read",
      description: "lookup",
      handler: async () => {
        if (++lookups === 2) release();
        await barrier;
        return { status: "missing" };
      },
    },
    { name: "foundry_gm_scene_state", description: "state", handler: () => nativeState },
    {
      name: "foundry_gm_scene_apply",
      description: "atomic admission",
      handler: (args) => {
        if (retained.has(args.idempotencyKey))
          return {
            ...args,
            before: nativeState,
            after: null,
            outcome: "failure",
            data: { reservationAlreadyExists: true },
          };
        retained.add(args.idempotencyKey);
        return {
          ...args,
          before: nativeState,
          after: nativeState,
          outcome: "confirmed",
          data: { reservationOnly: true },
        };
      },
    },
  ];
  const request = {
    ...input,
    recipeId: "native-document-preparation",
    expectedInitialState: snapshot,
    steps: [
      {
        stepId: "noop",
        action: {
          family: "journals",
          targetId: "story",
          operation: "update",
          data: { name: "Story" },
        },
      },
    ],
  };
  const run = async () =>
    createGmRecipeEndpointDescriptors(operations)
      .find((d) => d.name === "foundry_gm_recipe_invoke")!
      .handler(request, { foundryClient: {} } as EndpointContext) as Promise<RecipeResult>;
  const results = await Promise.all([run(), run()]);
  assert.deepEqual(results.map((r) => r.outcome).sort(), ["confirmed", "uncertain"]);
  assert.equal(updates, 1);
  assert.equal(retained.size, 1);
});
