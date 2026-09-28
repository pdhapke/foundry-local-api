import assert from "node:assert/strict";
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
    assetFailure?: boolean;
  } = {},
) {
  const calls = { union: 0, selectedDetection: 0, unrelatedDetection: 0 };
  const user = { id: options.userId ?? "player", isGM: false };
  const sceneSource = {
    _id: "scene",
    name: "Fixture",
    revisionMarker: 1,
    darkness: 0.5,
    globalLight: false,
    fogExploration: true,
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
    { sight: { enabled: true } },
    options.tokenOwner !== false,
  );
  const secretJournal = document("secret-journal", { hidden: true });
  Object.defineProperty(globalThis, "game", {
    configurable: true,
    value: {
      user,
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
            visible: true,
            document: document("gm-region-id"),
            testPoint: ({ x }: { x: number }) => x < 5,
          },
          {
            id: "hidden-region-id",
            visible: false,
            document: document("hidden-region-id"),
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
      { id: "clear", visible: true, regions: ["region-1"] },
      { id: "blocked", visible: false, regions: [] },
    ]);
    assert.deepEqual(result.regions, [{ key: "region-1" }]);
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
    assert.equal("capturedAt" in visibility, false);
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
      { id: "other-source-only", visible: false, regions: [] },
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

  void it("attributes each in-range occlusion independently and flags ambiguous blockers", async () => {
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
      true,
    );
    assert.equal(result.status, "incomplete");
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
