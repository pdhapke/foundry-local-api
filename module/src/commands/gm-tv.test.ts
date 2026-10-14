import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { GM_TV_COMMANDS, type TvControlCommandInput } from "@foundry-local-api/shared";
import { dispatch } from "../command-registry.js";
import { executeTvControl } from "./gm-tv.js";

const globals = ["game", "canvas", "Hooks", "localStorage"].map(
  (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
);
afterEach(() => {
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});
let sequence = 0;
function fixture(
  options: {
    missingPermission?: boolean;
    nonParty?: boolean;
    selected?: boolean;
    delay?: boolean;
    hidden?: boolean;
  } = {},
) {
  const tv = { id: "tv-user", name: "TV", isGM: false, active: true, toObject: () => ({}) };
  const gm = { id: "gm-user", name: "GM", isGM: true, active: true, toObject: () => ({}) };
  const pcUser = {
    id: "pc-user",
    name: "Player",
    isGM: false,
    active: true,
    toObject: () => ({ character: "pc-actor" }),
  };
  const actor = {
    id: "pc-actor",
    type: "character",
    testUserPermission: (u: { id: string }, p: string) =>
      (u.id === "pc-user" && p === "OWNER") || (u.id === "tv-user" && !options.missingPermission),
  };
  const pc = {
    actor,
    hasSight: true,
    controlled: !!options.selected,
    document: { id: "pc-token", hidden: false, level: "level-1", sight: { enabled: true } },
  };
  const other = {
    actor: { id: "npc", type: "npc", testUserPermission: () => !!options.nonParty },
    hasSight: true,
    controlled: false,
    document: {
      id: "npc-token",
      hidden: !!options.hidden,
      level: "level-1",
      sight: { enabled: true },
    },
  };
  const source = { active: true, isPreview: false, object: pc };
  const sources = new Map<string, { active: boolean; isPreview: boolean; object: typeof pc }>([
    ["pc", source],
  ]);
  const listeners = new Map<number, () => void>();
  let hookId = 0;
  let panCalls = 0;
  let releaseCalls = 0;
  let consent = true;
  const c = {
    ready: true,
    scene: {
      id: "scene-1",
      tokenVision: true,
      grid: { size: 100, type: 1 },
      tokens: {
        values: () => c.tokens.placeables.map((t) => ({ ...t.document, actor: t.actor })).values(),
      },
    },
    level: { id: "level-1" },
    stage: { pivot: { x: 100, y: 200 }, scale: { x: 1 } },
    effects: {
      visionSources: sources,
      lightSources: new Map<string, { active: boolean; data: { vision: boolean } }>(),
    },
    tokens: {
      placeables: [pc, other],
      controlled: options.selected ? [pc] : [],
      releaseAll: () => {
        releaseCalls++;
        c.tokens.controlled = [];
        pc.controlled = false;
        const refresh = () => {
          sources.set("pc", source);
          for (const listener of [...listeners.values()]) listener();
        };
        if (options.delay) setTimeout(refresh, 5);
        else refresh();
      },
    },
    animatePan: (view: { x: number; y: number; scale: number }) => {
      panCalls++;
      c.stage.pivot = { x: view.x, y: view.y };
      c.stage.scale.x = view.scale;
      return Promise.resolve();
    },
  };
  if (options.delay) sources.clear();
  const g = {
    world: { id: "world-1" },
    release: { version: "14.368" },
    user: tv,
    users: new Map([
      [tv.id, tv],
      [gm.id, gm],
      [pcUser.id, pcUser],
    ]),
    collections: new Map([["Actor", new Map([[actor.id, actor]])]]),
    settings: { get: () => consent },
  };
  const storage = new Map([["foundry-local-api.clientId", "tv-client-1"]]);
  for (const [name, value] of [
    ["game", g],
    ["canvas", c],
    [
      "localStorage",
      {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => storage.set(k, v),
      },
    ],
    [
      "Hooks",
      {
        on: (_name: string, callback: () => void) => {
          listeners.set(++hookId, callback);
          return hookId;
        },
        off: (_name: string, id: number) => listeners.delete(id),
      },
    ],
  ] as const)
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const input: TvControlCommandInput = {
    version: "tv-controls-v1",
    worldId: "world-1",
    sceneId: "scene-1",
    tvUserId: tv.id,
    tvClientId: "tv-client-1",
    requestingUserId: gm.id,
    action: "inspect",
  };
  const apply = (action: TvControlCommandInput["action"] = "camera"): TvControlCommandInput => ({
    ...input,
    action,
    expectedState: { sceneId: "scene-1", x: 100, y: 200, scale: 1 },
    idempotencyKey: `tv-test-${++sequence}`,
    ...(action === "camera" ? { camera: { x: 300, y: 400, scale: 2 } } : {}),
  });
  return {
    input,
    apply,
    c,
    g,
    pc,
    other,
    sources,
    listeners,
    panCalls: () => panCalls,
    releaseCalls: () => releaseCalls,
    revokeConsent: () => {
      consent = false;
    },
  };
}
void describe("authenticated TV native controls", () => {
  void it("dispatches native camera on exact TV and keeps hidden token data out of its receipt", async () => {
    const f = fixture({ hidden: true });
    const response = await dispatch({
      id: "request-1",
      type: GM_TV_COMMANDS.EXECUTE,
      payload: f.apply(),
    });
    assert.equal(response.ok, true);
    assert.equal(f.panCalls(), 1);
    assert.ok(!JSON.stringify(response).includes("npc"));
    const receipt = await executeTvControl(f.input);
    assert.equal(receipt.vision.status, "verified");
    assert.equal(receipt.vision.permissionsChanged, false);
    assert.equal(receipt.calibration.physicalVerified, false);
  });
  void it("blocks missing party permission and non-party observers before any canvas mutation", async () => {
    for (const options of [{ missingPermission: true }, { nonParty: true }]) {
      const f = fixture(options);
      assert.equal((await executeTvControl(f.input)).vision.status, "blocked");
      await assert.rejects(executeTvControl(f.apply("unionVision")), { code: "PERMISSION_DENIED" });
      assert.equal(f.releaseCalls(), 0);
      assert.equal(f.panCalls(), 0);
    }
  });
  void it("includes all owned Characters beyond the player's assigned character", async () => {
    const f = fixture();
    const additional = { ...f.pc.actor, id: "unassigned-pc" };
    f.g.collections.get("Actor")!.set(additional.id, additional);
    const token = { ...f.pc, actor: additional };
    f.c.tokens.placeables.push(token);
    f.sources.set("unassigned-pc-source", { active: true, isPreview: false, object: token });
    assert.equal((await executeTvControl(f.input)).vision.sourceCount, 2);
    assert.equal((await executeTvControl(f.apply())).vision.sourceCount, 2);
  });
  void it("blocks rather than silently omit an unassigned owned PC lacking TV OBSERVER", async () => {
    const f = fixture();
    const additional = {
      ...f.pc.actor,
      id: "unassigned-pc",
      testUserPermission: (u: { id: string }, permission: string) =>
        u.id === "pc-user" && permission === "OWNER",
    };
    f.g.collections.get("Actor")!.set(additional.id, additional);
    f.c.tokens.placeables.push({ ...f.pc, actor: additional });
    assert.equal((await executeTvControl(f.input)).vision.status, "blocked");
    await assert.rejects(executeTvControl(f.apply("unionVision")), { code: "PERMISSION_DENIED" });
    assert.equal(f.releaseCalls(), 0);
    assert.equal(f.panCalls(), 0);
  });
  void it("rejects another world, scene, client, player lane, GM TV, revoked consent and forged requester", async () => {
    const f = fixture();
    for (const change of [
      { worldId: "another-world" },
      { sceneId: "another-scene" },
      { tvClientId: "other-tv" },
      { tvUserId: "another-user" },
      { requestingUserId: "pc-user" },
    ])
      await assert.rejects(executeTvControl({ ...f.input, ...change }));
    f.g.user.name = "Player";
    await assert.rejects(executeTvControl(f.input), { code: "PERMISSION_DENIED" });
    f.g.user.name = "TV";
    f.g.user.isGM = true;
    await assert.rejects(executeTvControl(f.input), { code: "PERMISSION_DENIED" });
    f.g.user.isGM = false;
    f.revokeConsent();
    await assert.rejects(executeTvControl(f.input), { code: "PERMISSION_DENIED" });
    assert.equal(f.panCalls(), 0);
  });
  void it("awaits native sightRefresh after selection release and cleans the hook", async () => {
    const f = fixture({ selected: true, delay: true });
    assert.equal((await executeTvControl(f.input)).vision.status, "blocked");
    const result = await executeTvControl(f.apply("unionVision"));
    assert.equal(result.vision.status, "verified");
    assert.equal(f.releaseCalls(), 1);
    assert.equal(f.listeners.size, 0);
  });
  void it("rechecks TV consent, GM role and viewed scene after delayed native refresh", async () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => f.revokeConsent(),
      (f: ReturnType<typeof fixture>) => {
        f.g.users.get("gm-user")!.isGM = false;
      },
      (f: ReturnType<typeof fixture>) => {
        f.c.scene.id = "other-scene";
      },
      (f: ReturnType<typeof fixture>) => {
        Object.defineProperty(globalThis, "canvas", {
          configurable: true,
          writable: true,
          value: { ...f.c },
        });
      },
    ]) {
      const f = fixture({ selected: true, delay: true });
      const pending = executeTvControl(f.apply("unionVision"));
      change(f);
      await assert.rejects(pending);
      assert.equal(f.listeners.size, 0);
    }
  });
  void it("identical in-flight union requests share a single native selection release", async () => {
    const f = fixture({ selected: true, delay: true });
    const input = f.apply("unionVision");
    const [first, second] = await Promise.all([executeTvControl(input), executeTvControl(input)]);
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.equal(f.releaseCalls(), 1);
    assert.equal(f.listeners.size, 0);
  });
  void it("native refresh timeout cleans its hook, retains uncertainty and permits inspected recovery", async () => {
    const f = fixture({ selected: true });
    const input = f.apply("unionVision");
    f.c.tokens.releaseAll = () => {
      f.c.tokens.controlled = [];
      f.pc.controlled = false;
    };
    await assert.rejects(executeTvControl(input), { code: "INCOMPLETE_RESULT" });
    assert.equal(f.listeners.size, 0);
    await assert.rejects(executeTvControl(input), { code: "INCOMPLETE_RESULT" });
    assert.equal((await executeTvControl(f.input)).vision.status, "verified");
    assert.equal((await executeTvControl(f.apply("unionVision"))).vision.status, "verified");
  });
  void it("denies a foreign native source and vision-granting light; camera never overrides their visibility", async () => {
    const f = fixture();
    f.sources.set("foreign", { active: true, isPreview: false, object: f.other });
    await assert.rejects(executeTvControl(f.apply()), { code: "PERMISSION_DENIED" });
    f.sources.delete("foreign");
    f.c.effects.lightSources.set("vision-light", { active: true, data: { vision: true } });
    await assert.rejects(executeTvControl(f.apply()), { code: "PERMISSION_DENIED" });
    assert.equal(f.panCalls(), 0);
  });
  void it("does not claim a partial party union when a PC is on another level", async () => {
    const f = fixture();
    f.c.tokens.placeables.push({
      ...f.pc,
      document: { ...f.pc.document, id: "upper-pc-token", level: "level-2" },
    });
    assert.equal((await executeTvControl(f.input)).vision.status, "blocked");
    await assert.rejects(executeTvControl(f.apply()), { code: "UNSUPPORTED_TYPE" });
    assert.equal(f.panCalls(), 0);
  });
  void it("refuses configured off-level PC sight even when native hasSight is false", async () => {
    const f = fixture();
    f.c.tokens.placeables.push({
      ...f.pc,
      hasSight: false,
      document: { ...f.pc.document, id: "upper-unrendered-pc", level: "level-2" },
    });
    const inspected = await executeTvControl(f.input);
    assert.equal(inspected.vision.status, "blocked");
    await assert.rejects(executeTvControl(f.apply("unionVision")), { code: "UNSUPPORTED_TYPE" });
    assert.equal(f.releaseCalls(), 0);
    assert.equal(f.panCalls(), 0);
  });
  void it("refuses a configured party source missing from current canvas placeables", async () => {
    const f = fixture();
    const documents = [
      ...f.c.scene.tokens.values(),
      { ...f.pc.document, id: "absent-pc", actor: f.pc.actor },
    ];
    f.c.scene.tokens.values = () => documents.values();
    assert.equal((await executeTvControl(f.input)).vision.status, "blocked");
    await assert.rejects(executeTvControl(f.apply("unionVision")), { code: "UNSUPPORTED_TYPE" });
    assert.equal(f.releaseCalls(), 0);
    assert.equal(f.panCalls(), 0);
  });
  void it("applies an absolute camera once, rejects key reuse and stale expected state", async () => {
    const f = fixture();
    const input = f.apply();
    await executeTvControl(input);
    assert.equal((await executeTvControl(input)).replayed, true);
    assert.equal(f.panCalls(), 1);
    await assert.rejects(executeTvControl({ ...input, camera: { x: 900, y: 900, scale: 2 } }), {
      code: "IDEMPOTENCY_CONFLICT",
    });
    await assert.rejects(executeTvControl(f.apply()), { code: "STALE_REVISION" });
  });
  void it("ruler calibration applies only local zoom and does not claim physical acceptance", async () => {
    const f = fixture();
    const input = {
      ...f.apply("calibrate"),
      calibration: {
        measuredPixels: 200,
        measuredInches: 2,
        gridInches: 1,
        rulerConfirmed: true as const,
      },
    };
    const result = await executeTvControl(input);
    assert.equal(result.camera.scale, 1);
    assert.equal(result.calibration.physicalVerified, false);
    assert.equal(result.calibration.rulerAcceptanceRequired, true);
    await assert.rejects(
      executeTvControl({
        ...f.apply("calibrate"),
        calibration: { ...input.calibration, rulerConfirmed: false as unknown as true },
      }),
      { code: "INVALID_PAYLOAD" },
    );
    f.c.scene.grid.type = 2;
    await assert.rejects(
      executeTvControl({ ...f.apply("calibrate"), calibration: input.calibration }),
      { code: "UNSUPPORTED_TYPE" },
    );
  });
  void it("uncertain native camera is not retried and local state can be inspected for recovery", async () => {
    const f = fixture();
    const input = f.apply();
    f.c.animatePan = () => {
      f.c.stage.pivot.x = 500;
      return Promise.reject(new Error("disconnect"));
    };
    await assert.rejects(executeTvControl(input));
    await assert.rejects(executeTvControl(input), { code: "INCOMPLETE_RESULT" });
    assert.equal((await executeTvControl(f.input)).camera.x, 500);
  });
  void it("rejects arbitrary perspective, javascript and malformed controls", async () => {
    const f = fixture();
    await assert.rejects(
      executeTvControl({ ...f.apply("perspective"), perspective: "3d" as "native-top-down" }),
      { code: "UNSUPPORTED_TYPE" },
    );
    await assert.rejects(
      executeTvControl({ ...f.input, code: "arbitrary" } as TvControlCommandInput),
      { code: "INVALID_PAYLOAD" },
    );
    await assert.rejects(
      executeTvControl({ ...f.apply(), camera: { x: 0, y: 0, scale: Infinity } }),
      { code: "INVALID_PAYLOAD" },
    );
  });
});
