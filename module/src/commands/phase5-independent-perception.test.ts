import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { inspectSceneVisibility, renderSceneSnapshot } from "./scene-render.js";

const savedGame = Object.getOwnPropertyDescriptor(globalThis, "game");
const savedCanvas = Object.getOwnPropertyDescriptor(globalThis, "canvas");
const savedConfig = Object.getOwnPropertyDescriptor(globalThis, "CONFIG");

function document(id: string, data: Record<string, unknown> = {}, owner = false) {
  return {
    id,
    toObject: () => ({ _id: id, ...structuredClone(data) }),
    testUserPermission: (_user: unknown, permission: string) =>
      permission === "OWNER" ? owner : data["hidden"] !== true,
  };
}

function install(
  options: {
    userId?: string;
    tokenOwner?: boolean;
    extraction?: "ok" | "fail";
    extraVision?: boolean;
    visionProvidingLight?: boolean;
    missingExactApi?: boolean;
    selectedDetection?: (x: number) => boolean;
    specialPreparedMode?: boolean;
    missingPreparedModes?: boolean;
    rawSpecialMode?: boolean;
    assetFailure?: boolean;
    v14Environment?: boolean;
  } = {},
) {
  const calls = { union: 0, selectedDetection: 0, unrelatedDetection: 0 };
  const user = { id: options.userId ?? "player", isGM: false };
  const sceneSource = {
    _id: "scene",
    name: "Fixture",
    revisionMarker: 1,
    ...(options.v14Environment
      ? {
          environment: { darknessLevel: 0.25, globalLight: { enabled: true } },
          fog: { mode: 1 },
        }
      : { darkness: 0.5, globalLight: false, fogExploration: true }),
    ...(options.assetFailure ? { background: { src: "secret/assets/player-background.png" } } : {}),
  };
  const scene = {
    id: "scene",
    toObject: () => structuredClone(sceneSource),
    testUserPermission: () => true,
    tokens: new Map(),
  };
  const selectedToken = document(
    "token-selected",
    {
      sight: { enabled: true },
      elevation: 0,
      ...(options.rawSpecialMode
        ? { detectionModes: { otherSense: { id: "otherSense", enabled: true, range: 100 } } }
        : {}),
    },
    options.tokenOwner !== false,
  );
  if (!options.missingPreparedModes)
    (selectedToken as any).detectionModes = {
      basicSight: { id: "basicSight", enabled: true, range: 10 },
      ...(options.specialPreparedMode
        ? { otherSense: { id: "otherSense", enabled: true, range: 100 } }
        : {}),
    };
  const secretJournal = document("secret-journal", { hidden: true });
  Object.defineProperty(globalThis, "game", {
    configurable: true,
    value: {
      user,
      world: { id: "world" },
      settings: { get: () => true },
      collections: new Map([
        ["Scene", new Map([["scene", scene]])],
        ["JournalEntry", new Map([["secret-journal", secretJournal]])],
      ]),
    },
  });
  const selectedPlaceable: any = {
    id: "token-selected",
    center: { x: 1, y: 1 },
    visible: true,
    document: selectedToken,
  };
  const vision: any = {
    active: true,
    object: selectedPlaceable,
    shape: {
      points: [0, 0, 10, 0, 10, 10],
      contains: (x: number) => x < 10,
    },
    los: { contains: (x: number) => x < 10 },
  };
  selectedPlaceable.vision = vision;
  const visibleRegionDocument = Object.assign(document("gm-region-id"), {
    testPoint: ({ x, elevation }: { x: number; elevation: number }) => x < 5 && elevation === 0,
    tokens: new Set([selectedToken]),
    behaviors: new Map([["behavior-id", { active: true, viewed: true }]]),
  });
  const visionSources = new Map<string, unknown>([["vision", vision]]);
  if (options.extraVision)
    visionSources.set("other", {
      active: true,
      object: { id: "other-token" },
      shape: { contains: (x: number) => x > 50 },
      los: { contains: (x: number) => x > 50 },
      detectionModes: [{ id: "otherSense", enabled: true }],
    });
  const lightSources = new Map<string, unknown>([
    ["near", { active: true, shape: { contains: (x: number) => x < 5 } }],
    ["remote", { active: true, shape: { contains: (x: number) => x > 50 } }],
  ]);
  if (options.visionProvidingLight)
    lightSources.set("vision-light", {
      active: true,
      vision: true,
      shape: { contains: (x: number) => x > 50 },
    });
  Object.defineProperty(globalThis, "CONFIG", {
    configurable: true,
    value: {
      Canvas: {
        detectionModes: {
          basicSight: {
            testVisibility: (source: unknown, _mode: unknown, config: any) => {
              calls.selectedDetection += 1;
              assert.equal(source, vision);
              return config.tests.some(({ point }: any) =>
                options.selectedDetection ? options.selectedDetection(point.x) : point.x < 5,
              );
            },
          },
          otherSense: {
            testVisibility: () => {
              calls.unrelatedDetection += 1;
              return true;
            },
          },
        },
      },
    },
  });
  const visibility: any = {
    testVisibility: ({ x }: { x: number }) => {
      calls.union += 1;
      return x < 5 || x > 50;
    },
  };
  if (!options.missingExactApi)
    visibility._createVisibilityTestConfig = (
      points: Array<{ x: number; y: number }>,
      { object }: { object: unknown },
    ) => ({
      object,
      tests: points.map((point) => ({ point, los: new Map(), level: {} })),
      level: {},
    });
  Object.defineProperty(globalThis, "canvas", {
    configurable: true,
    value: {
      scene,
      ready: true,
      perception: { renderFlags: { size: 0 } },
      stage: {},
      app: {
        renderer: {
          extract: {
            base64:
              options.extraction === "fail"
                ? () => Promise.reject(new Error("asset"))
                : () => Promise.resolve("data:image/png;base64,AAAA"),
          },
        },
      },
      tokens: {
        placeables: [
          selectedPlaceable,
          {
            id: "token-occluded-secret-id",
            center: { x: 8, y: 1 },
            visible: false,
            document: document("token-occluded-secret-id"),
          },
        ],
      },
      notes: {
        placeables: [
          {
            id: "note-public",
            center: { x: 2, y: 1 },
            visible: true,
            document: document("note-public"),
          },
          {
            id: "note-secret-id",
            visible: false,
            document: document("note-secret-id", { entryId: "secret-journal" }),
          },
        ],
      },
      tiles: {
        placeables: [
          {
            id: "tile-public",
            center: { x: 3, y: 1 },
            visible: true,
            document: document("tile-public"),
          },
          {
            id: "tile-hidden-id",
            visible: true,
            document: document("tile-hidden-id", { hidden: true }),
          },
        ],
      },
      regions: {
        placeables: [
          {
            id: "gm-region-id",
            isVisible: true,
            visible: true,
            document: visibleRegionDocument,
          },
          {
            id: "hidden-region-id",
            isVisible: false,
            visible: false,
            document: document("hidden-region-id", { hidden: true }),
          },
        ],
      },
      walls: {
        placeables: [
          {
            id: "blocking-wall-id",
            visible: true,
            document: document("blocking-wall-id", { c: [5, -5, 5, 5], door: 0, sight: 1 }),
          },
          {
            id: "public-door-id",
            visible: false,
            doorControl: { visible: true, renderable: true },
            document: document("public-door-id", {
              c: [1, 2, 3, 4],
              door: 1,
              ds: 0,
              flags: { "foundry-local-api": { exit: true, destination: "gm-destination-id" } },
            }),
          },
          {
            id: "secret-door-id",
            visible: true,
            doorControl: { visible: true },
            document: document("secret-door-id", { c: [5, 6, 7, 8], door: 2, ds: 0 }),
          },
        ],
      },
      effects: {
        visionSources,
        lightSources,
      },
      visibility,
      fog: { exploration: { toObject: () => ({ explored: "unchanged" }) } },
      ...(options.assetFailure ? { primary: { background: { texture: { valid: false } } } } : {}),
    },
  });
  return { source: sceneSource, calls };
}

afterEach(() => {
  if (savedGame) Object.defineProperty(globalThis, "game", savedGame);
  else Reflect.deleteProperty(globalThis, "game");
  if (savedCanvas) Object.defineProperty(globalThis, "canvas", savedCanvas);
  else Reflect.deleteProperty(globalThis, "canvas");
  if (savedConfig) Object.defineProperty(globalThis, "CONFIG", savedConfig);
  else Reflect.deleteProperty(globalThis, "CONFIG");
});

void it("independent post-await identity and consent revocation cannot return claims", async () => {
  for (const change of [
    (g: any) => (g.world.id = "other"),
    (g: any) => (g.user.id = "other"),
    (g: any) => (g.user.isGM = true),
    (g: any) => (g.settings.get = () => false),
    (g: any) => (g.collections.get("Scene").get("scene").testUserPermission = () => false),
  ]) {
    install();
    const g = (globalThis as any).game,
      r = (globalThis as any).canvas;
    const original = r.scene.toObject;
    let seen = 0;
    r.scene.toObject = () => {
      const v = original();
      if (++seen === 2) change(g);
      return v;
    };
    await assert.rejects(
      inspectSceneVisibility({
        sceneId: "scene",
        effectiveUserId: "player",
        tokenId: "token-selected",
      }),
    );
  }
});
void it("independent missing readiness and source replacement never retain visible evidence", async () => {
  for (const mutate of [
    (r: any) => delete r.perception,
    (r: any) => (r.ready = false),
    (r: any) => (r.perception.renderFlags.size = 2),
  ]) {
    install();
    const r = (globalThis as any).canvas;
    mutate(r);
    const out = await renderSceneSnapshot({
      sceneId: "scene",
      effectiveUserId: "player",
      tokenId: "token-selected",
    });
    assert.notEqual(out.observation.readiness, "ready");
    assert.deepEqual(out.visible, { tokens: [], notes: [], tiles: [] });
    assert.equal(out.image, null);
    assert.deepEqual(out.visibleBarriers, []);
  }
});
void it("independent explicit elevation reaches native detection config and invalid coordinates reject", async () => {
  install();
  const seen: number[] = [];
  const original = (globalThis as any).CONFIG.Canvas.detectionModes.basicSight.testVisibility;
  (globalThis as any).CONFIG.Canvas.detectionModes.basicSight.testVisibility = function (
    ...args: any[]
  ) {
    seen.push(args[2].tests[0].point.elevation);
    return original.apply(this, args);
  };
  await inspectSceneVisibility({
    sceneId: "scene",
    effectiveUserId: "player",
    tokenId: "token-selected",
    queryPoints: [{ id: "q", x: 1, y: 1, elevation: 9 }],
  });
  assert.ok(seen.includes(9));
  await assert.rejects(
    inspectSceneVisibility({
      sceneId: "scene",
      effectiveUserId: "player",
      tokenId: "token-selected",
      queryPoints: [{ id: "q", x: 1, y: 1, elevation: NaN }],
    }),
  );
});
void it("independent ownership and token/scene replacement during observation reject", async () => {
  for (const change of [
    (r: any) => (r.tokens.placeables[0].document.testUserPermission = () => false),
    (r: any) => (r.scene = { ...r.scene }),
    (r: any) => (r.tokens.placeables[0] = { ...r.tokens.placeables[0] }),
  ]) {
    install();
    const r = (globalThis as any).canvas,
      orig = r.scene.toObject;
    let n = 0;
    r.scene.toObject = () => {
      const v = orig();
      if (++n === 2) change(r);
      return v;
    };
    await assert.rejects(
      inspectSceneVisibility({
        sceneId: "scene",
        effectiveUserId: "player",
        tokenId: "token-selected",
      }),
    );
  }
});
void it("independent explicit query elevation governs region containment as well as detection", async () => {
  install();
  const r = (globalThis as any).canvas;
  r.regions.placeables[0].document.testPoint = ({ elevation }: { elevation: number }) =>
    elevation === 9;
  const out = await inspectSceneVisibility({
    sceneId: "scene",
    effectiveUserId: "player",
    tokenId: "token-selected",
    queryPoints: [
      { id: "high", x: 1, y: 1, elevation: 9 },
      { id: "low", x: 1, y: 1 },
    ],
  });
  assert.equal(out.queryPoints[0]?.regions.length, 1);
  assert.equal(out.queryPoints[1]?.regions.length, 0);
});
void it("independent active scene access is exact-loaded only and keeps player/token boundaries", async () => {
  install();
  let r = (globalThis as any).canvas;
  const g = (globalThis as any).game;
  const scene = g.collections.get("Scene").get("scene");
  scene.active = true;
  scene.testUserPermission = () => false;
  const out = await inspectSceneVisibility({
    sceneId: "scene",
    effectiveUserId: "player",
    tokenId: "token-selected",
  });
  assert.equal(out.observation.isGM, false);
  r.scene = { id: "different" };
  await assert.rejects(
    inspectSceneVisibility({
      sceneId: "scene",
      effectiveUserId: "player",
      tokenId: "token-selected",
    }),
  );
  install();
  r = (globalThis as any).canvas;
  const inactive = (globalThis as any).game.collections.get("Scene").get("scene");
  inactive.active = false;
  inactive.testUserPermission = () => false;
  await assert.rejects(
    inspectSceneVisibility({
      sceneId: "scene",
      effectiveUserId: "player",
      tokenId: "token-selected",
    }),
  );
});
void it("independent active scene ownershipNONE permission revoked midread denies", async () => {
  install();
  const scene = (globalThis as any).game.collections.get("Scene").get("scene");
  scene.active = true;
  scene.testUserPermission = () => false;
  const orig = scene.toObject;
  let n = 0;
  scene.toObject = () => {
    const v = orig();
    if (++n === 2) scene.active = false;
    return v;
  };
  await assert.rejects(
    inspectSceneVisibility({
      sceneId: "scene",
      effectiveUserId: "player",
      tokenId: "token-selected",
    }),
  );
});
void it("independent clipped FOV query is occluded, never asserted outside pure range", async () => {
  install({ selectedDetection: (x) => x > 0 && x < 5 });
  const r = (globalThis as any).canvas;
  r.tokens.placeables[0].vision.shape.contains = (x: number) => x < 5;
  const out = await inspectSceneVisibility({
    sceneId: "scene",
    effectiveUserId: "player",
    tokenId: "token-selected",
    queryPoints: [
      { id: "behind", x: 8, y: 1 },
      { id: "unknown", x: -10000, y: -10000 },
    ],
  });
  assert.equal(out.queryPoints[0]?.visible, false);
  assert.equal(out.queryPoints[0]?.blockerAttribution, "visible-wall");
  assert.equal(out.queryPoints[1]?.blockerAttribution, "environment-ambiguous");
  assert.ok(out.queryPoints.every((p) => p.blockerAttribution !== "out-of-range"));
});
