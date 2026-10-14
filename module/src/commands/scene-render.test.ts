import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import { SCENE_RENDER_LIMITS } from "@foundry-local-api/shared";
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
      world: {id:"world"},
      settings: {get: () => true},
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
      perception: {renderFlags: {size:0}},
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

void describe("scene render commands", () => {
  void it("uses the stored-fog canonical projection for the rendered fog revision", async () => {
    install();
    const runtime = (globalThis as any).canvas;
    runtime.fog.exploration.toObject = () => ({
      _id: "fog-document-id",
      scene: "scene",
      user: "player",
      explored: "unchanged",
      positions: { token: { x: 1, y: 2 } },
    });
    const result = await inspectSceneVisibility({
      sceneId: "scene",
      effectiveUserId: "player",
      tokenId: "token-selected",
    });
    const canonical =
      '{"exists":true,"state":{"explored":"unchanged","positions":{"token":{"x":1,"y":2}}}}';
    assert.equal(result.fogRevision, createHash("sha256").update(canonical).digest("hex"));
  });

  void it("fails closed when rendered fog cannot be serialized", async () => {
    install();
    (globalThis as any).canvas.fog.exploration.toObject = () => {
      throw new Error("private runtime detail");
    };

    const result = await inspectSceneVisibility({
      sceneId: "scene",
      effectiveUserId: "player",
      tokenId: "token-selected",
    });

    assert.equal(result.fogRevision, null);
    assert.equal(result.environment.fog, "incomplete");
    assert.ok(result.issues.some(({ code }) => code === "FOG_UNAVAILABLE"));
    assert.doesNotMatch(JSON.stringify(result), /private runtime detail/);
  });

  void it("uses the exact player and owned Token context without leaking hidden identities", async () => {
    const { source, calls } = install();
    const result = await renderSceneSnapshot({
      sceneId: "scene",
      effectiveUserId: "player",
      tokenId: "token-selected",
      includeImage: true,
      queryPoints: [
        { id: "clear", x: 1, y: 1 },
        { id: "blocked", x: 8, y: 1 },
      ],
    });
    assert.equal(result.status, "complete");
    assert.deepEqual(result.visible, {
      tokens: ["token-selected"],
      notes: ["note-public"],
      tiles: ["tile-public"],
    });
    assert.deepEqual(result.queryPoints, [
      {
        id: "clear",
        visible: true,
        regions: ["region-1"],
        blockerAttribution: "none",
        blockerKeys: [],
      },
      {
        id: "blocked",
        visible: false,
        regions: [],
        blockerAttribution: "visible-wall",
        blockerKeys: ["blocker-1"],
      },
    ]);
    assert.deepEqual(result.regions, [
      { key: "region-1", containsSelectedToken: true, effects: "active" },
    ]);
    assert.equal(result.environment.regions, "complete");
    assert.deepEqual(result.visibleBarriers, [
      {
        key: "blocker-1",
        kind: "barrier",
        state: "unknown",
        blocksVision: true,
        exit: false,
        destination: "redacted",
      },
      {
        key: "barrier-2",
        kind: "door",
        state: "closed",
        blocksVision: true,
        exit: true,
        destination: "redacted",
      },
    ]);
    assert.equal(result.environment.fog, "complete");
    assert.equal(result.environment.vision, "complete");
    assert.deepEqual(result.isolation, {
      status: "complete",
      method: "foundry-v14-detection-modes",
      detectionModes: 1,
      unrelatedVisionSourcesIgnored: 0,
      visionProvidingLightsIgnored: 0,
    });
    assert.equal(calls.union, 0);
    assert.equal(result.environment.darknessLevel, 0.5);
    assert.equal(result.effectiveSources.light, 1);
    assert.equal(result.persistence.unchanged, true);
    assert.equal(result.image?.bytes, 3);
    const serialized = JSON.stringify(result);
    for (const secret of [
      "token-occluded-secret-id",
      "note-secret-id",
      "tile-hidden-id",
      "gm-region-id",
      "hidden-region-id",
      "public-door-id",
      "blocking-wall-id",
      "secret-door-id",
      "gm-destination-id",
      "[1,2,3,4]",
    ])
      assert.equal(serialized.includes(secret), false, secret);
    assert.deepEqual(source, {
      _id: "scene",
      name: "Fixture",
      revisionMarker: 1,
      darkness: 0.5,
      globalLight: false,
      fogExploration: true,
    });
  });

  void it("rejects user substitution, missing Tokens, and non-owned Tokens", async () => {
    install();
    await assert.rejects(
      inspectSceneVisibility({
        sceneId: "scene",
        effectiveUserId: "gm",
        tokenId: "token-selected",
      }),
      (error: unknown) => (error as { code?: string }).code === "PERMISSION_DENIED",
    );
    await assert.rejects(
      inspectSceneVisibility({ sceneId: "scene", effectiveUserId: "player", tokenId: "missing" }),
      (error: unknown) => (error as { code?: string }).code === "NOT_FOUND",
    );
    install({ tokenOwner: false });
    await assert.rejects(
      inspectSceneVisibility({
        sceneId: "scene",
        effectiveUserId: "player",
        tokenId: "token-selected",
      }),
      (error: unknown) => (error as { code?: string }).code === "PERMISSION_DENIED",
    );
  });

  void it("projects Foundry v14 nested darkness, global light, and fog mode", async () => {
    install({ v14Environment: true });
    const result = await inspectSceneVisibility({
      sceneId: "scene",
      effectiveUserId: "player",
      tokenId: "token-selected",
    });
    assert.equal(result.environment.darknessLevel, 0.25);
    assert.equal(result.environment.globalLight, true);
    assert.equal(result.environment.fogExplorationEnabled, true);
    assert.equal(result.environment.darkness, "complete");
  });

  void it("returns typed asset and unsupported results", async () => {
    install({ extraction: "fail" });
    const asset = await renderSceneSnapshot({
      sceneId: "scene",
      effectiveUserId: "player",
      tokenId: "token-selected",
    });
    assert.equal(asset.status, "asset_error");
    assert.equal(asset.image, null);
    assert.ok(asset.issues.some((issue) => issue.code === "ASSET_CAPTURE_FAILED"));

    Reflect.deleteProperty((globalThis as any).canvas, "regions");
    const unsupported = await inspectSceneVisibility({
      sceneId: "scene",
      effectiveUserId: "player",
      tokenId: "token-selected",
    });
    assert.equal(unsupported.status, "unsupported");
    assert.equal(unsupported.environment.regions, "unsupported");
    assert.ok(unsupported.issues.some((issue) => issue.code === "REGION_SUPPORT_UNAVAILABLE"));
  });

  void it("fails closed for malformed visible Region evidence without disclosing identity", async () => {
    install();
    const runtime = (globalThis as any).canvas;
    runtime.regions.placeables.push({
      id: "malformed-secret-region-id",
      isVisible: true,
      visible: true,
      document: document("malformed-secret-region-id"),
    });
    const result = await inspectSceneVisibility({
      sceneId: "scene",
      effectiveUserId: "player",
      tokenId: "token-selected",
    });
    assert.equal(result.status, "incomplete");
    assert.equal(result.environment.regions, "incomplete");
    assert.ok(result.issues.some(({ code }) => code === "REGION_EVIDENCE_INCOMPLETE"));
    assert.equal(JSON.stringify(result).includes("malformed-secret-region-id"), false);
  });

  void it("redacts behavior state when an always-visible Region is not observable", async () => {
    install();
    const runtime = (globalThis as any).canvas;
    const selectedTokenDocument = runtime.tokens.placeables[0].document;
    runtime.regions.placeables.push({
      id: "always-visible-region-id",
      isVisible: true,
      visible: true,
      document: {
        ...document("always-visible-region-id"),
        testUserPermission: () => false,
        testPoint: ({ x }: { x: number }) => x < 5,
        tokens: new Set([selectedTokenDocument]),
        behaviors: new Map([["secret-behavior-id", { active: true, viewed: true }]]),
      },
    });
    const result = await inspectSceneVisibility({
      sceneId: "scene",
      effectiveUserId: "player",
      tokenId: "token-selected",
    });
    assert.equal(result.environment.regions, "complete");
    assert.deepEqual(result.regions[1], {
      key: "region-2",
      containsSelectedToken: true,
      effects: "redacted",
    });
    assert.doesNotMatch(JSON.stringify(result), /always-visible-region-id|secret-behavior-id/);
  });

  void it("supports image, structured snapshot, and visibility-only modes", async () => {
    install({ extraction: "fail" });
    const structured = await renderSceneSnapshot({
      sceneId: "scene",
      effectiveUserId: "player",
      tokenId: "token-selected",
      includeImage: false,
    });
    assert.equal(structured.image, null);
    assert.equal(structured.status, "complete");
    assert.equal(
      structured.issues.some(({ code }) => code.startsWith("ASSET_CAPTURE")),
      false,
    );
    const visibility = await inspectSceneVisibility({
      sceneId: "scene",
      effectiveUserId: "player",
      tokenId: "token-selected",
    });
    assert.equal("image" in visibility, false);
    assert.equal("capturedAt" in visibility, true);
  });

  void it("refuses a union-view image and isolates structured entities to the selected Token", async () => {
    const { calls } = install({ extraVision: true });
    const runtime = (globalThis as any).canvas;
    runtime.tokens.placeables[1].visible = true;
    runtime.tokens.placeables[1].center = { x: 60, y: 1 };
    const result = await renderSceneSnapshot({
      sceneId: "scene",
      effectiveUserId: "player",
      tokenId: "token-selected",
      queryPoints: [{ id: "other-source-only", x: 60, y: 1 }],
    });
    assert.equal(result.status, "asset_error");
    assert.equal(result.image, null);
    assert.deepEqual(result.visible.tokens, ["token-selected"]);
    assert.deepEqual(result.queryPoints, [
      {
        id: "other-source-only",
        visible: false,
        regions: [],
        blockerAttribution: "visible-wall",
        blockerKeys: ["blocker-1"],
      },
    ]);
    assert.equal(result.isolation.unrelatedVisionSourcesIgnored, 1);
    assert.equal(calls.union, 0);
    assert.equal(calls.unrelatedDetection, 0);
    assert.ok(result.issues.some(({ code }) => code === "ASSET_CAPTURE_UNAVAILABLE"));
  });

  void it("does not inherit a vision-providing light for structured visibility", async () => {
    const { calls } = install({ visionProvidingLight: true });
    const runtime = (globalThis as any).canvas;
    runtime.tokens.placeables[1].visible = true;
    runtime.tokens.placeables[1].center = { x: 60, y: 1 };
    const result = await inspectSceneVisibility({
      sceneId: "scene",
      effectiveUserId: "player",
      tokenId: "token-selected",
      queryPoints: [{ id: "light-only", x: 60, y: 1 }],
    });
    assert.equal(result.status, "complete");
    assert.deepEqual(result.visible.tokens, ["token-selected"]);
    assert.equal(result.queryPoints[0]?.visible, false);
    assert.equal(result.isolation.visionProvidingLightsIgnored, 1);
    assert.equal(calls.union, 0);
  });

  void it("evaluates only the selected Token detection modes", async () => {
    const { calls } = install({ extraVision: true, selectedDetection: (x) => x < 3 });
    const result = await inspectSceneVisibility({
      sceneId: "scene",
      effectiveUserId: "player",
      tokenId: "token-selected",
      queryPoints: [{ id: "selected-detection-denies", x: 3, y: 1 }],
    });
    assert.deepEqual(result.visible.notes, ["note-public"]);
    assert.deepEqual(result.visible.tiles, []);
    assert.equal(result.queryPoints[0]?.visible, false);
    assert.ok(calls.selectedDetection > 0);
    assert.equal(calls.unrelatedDetection, 0);
    assert.equal(calls.union, 0);
  });

  void it("applies special detection only to Token targets", async () => {
    const { calls } = install({ specialPreparedMode: true });
    const runtime = (globalThis as any).canvas;
    runtime.tokens.placeables[1].visible = true;
    runtime.notes.placeables.push({
      id: "note-special-only",
      center: { x: 8, y: 1 },
      visible: true,
      document: document("note-special-only"),
    });
    runtime.tiles.placeables.push({
      id: "tile-special-only",
      center: { x: 8, y: 1 },
      visible: true,
      document: document("tile-special-only"),
    });
    runtime.regions.placeables.push({
      id: "region-special-only",
      isVisible: true,
      visible: true,
      document: Object.assign(document("region-special-only"), {
        testPoint: ({ x }: { x: number }) => x > 7,
        tokens: new Set(),
        behaviors: new Map(),
      }),
    });
    runtime.walls.placeables.push({
      id: "exit-special-only",
      visible: true,
      doorControl: { visible: true, renderable: true },
      document: document("exit-special-only", {
        c: [8, 2, 8, 4],
        door: 1,
        ds: 1,
        sight: 0,
        flags: { "foundry-local-api": { exit: true, destination: "secret-destination" } },
      }),
    });
    const result = await inspectSceneVisibility({
      sceneId: "scene",
      effectiveUserId: "player",
      tokenId: "token-selected",
      queryPoints: [{ id: "special-point", x: 8, y: 1 }],
    });
    assert.deepEqual(result.visible.tokens, ["token-occluded-secret-id", "token-selected"]);
    assert.deepEqual(result.visible.notes, ["note-public"]);
    assert.deepEqual(result.visible.tiles, ["tile-public"]);
    assert.equal(result.queryPoints[0]?.visible, false);
    assert.deepEqual(result.regions, [
      { key: "region-1", containsSelectedToken: true, effects: "active" },
    ]);
    assert.equal(result.visibleBarriers.length, 2);
    assert.equal(
      result.visibleBarriers.some(({ exit }) => exit),
      true,
    );
    assert.equal(JSON.stringify(result).includes("secret-destination"), false);
    assert.equal(calls.unrelatedDetection, 1);
  });

  void it("does not claim complete isolation from raw unprepared detection data", async () => {
    const { calls } = install({ missingPreparedModes: true, rawSpecialMode: true });
    const result = await inspectSceneVisibility({
      sceneId: "scene",
      effectiveUserId: "player",
      tokenId: "token-selected",
    });
    assert.equal(result.status, "incomplete");
    assert.equal(result.environment.vision, "incomplete");
    assert.equal(result.isolation.status, "incomplete");
    assert.equal(result.isolation.method, "selected-source-polygons");
    assert.equal(calls.unrelatedDetection, 0);
    assert.ok(result.issues.some(({ code }) => code === "SELECTED_VISION_ISOLATION_INCOMPLETE"));
  });

  void it("returns typed incomplete evidence when exact v14 detection evaluation is unavailable", async () => {
    install({ missingExactApi: true });
    const result = await inspectSceneVisibility({
      sceneId: "scene",
      effectiveUserId: "player",
      tokenId: "token-selected",
    });
    assert.equal(result.status, "incomplete");
    assert.equal(result.environment.vision, "incomplete");
    assert.equal(result.isolation.status, "incomplete");
    assert.equal(result.isolation.method, "selected-source-polygons");
    assert.ok(result.issues.some(({ code }) => code === "SELECTED_VISION_ISOLATION_INCOMPLETE"));
  });

  void it("marks selected-source detection evaluation failures incomplete", async () => {
    install({
      selectedDetection: () => {
        throw new Error("detection failed");
      },
    });
    const result = await inspectSceneVisibility({
      sceneId: "scene",
      effectiveUserId: "player",
      tokenId: "token-selected",
    });
    assert.equal(result.status, "incomplete");
    assert.equal(result.environment.vision, "incomplete");
    assert.equal(result.isolation.status, "incomplete");
    assert.ok(result.issues.some(({ code }) => code === "SELECTED_VISION_EVALUATION_FAILED"));
  });

  void it("fails closed with typed unsupported evidence for an unattributable vision source", async () => {
    install();
    delete (globalThis as any).canvas.tokens.placeables[0].vision.object;
    const result = await inspectSceneVisibility({
      sceneId: "scene",
      effectiveUserId: "player",
      tokenId: "token-selected",
    });
    assert.equal(result.status, "unsupported");
    assert.equal(result.environment.vision, "unsupported");
    assert.equal(result.isolation.status, "unsupported");
    assert.deepEqual(result.visible, {
      tokens: ["token-selected"],
      notes: [],
      tiles: [],
    });
    assert.ok(result.issues.some(({ code }) => code === "SELECTED_VISION_ISOLATION_UNAVAILABLE"));
  });

  void it("reports player-visible asset failure without disclosing its path", async () => {
    install({ assetFailure: true });
    const result = await inspectSceneVisibility({
      sceneId: "scene",
      effectiveUserId: "player",
      tokenId: "token-selected",
    });
    assert.equal(result.status, "incomplete");
    const diagnostic = result.issues.find(({ code }) => code === "ASSET_CAPTURE_FAILED");
    assert.match(diagnostic?.subjectId ?? "", /^asset-\d+$/);
    assert.equal(JSON.stringify(result).includes("secret/assets/player-background.png"), false);
  });

  void it("attributes visible occlusion while retaining successful negative queries with unknown causes", async () => {
    install();
    const result = await inspectSceneVisibility({
      sceneId: "scene",
      effectiveUserId: "player",
      tokenId: "token-selected",
      queryPoints: [
        { id: "wall-blocked", x: 8, y: 1 },
        { id: "ambiguous", x: 8, y: -100 },
      ],
    });
    assert.ok(result.visibleBarriers.some(({ key }) => key.startsWith("blocker-")));
    assert.equal(result.queryPoints[0]?.blockerAttribution, "visible-wall");
    assert.deepEqual(result.queryPoints[0]?.blockerKeys, ["blocker-1"]);
    assert.equal(result.queryPoints[1]?.blockerAttribution, "environment-ambiguous");
    assert.deepEqual(result.queryPoints[1]?.blockerKeys, []);
    assert.equal(
      result.issues.some(
        ({ code, subjectId }) => code === "QUERY_FAILED" && subjectId === "wall-blocked",
      ),
      false,
    );
    assert.equal(
      result.issues.some(
        ({ code, subjectId }) => code === "QUERY_FAILED" && subjectId === "ambiguous",
      ),
      false,
    );
    assert.equal(result.status, "complete");
  });

  void it("keeps secret, lighting and range negative results uniformly unknown without a secret-specific status", async () => {
    for (const cause of ["secret", "lighting", "range"] as const) {
      install({ selectedDetection: x => x < 5 });
      const runtime = (globalThis as any).canvas;
      runtime.walls.placeables = cause === "secret" ? [{
        id: "private-secret-door", visible: true, doorControl: { visible: true },
        document: document("private-secret-door", { c: [5, -5, 5, 5], door: 2, ds: 0, sight: 20 }),
      }] : [];
      const result = await inspectSceneVisibility({ sceneId: "scene", effectiveUserId: "player", tokenId: "token-selected",
        queryPoints: [{ id: "known-negative", x: cause === "range" ? 10000 : 8, y: 1 }] });
      assert.equal(result.status, "complete", cause);
      assert.deepEqual(result.queryPoints, [{ id: "known-negative", visible: false, regions: [], blockerAttribution: "environment-ambiguous", blockerKeys: [] }]);
      assert.equal(result.issues.some(({ code }) => code === "QUERY_FAILED"), false);
      assert.deepEqual(result.visibleBarriers, []);
      assert.equal(result.redaction.secretDoors, true);
      assert.doesNotMatch(JSON.stringify(result), /private-secret-door/);
    }
  });

  void it("retains failed native query evaluation as incomplete without exposing its private error", async () => {
    install({ selectedDetection: x => { if (x === 8) throw Error("private-secret-evaluation-detail"); return x < 5; } });
    (globalThis as any).canvas.walls.placeables = [];
    const result = await inspectSceneVisibility({ sceneId: "scene", effectiveUserId: "player", tokenId: "token-selected", queryPoints: [{ id: "failed-native-query", x: 8, y: 1 }] });
    assert.equal(result.status, "incomplete");
    assert.equal(result.environment.vision, "incomplete");
    assert.ok(result.issues.some(({ code, subjectId }) => code === "SELECTED_VISION_EVALUATION_FAILED" && subjectId === "failed-native-query"));
    assert.equal(result.queryPoints[0]?.visible, false);
    assert.doesNotMatch(JSON.stringify(result), /private-secret-evaluation-detail/);
  });

  void it("fails closed when the selected Token has no usable canvas center", async () => {
    install();
    delete (globalThis as any).canvas.tokens.placeables[0].center;
    await assert.rejects(
      inspectSceneVisibility({
        sceneId: "scene",
        effectiveUserId: "player",
        tokenId: "token-selected",
      }),
      (error: unknown) => (error as { code?: string }).code === "UNSUPPORTED_TYPE",
    );
  });

  void it("bounds visible entities, coverage, barriers, and issues", async () => {
    install();
    const runtime = (globalThis as any).canvas;
    runtime.tokens.placeables.push(
      ...Array.from({ length: SCENE_RENDER_LIMITS.maxVisiblePerKind + 5 }, (_, index) => ({
        id: `extra-${index}`,
        center: { x: 2, y: 2 },
        visible: true,
        document: document(`extra-${index}`),
      })),
    );
    runtime.tokens.placeables[0].vision.shape.points = Array.from(
      { length: (SCENE_RENDER_LIMITS.maxCoveragePointsPerSource + 5) * 2 },
      (_, index) => index,
    );
    const result = await inspectSceneVisibility({
      sceneId: "scene",
      effectiveUserId: "player",
      tokenId: "token-selected",
    });
    assert.equal(result.visible.tokens.length, SCENE_RENDER_LIMITS.maxVisiblePerKind);
    assert.equal(
      result.coveragePolygons[0]?.points.length,
      SCENE_RENDER_LIMITS.maxCoveragePointsPerSource,
    );
    assert.equal(result.bounds.truncated, true);
    assert.ok(result.issues.length <= SCENE_RENDER_LIMITS.maxIssues);
  });
});

void it("requires direct non-GM consent and rechecks consent after asynchronous observation", async()=>{install();(globalThis as any).game.user.isGM=true;await assert.rejects(inspectSceneVisibility({sceneId:"scene",effectiveUserId:"player",tokenId:"token-selected"}));install();let checks=0;(globalThis as any).game.settings.get=()=>++checks===1;await assert.rejects(inspectSceneVisibility({sceneId:"scene",effectiveUserId:"player",tokenId:"token-selected"}));});
void it("pending or missing native render readiness clears every perception claim",async()=>{for(const pending of [1,null]){install();const runtime=(globalThis as any).canvas;if(pending===null)delete runtime.perception;else runtime.perception.renderFlags.size=pending;const result=await inspectSceneVisibility({sceneId:"scene",effectiveUserId:"player",tokenId:"token-selected",queryPoints:[{id:"q",x:1,y:1}]});assert.equal(result.observation.readiness,pending===null?"unavailable":"stale");assert.deepEqual(result.visible,{tokens:[],notes:[],tiles:[]});assert.deepEqual(result.regions,[]);assert.deepEqual(result.visibleBarriers,[]);assert.deepEqual(result.coveragePolygons,[]);assert.equal(result.queryPoints[0]?.visible,false);assert.equal(result.queryPoints[0]?.blockerAttribution,"unavailable");}});

void it("free visibility queries pass selected-token elevation by default and explicit elevation to native config",async()=>{install();const runtime=(globalThis as any).canvas;const selected=runtime.tokens.placeables.find((v:any)=>v.id==="token-selected");const originalSource=selected.document.toObject;selected.document.toObject=()=>({...originalSource(),elevation:7});const originalConfig=runtime.visibility._createVisibilityTestConfig;const points:any[]=[];runtime.visibility._createVisibilityTestConfig=(value:any[],options:any)=>{points.push(...value);return originalConfig(value,options);};await inspectSceneVisibility({sceneId:"scene",effectiveUserId:"player",tokenId:"token-selected",queryPoints:[{id:"default",x:1,y:1},{id:"explicit",x:1,y:1,elevation:9}]});assert.ok(points.some(v=>v.elevation===7));assert.ok(points.some(v=>v.elevation===9));});

void it("native active-scene viewing permits an owned perspective without Scene OBSERVER", async () => {
  install();
  const scene = (globalThis as any).canvas.scene;
  scene.active = true;
  scene.testUserPermission = () => false;
  const result = await inspectSceneVisibility({ sceneId: "scene", effectiveUserId: "player", tokenId: "token-selected" });
  assert.equal(result.observation.readiness, "ready");
  assert.equal(result.visible.tokens.includes("token-hidden"), false);
});

void it("inactive unobservable scenes and active permission revoked during observation reject", async () => {
  for (const revoke of [false, true]) {
    install();
    const scene = (globalThis as any).canvas.scene;
    scene.active = revoke;
    scene.testUserPermission = () => false;
    if (revoke) {
      const original = scene.toObject;
      scene.toObject = () => { const value = original(); scene.active = false; return value; };
    }
    await assert.rejects(inspectSceneVisibility({ sceneId: "scene", effectiveUserId: "player", tokenId: "token-selected" }),
      (error: unknown) => (error as { code?: string }).code === "PERMISSION_DENIED");
  }
});

void it("wall-clipped FOV exclusion never claims radial out-of-range", async () => {
  install({ selectedDetection: x => x > 0 && x < 6 });
  const runtime = (globalThis as any).canvas;
  const selected = runtime.tokens.placeables.find((value: any) => value.id === "token-selected");
  selected.vision.shape.contains = (x: number) => x < 6;
  const result = await inspectSceneVisibility({ sceneId: "scene", effectiveUserId: "player", tokenId: "token-selected",
    queryPoints: [{ id: "behind-closed-door", x: 8, y: 1 }, { id: "far-without-range-evidence", x: -10000, y: -10000 }] });
  assert.equal(result.queryPoints[0]?.visible, false);
  assert.equal(result.queryPoints[0]?.blockerAttribution, "visible-wall");
  assert.equal(result.queryPoints[1]?.blockerAttribution, "environment-ambiguous");
  assert.equal(result.queryPoints.some(point => point.blockerAttribution === "out-of-range"), false);
});
