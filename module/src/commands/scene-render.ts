import {
  ProtocolError,
  SCENE_RENDER_COMMANDS,
  SCENE_RENDER_LIMITS,
  type SceneRenderInput,
  type SceneRenderIssue,
  type SceneRenderResult,
  type SceneRenderStatus,
  type SceneVisibilityResult,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";

interface PermissionDocument extends FoundryDocument {
  testUserPermission?: ((user: FoundryUser, permission: string) => boolean) | undefined;
}

interface SafeRegion {
  key: string;
  placeable: any;
}

interface SelectedVisionIsolation {
  source: any | null;
  status: "complete" | "incomplete" | "unsupported";
  method: "foundry-v14-detection-modes" | "selected-source-polygons" | null;
  detectionModes: number;
  unrelatedVisionSourcesIgnored: number;
  visionProvidingLightsIgnored: number;
  test(point: { x: number; y: number }, target: any, subjectId?: string): boolean;
}

async function fingerprint(value: unknown): Promise<string> {
  const text = JSON.stringify(value);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sourceOf(document: PermissionDocument | undefined): Record<string, unknown> {
  try {
    const value = document?.toObject();
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function permitted(
  document: PermissionDocument | undefined,
  permission: "OBSERVER" | "OWNER",
): boolean {
  if (!document) return false;
  try {
    return document.testUserPermission?.(game.user, permission) === true;
  } catch {
    return false;
  }
}

function requirePerspective(input: SceneRenderInput): {
  runtime: any;
  scene: PermissionDocument;
  token: any;
  tokenDocument: PermissionDocument;
} {
  if (game.user.id !== input.effectiveUserId) {
    throw new ProtocolError({
      code: "PERMISSION_DENIED",
      message: "The rendering client does not match the selected effective user.",
      retryable: false,
    });
  }
  const runtime = canvas as any;
  if (!runtime || runtime.scene?.id !== input.sceneId) {
    throw new ProtocolError({
      code: "INVALID_PAYLOAD",
      message: "The requested Scene is not loaded on the selected client; preload it first.",
      retryable: true,
      fieldPath: "sceneId",
    });
  }
  const scene = game.collections.get("Scene")?.get(input.sceneId) as PermissionDocument | undefined;
  if (!scene || !permitted(scene, "OBSERVER")) {
    throw new ProtocolError({
      code: "PERMISSION_DENIED",
      message: "The selected user cannot render this Scene.",
      retryable: false,
    });
  }
  const token = (runtime.tokens?.placeables ?? []).find(
    (candidate: any) => (candidate.document?.id ?? candidate.id) === input.tokenId,
  );
  const tokenDocument = token?.document as PermissionDocument | undefined;
  if (!token || !tokenDocument) {
    throw new ProtocolError({
      code: "NOT_FOUND",
      message: "The selected Token is not present on the selected user's loaded Scene.",
      retryable: false,
      fieldPath: "tokenId",
    });
  }
  if (!permitted(tokenDocument, "OWNER")) {
    throw new ProtocolError({
      code: "PERMISSION_DENIED",
      message: "The selected user does not own the selected vision Token.",
      retryable: false,
      fieldPath: "tokenId",
    });
  }
  return { runtime, scene, token, tokenDocument };
}

function mayDisclose(document: PermissionDocument | undefined): boolean {
  const source = sourceOf(document);
  return source["hidden"] !== true && permitted(document, "OBSERVER");
}

function noteLinkVisible(document: PermissionDocument | undefined): boolean {
  if (!document || !mayDisclose(document)) return false;
  const source = sourceOf(document);
  const entryId = typeof source["entryId"] === "string" ? source["entryId"] : null;
  if (!entryId) return true;
  const journal = game.collections.get("JournalEntry")?.get(entryId) as
    (PermissionDocument & { pages?: Map<string, PermissionDocument> }) | undefined;
  if (!mayDisclose(journal)) return false;
  const pageId = typeof source["pageId"] === "string" ? source["pageId"] : null;
  return !pageId || mayDisclose(journal?.pages?.get(pageId));
}

function visibleIds(
  layer: any,
  kind: "Token" | "Note" | "Tile",
  issues: SceneRenderIssue[],
  token: any,
  isolation: SelectedVisionIsolation,
): string[] {
  const result: string[] = [];
  let exceeded = false;
  for (const placeable of layer?.placeables ?? []) {
    const id = placeable?.document?.id ?? placeable?.id;
    const document = placeable?.document as PermissionDocument | undefined;
    if (
      typeof id !== "string" ||
      placeable.visible !== true ||
      placeable.renderable === false ||
      !mayDisclose(document) ||
      (kind === "Note" && !noteLinkVisible(document))
    )
      continue;
    if (placeable !== token) {
      const center = placeableCenter(placeable);
      if (!center) {
        issues.push({
          code: "QUERY_FAILED",
          message: `A visible ${kind} could not be isolated to the selected Token perspective.`,
          retryable: true,
        });
        continue;
      }
      if (!isolation.test(center, placeable, id)) continue;
    }
    if (result.length >= SCENE_RENDER_LIMITS.maxVisiblePerKind) {
      exceeded = true;
      break;
    }
    result.push(id);
  }
  if (exceeded)
    issues.push({
      code: "VISIBLE_ENTITY_LIMIT_REACHED",
      message: `Visible ${kind} output reached its response limit.`,
      retryable: false,
    });
  return result.sort();
}

function placeableCenter(placeable: any): { x: number; y: number } | null {
  const x = finiteNumber(placeable?.center?.x);
  const y = finiteNumber(placeable?.center?.y);
  return x === null || y === null ? null : { x, y };
}

function visibleRegions(
  runtime: any,
  issues: SceneRenderIssue[],
  perspectivePoints: readonly { x: number; y: number }[],
): SafeRegion[] {
  if (!runtime.regions || !Array.isArray(runtime.regions.placeables)) {
    issues.push({
      code: "REGION_SUPPORT_UNAVAILABLE",
      message: "This client does not expose the Scene Region layer.",
      retryable: false,
    });
    return [];
  }
  const result: SafeRegion[] = [];
  let exceeded = false;
  for (const placeable of runtime.regions.placeables) {
    const document = placeable?.document as PermissionDocument | undefined;
    if (
      placeable?.visible !== true ||
      placeable?.renderable === false ||
      !mayDisclose(document) ||
      !perspectivePoints.some((point) => regionContains(placeable, point.x, point.y))
    )
      continue;
    if (result.length >= SCENE_RENDER_LIMITS.maxRegions) {
      exceeded = true;
      break;
    }
    result.push({ key: `region-${result.length + 1}`, placeable });
  }
  if (exceeded)
    issues.push({
      code: "REGION_LIMIT_REACHED",
      message: "Visible Region output reached its response limit.",
      retryable: false,
    });
  return result;
}

function regionContains(placeable: any, x: number, y: number): boolean {
  try {
    if (typeof placeable?.testPoint === "function") return placeable.testPoint({ x, y }) === true;
    if (typeof placeable?.containsPoint === "function")
      return placeable.containsPoint({ x, y }) === true;
    if (typeof placeable?.shape?.contains === "function")
      return placeable.shape.contains(x, y) === true;
  } catch {
    return false;
  }
  return false;
}

function visibleBarriers(
  runtime: any,
  issues: SceneRenderIssue[],
  isolation: SelectedVisionIsolation,
  origin: { x: number; y: number },
  queryPoints: Array<{ id: string; x: number; y: number; visible: boolean; inRange: boolean }>,
): {
  barriers: SceneVisibilityResult["visibleBarriers"];
  blockerKeysByQueryId: Map<string, string[]>;
} {
  const result: SceneVisibilityResult["visibleBarriers"] = [];
  const blockerKeysByQueryId = new Map<string, string[]>();
  let exceeded = false;
  for (const wall of runtime.walls?.placeables ?? []) {
    const source = sourceOf(wall.document as PermissionDocument | undefined);
    const door = Number(source["door"] ?? 0);
    const secret = door === 2;
    const visiblyRendered =
      wall.visible === true ||
      (door === 1 && wall.doorControl?.visible === true && wall.doorControl?.renderable !== false);
    if (source["hidden"] === true || secret || !visiblyRendered) continue;
    if (result.length >= SCENE_RENDER_LIMITS.maxBarriers) {
      exceeded = true;
      break;
    }
    const doorState = Number(source["ds"]);
    const state =
      door === 0
        ? "unknown"
        : doorState === 1
          ? "open"
          : doorState === 2
            ? "locked"
            : doorState === 0
              ? "closed"
              : "unknown";
    const moduleFlags = source["flags"] as Record<string, unknown> | undefined;
    const localFlags = moduleFlags?.["foundry-local-api"] as Record<string, unknown> | undefined;
    const blocksVision = Number(source["sight"] ?? 1) !== 0 && (door === 0 || state !== "open");
    const coordinates = wallCoordinates(source);
    if (!coordinates) {
      issues.push({
        code: "QUERY_FAILED",
        message: "A player-visible barrier had malformed geometry and was omitted.",
        retryable: false,
      });
      continue;
    }
    const attributedPoints = blocksVision
      ? queryPoints.filter(
          (point) =>
            !point.visible &&
            point.inRange &&
            segmentsIntersect(origin, point, coordinates[0], coordinates[1]),
        )
      : [];
    const midpoint = {
      x: (coordinates[0].x + coordinates[1].x) / 2,
      y: (coordinates[0].y + coordinates[1].y) / 2,
    };
    if (!attributedPoints.length && !isolation.test(midpoint, wall)) continue;
    const key = `${attributedPoints.length ? "blocker" : "barrier"}-${result.length + 1}`;
    result.push({
      key,
      kind: door === 0 ? "barrier" : "door",
      state,
      blocksVision,
      exit: localFlags?.["exit"] === true,
      destination: "redacted",
    });
    for (const point of attributedPoints) {
      const keys = blockerKeysByQueryId.get(point.id) ?? [];
      keys.push(key);
      blockerKeysByQueryId.set(point.id, keys);
    }
  }
  if (exceeded)
    issues.push({
      code: "BARRIER_LIMIT_REACHED",
      message: "Visible barrier output reached its response limit.",
      retryable: false,
    });
  return { barriers: result, blockerKeysByQueryId };
}

function wallCoordinates(
  source: Record<string, unknown>,
): readonly [{ x: number; y: number }, { x: number; y: number }] | null {
  const coordinates = source["c"];
  if (
    !Array.isArray(coordinates) ||
    coordinates.length !== 4 ||
    !coordinates.every((value) => typeof value === "number" && Number.isFinite(value))
  )
    return null;
  return [
    { x: coordinates[0] as number, y: coordinates[1] as number },
    { x: coordinates[2] as number, y: coordinates[3] as number },
  ];
}

function segmentsIntersect(
  firstStart: { x: number; y: number },
  firstEnd: { x: number; y: number },
  secondStart: { x: number; y: number },
  secondEnd: { x: number; y: number },
): boolean {
  const orientation = (
    a: { x: number; y: number },
    b: { x: number; y: number },
    c: { x: number; y: number },
  ) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const onSegment = (
    start: { x: number; y: number },
    candidate: { x: number; y: number },
    end: { x: number; y: number },
  ) =>
    candidate.x >= Math.min(start.x, end.x) &&
    candidate.x <= Math.max(start.x, end.x) &&
    candidate.y >= Math.min(start.y, end.y) &&
    candidate.y <= Math.max(start.y, end.y);
  const first = orientation(firstStart, firstEnd, secondStart);
  const second = orientation(firstStart, firstEnd, secondEnd);
  const third = orientation(secondStart, secondEnd, firstStart);
  const fourth = orientation(secondStart, secondEnd, firstEnd);
  if (first === 0 && onSegment(firstStart, secondStart, firstEnd)) return true;
  if (second === 0 && onSegment(firstStart, secondEnd, firstEnd)) return true;
  if (third === 0 && onSegment(secondStart, firstStart, secondEnd)) return true;
  if (fourth === 0 && onSegment(secondStart, firstEnd, secondEnd)) return true;
  return first > 0 !== second > 0 && third > 0 !== fourth > 0;
}

function selectedVision(token: any): any | null {
  const source = token?.vision;
  if (!source || source.active === false || source.disabled === true || source.suppressed === true)
    return null;
  if (source.object !== undefined && source.object !== token) return null;
  return source;
}

function activeSources(collection: any): any[] | null {
  if (!collection || typeof collection.values !== "function") return null;
  return Array.from(collection.values()).filter(
    (source: any) =>
      source &&
      source.active !== false &&
      source.disabled !== true &&
      source.suppressed !== true &&
      !Object.values(source.suppression ?? {}).some(Boolean),
  );
}

function visionProvidingLight(source: any): boolean {
  return source?.vision === true || source?.data?.vision === true;
}

function hasExclusiveSelectedVision(runtime: any, selected: any): boolean {
  const sources = runtime.effects?.visionSources;
  const active = activeSources(sources);
  const lights = activeSources(runtime.effects?.lightSources);
  return (
    active !== null &&
    active.length === 1 &&
    active[0] === selected &&
    lights !== null &&
    lights.every((source) => !visionProvidingLight(source))
  );
}

interface PreparedDetectionModes {
  all: Array<Record<string, unknown>>;
  normal: Array<Record<string, unknown>>;
  special: Array<Record<string, unknown>>;
}

const NORMAL_DETECTION_MODES = new Set(["basicSight", "lightPerception"]);

function preparedDetectionModes(token: any): PreparedDetectionModes | null {
  const raw = token?.document?.detectionModes;
  if (!raw || (typeof raw !== "object" && !(raw instanceof Map))) return null;
  const result: Array<Record<string, unknown>> = [];
  const append = (id: string, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const mode = value as Record<string, unknown>;
    const preparedId = typeof mode["id"] === "string" ? mode["id"] : id;
    if (
      preparedId.length === 0 ||
      typeof mode["enabled"] !== "boolean" ||
      (typeof mode["range"] !== "number" && mode["range"] !== null)
    )
      return;
    result.push({ id: preparedId, enabled: mode["enabled"], range: mode["range"] });
  };
  if (raw instanceof Map) for (const [id, value] of raw) append(String(id), value);
  else if (Array.isArray(raw))
    for (const value of raw) {
      if (!value || typeof value !== "object") continue;
      const id = (value as Record<string, unknown>)["id"];
      if (typeof id === "string") append(id, value);
    }
  else if (raw && typeof raw === "object")
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) append(id, value);
  const all = result.filter(({ enabled }) => enabled === true);
  if (!all.length) return null;
  return {
    all,
    normal: all.filter(({ id }) => NORMAL_DETECTION_MODES.has(String(id))),
    special: all.filter(({ id }) => !NORMAL_DETECTION_MODES.has(String(id))),
  };
}

function detectionModeRegistry(): Record<string, any> | Map<string, any> | null {
  const configured = (
    CONFIG as unknown as { Canvas?: { detectionModes?: Record<string, any> | Map<string, any> } }
  ).Canvas?.detectionModes;
  return configured ?? null;
}

function registryValue(registry: Record<string, any> | Map<string, any>, id: string): any {
  return registry instanceof Map ? registry.get(id) : registry[id];
}

function createSelectedVisionIsolation(
  runtime: any,
  token: any,
  issues: SceneRenderIssue[],
): SelectedVisionIsolation {
  const source = selectedVision(token);
  const activeVision = activeSources(runtime.effects?.visionSources);
  const activeLights = activeSources(runtime.effects?.lightSources);
  const unrelatedVisionSourcesIgnored = activeVision
    ? activeVision.filter((candidate) => candidate !== source).length
    : 0;
  const visionProvidingLightsIgnored = activeLights
    ? activeLights.filter(visionProvidingLight).length
    : 0;
  const polygonTest = (point: { x: number; y: number }) => {
    try {
      return (
        source?.shape?.contains?.(point.x, point.y) === true &&
        source?.los?.contains?.(point.x, point.y) === true
      );
    } catch {
      return false;
    }
  };
  if (!source) {
    return {
      source: null,
      status: "incomplete",
      method: null,
      detectionModes: 0,
      unrelatedVisionSourcesIgnored,
      visionProvidingLightsIgnored,
      test: () => false,
    };
  }
  if (
    typeof source.shape?.contains !== "function" ||
    typeof source.los?.contains !== "function" ||
    source.object !== token
  ) {
    issues.push({
      code: "SELECTED_VISION_ISOLATION_UNAVAILABLE",
      message: "The selected Token does not expose an attributable Foundry v14 vision source.",
      retryable: false,
      subjectId: token.document?.id ?? token.id,
    });
    return {
      source,
      status: "unsupported",
      method: null,
      detectionModes: 0,
      unrelatedVisionSourcesIgnored,
      visionProvidingLightsIgnored,
      test: () => false,
    };
  }
  const preparedModes = preparedDetectionModes(token);
  const modes = preparedModes?.all ?? [];
  const registry = detectionModeRegistry();
  const createConfig = runtime.visibility?._createVisibilityTestConfig;
  const definitions = registry
    ? modes.map((mode) => ({ mode, definition: registryValue(registry, String(mode["id"])) }))
    : [];
  const exact =
    typeof createConfig === "function" &&
    preparedModes !== null &&
    preparedModes.normal.length > 0 &&
    modes.length > 0 &&
    definitions.every(({ definition }) => typeof definition?.testVisibility === "function");
  if (!exact) {
    issues.push({
      code: "SELECTED_VISION_ISOLATION_INCOMPLETE",
      message:
        "Prepared Foundry v14 Token detection modes or exact evaluation are unavailable; selected-source polygon evidence is incomplete.",
      retryable: true,
      subjectId: token.document?.id ?? token.id,
    });
    return {
      source,
      status: "incomplete",
      method: "selected-source-polygons",
      detectionModes: modes.length,
      unrelatedVisionSourcesIgnored,
      visionProvidingLightsIgnored,
      test: (point) => polygonTest(point),
    };
  }
  return {
    source,
    status: "complete",
    method: "foundry-v14-detection-modes",
    detectionModes: modes.length,
    unrelatedVisionSourcesIgnored,
    visionProvidingLightsIgnored,
    test: (point, target, subjectId) => {
      try {
        const config = createConfig.call(runtime.visibility, [point], { object: target ?? null });
        const targetIsToken = runtime.tokens?.placeables?.includes?.(target) === true;
        const applicable = targetIsToken
          ? definitions
          : definitions.filter(({ mode }) => NORMAL_DETECTION_MODES.has(String(mode["id"])));
        return applicable.some(({ mode, definition }) =>
          definition.testVisibility(source, mode, config),
        );
      } catch {
        issues.push({
          code: "SELECTED_VISION_EVALUATION_FAILED",
          message: "The selected Token detection modes could not evaluate one visibility target.",
          retryable: true,
          ...(subjectId ? { subjectId } : {}),
        });
        return false;
      }
    },
  };
}

function effectiveLightCount(runtime: any, token: any): number | null {
  const center = placeableCenter(token);
  const sources = runtime.effects?.lightSources;
  if (!center || !sources || typeof sources.values !== "function") return null;
  let count = 0;
  for (const source of sources.values()) {
    try {
      if (!source || (source as any).active === false || (source as any).disabled === true)
        continue;
      const shape = (source as any).shape;
      if (typeof shape?.contains !== "function") return null;
      if (shape.contains(center.x, center.y) === true) count += 1;
    } catch {
      return null;
    }
  }
  return count;
}

function assetDiagnostics(
  runtime: any,
  sceneSource: Record<string, unknown>,
  visibleTileIds: readonly string[],
): SceneRenderIssue[] {
  const candidates: Array<{ configured: boolean; display: any }> = [];
  const configuredSource = (value: unknown): boolean =>
    typeof value === "string"
      ? value.length > 0
      : Boolean(
          value &&
          typeof value === "object" &&
          typeof (value as Record<string, unknown>)["src"] === "string" &&
          ((value as Record<string, unknown>)["src"] as string).length > 0,
        );
  candidates.push({
    configured: configuredSource(sceneSource["background"]),
    display: runtime.primary?.background ?? runtime.background,
  });
  candidates.push({
    configured: configuredSource(sceneSource["foreground"]),
    display: runtime.primary?.foreground ?? runtime.foreground,
  });
  for (const placeable of runtime.tiles?.placeables ?? []) {
    const id = placeable?.document?.id ?? placeable?.id;
    if (!visibleTileIds.includes(id)) continue;
    const source = sourceOf(placeable.document as PermissionDocument | undefined);
    candidates.push({ configured: configuredSource(source["texture"]), display: placeable });
  }
  return candidates.flatMap((candidate, index) => {
    if (!candidate.configured || textureLoaded(candidate.display)) return [];
    return [
      {
        code: "ASSET_CAPTURE_FAILED" as const,
        message: "A player-visible render asset was not ready on the selected client.",
        retryable: true,
        subjectId: `asset-${index + 1}`,
      },
    ];
  });
}

function textureLoaded(display: any): boolean {
  const texture = display?.texture;
  if (!texture) return false;
  if (texture.destroyed === true || texture.valid === false) return false;
  const base = texture.baseTexture ?? texture.source;
  if (!base) return texture.valid === true;
  return base.destroyed !== true && base.valid !== false;
}

function coveragePolygons(
  source: any,
  issues: SceneRenderIssue[],
): SceneVisibilityResult["coveragePolygons"] {
  const flat = source?.shape?.points;
  if (!Array.isArray(flat)) return [];
  const points: Array<{ x: number; y: number }> = [];
  const inputPointCount = Math.floor(flat.length / 2);
  const max = SCENE_RENDER_LIMITS.maxCoveragePointsPerSource;
  for (let index = 0; index + 1 < flat.length && points.length < max; index += 2) {
    if (typeof flat[index] === "number" && typeof flat[index + 1] === "number")
      points.push({ x: flat[index], y: flat[index + 1] });
  }
  if (inputPointCount > max)
    issues.push({
      code: "COVERAGE_LIMIT_REACHED",
      message: "Selected Token coverage polygon reached its response limit.",
      retryable: false,
    });
  return points.length ? [{ source: "selected-token", points }] : [];
}

function persistenceSource(scene: PermissionDocument): unknown {
  const runtime = canvas as any;
  return {
    scene: scene.toObject(),
    fog: runtime?.fog?.exploration?.toObject?.() ?? null,
    tokens: Array.from((scene as any).tokens?.values?.() ?? []).map((doc: any) => doc.toObject()),
  };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function imageBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  const payload = comma >= 0 ? dataUrl.slice(comma + 1) : "";
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

function boundedIssues(issues: SceneRenderIssue[]): SceneRenderIssue[] {
  return issues.slice(0, SCENE_RENDER_LIMITS.maxIssues);
}

function resultStatus(issues: SceneRenderIssue[], includeImage: boolean): SceneRenderStatus {
  if (
    issues.some(
      (issue) =>
        issue.code === "REGION_SUPPORT_UNAVAILABLE" ||
        issue.code === "VISIBILITY_API_UNAVAILABLE" ||
        issue.code === "SELECTED_VISION_ISOLATION_UNAVAILABLE",
    )
  )
    return "unsupported";
  if (
    includeImage &&
    issues.some(
      (issue) =>
        issue.code === "ASSET_CAPTURE_FAILED" ||
        issue.code === "ASSET_CAPTURE_UNAVAILABLE" ||
        issue.code === "ASSET_LIMIT_EXCEEDED",
    )
  )
    return "asset_error";
  return issues.length ? "incomplete" : "complete";
}

async function inspect(input: SceneRenderInput, includeImage: boolean): Promise<SceneRenderResult> {
  const { runtime, scene, token, tokenDocument } = requirePerspective(input);
  const beforeRevision = await fingerprint(persistenceSource(scene));
  const issues: SceneRenderIssue[] = [];
  const tokenSource = sourceOf(tokenDocument);
  const sceneSource = sourceOf(scene);
  const isolation = createSelectedVisionIsolation(runtime, token, issues);
  const selected = isolation.source;
  const tokenCenter = placeableCenter(token);
  if (!tokenCenter)
    throw new ProtocolError({
      code: "UNSUPPORTED_TYPE",
      message:
        "The selected Token does not expose a usable canvas center for perspective isolation.",
      retryable: false,
      fieldPath: "tokenId",
    });
  if (!selected)
    issues.push({
      code: "TOKEN_VISION_INACTIVE",
      message: "The selected Token has no active vision source on this client.",
      retryable: true,
      subjectId: input.tokenId,
    });
  if (!runtime.fog || !runtime.fog.exploration)
    issues.push({
      code: "FOG_UNAVAILABLE",
      message: "Fog exploration evidence is unavailable on this client.",
      retryable: true,
    });
  if (!runtime.effects?.lightSources)
    issues.push({
      code: "LIGHTING_UNAVAILABLE",
      message: "Effective light-source evidence is unavailable on this client.",
      retryable: true,
    });
  const darkness = finiteNumber(sceneSource["darkness"]);
  if (darkness === null)
    issues.push({
      code: "DARKNESS_UNAVAILABLE",
      message: "Scene darkness evidence is unavailable on this client.",
      retryable: false,
    });

  const tokens = visibleIds(runtime.tokens, "Token", issues, token, isolation);
  const notes = visibleIds(runtime.notes, "Note", issues, token, isolation);
  const tiles = visibleIds(runtime.tiles, "Tile", issues, token, isolation);
  issues.push(...assetDiagnostics(runtime, sceneSource, tiles));
  const evaluatedQueries = (input.queryPoints ?? []).map((point) => {
    let visible = false;
    let inRange = false;
    try {
      inRange = selected?.shape?.contains?.(point.x, point.y) === true;
      visible = Boolean(selected) && inRange && isolation.test(point, null, point.id);
    } catch {
      issues.push({
        code: "QUERY_FAILED",
        message: "A visibility query could not be evaluated.",
        retryable: true,
        subjectId: point.id,
      });
    }
    return { ...point, visible, inRange };
  });
  const regions = visibleRegions(runtime, issues, [
    tokenCenter,
    ...evaluatedQueries.filter(({ visible }) => visible),
  ]);
  const barrierEvidence = visibleBarriers(
    runtime,
    issues,
    isolation,
    tokenCenter,
    evaluatedQueries,
  );
  const barriers = barrierEvidence.barriers;
  for (const point of evaluatedQueries) {
    if (!point.visible && point.inRange && !barrierEvidence.blockerKeysByQueryId.has(point.id))
      issues.push({
        code: "QUERY_FAILED",
        message:
          "An in-range visibility failure could not be attributed to a player-visible wall; fog or lighting may be responsible.",
        retryable: true,
        subjectId: point.id,
      });
  }
  const queryPoints = evaluatedQueries.map((point) => {
    const blockerKeys = barrierEvidence.blockerKeysByQueryId.get(point.id) ?? [];
    const blockerAttribution: SceneVisibilityResult["queryPoints"][number]["blockerAttribution"] =
      point.visible
        ? "none"
        : isolation.status === "unsupported"
          ? "unavailable"
          : !point.inRange
            ? "out-of-range"
            : blockerKeys.length > 0
              ? "visible-wall"
              : "environment-ambiguous";
    return {
      id: point.id,
      visible: point.visible,
      regions: point.visible
        ? regions
            .filter(({ placeable }) => regionContains(placeable, point.x, point.y))
            .map(({ key }) => key)
        : [],
      blockerAttribution,
      blockerKeys,
    };
  });

  let image: SceneRenderResult["image"] = null;
  if (includeImage) {
    const capture = runtime.app?.renderer?.extract?.base64;
    if (!hasExclusiveSelectedVision(runtime, selected)) {
      issues.push({
        code: "ASSET_CAPTURE_UNAVAILABLE",
        message:
          "Canvas capture was refused because the selected Token is not the client's exclusive active vision source.",
        retryable: true,
      });
    } else if (typeof capture !== "function") {
      issues.push({
        code: "ASSET_CAPTURE_UNAVAILABLE",
        message: "Canvas image capture is unsupported by this client.",
        retryable: false,
      });
    } else {
      try {
        const extracted = await capture.call(
          runtime.app.renderer.extract,
          runtime.stage,
          "image/png",
        );
        if (typeof extracted !== "string" || !extracted.startsWith("data:image/png;base64,")) {
          issues.push({
            code: "ASSET_CAPTURE_FAILED",
            message: "Canvas image capture did not return a supported PNG artifact.",
            retryable: true,
          });
        } else {
          const bytes = imageBytes(extracted);
          const max = Math.min(
            input.maxImageBytes ?? SCENE_RENDER_LIMITS.maxImageBytes,
            SCENE_RENDER_LIMITS.maxImageBytes,
          );
          if (bytes > max)
            issues.push({
              code: "ASSET_LIMIT_EXCEEDED",
              message: `Rendered image exceeded the ${max}-byte response limit.`,
              retryable: false,
            });
          else image = { mediaType: "image/png", dataUrl: extracted, bytes };
        }
      } catch {
        issues.push({
          code: "ASSET_CAPTURE_FAILED",
          message: "Canvas image capture failed.",
          retryable: true,
        });
      }
    }
  }

  const afterRevision = await fingerprint(persistenceSource(scene));
  if (beforeRevision !== afterRevision)
    issues.push({
      code: "PERSISTENCE_CHANGED",
      message: "Read-only persistence verification detected a state change during capture.",
      retryable: true,
    });
  const fogRevision = runtime.fog?.exploration
    ? await fingerprint(runtime.fog.exploration.toObject?.() ?? null)
    : null;
  const coverage = coveragePolygons(selected, issues);
  const lightCount = effectiveLightCount(runtime, token);
  if (lightCount === null && !issues.some((issue) => issue.code === "LIGHTING_UNAVAILABLE"))
    issues.push({
      code: "LIGHTING_UNAVAILABLE",
      message: "Selected-Token light-source attribution is unavailable on this client.",
      retryable: true,
    });
  const bounded = boundedIssues(issues);
  const truncated = issues.some((issue) => issue.code.includes("LIMIT_REACHED"));
  const visionStatus = issues.some((issue) => issue.code === "SELECTED_VISION_EVALUATION_FAILED")
    ? "incomplete"
    : isolation.status;
  const unsupported = (code: SceneRenderIssue["code"]) =>
    issues.some((issue) => issue.code === code) ? "unsupported" : "complete";
  const incomplete = (code: SceneRenderIssue["code"]) =>
    issues.some((issue) => issue.code === code) ? "incomplete" : "complete";

  return {
    sceneId: input.sceneId,
    effectiveUserId: game.user.id,
    tokenId: input.tokenId,
    status: resultStatus(issues, includeImage),
    issues: bounded,
    context: { selectedUser: true, selectedToken: true, tokenOwned: true, sceneLoaded: true },
    visible: { tokens, notes, tiles },
    redaction: {
      occludedEntities: true,
      hiddenRegions: true,
      barrierDocumentIds: true,
      barrierCoordinates: true,
      secretDoors: true,
      exitDestinations: true,
    },
    queryPoints,
    effectiveSources: { vision: selected ? 1 : 0, light: lightCount ?? 0 },
    isolation: {
      status: visionStatus,
      method: isolation.method,
      detectionModes: isolation.detectionModes,
      unrelatedVisionSourcesIgnored: isolation.unrelatedVisionSourcesIgnored,
      visionProvidingLightsIgnored: isolation.visionProvidingLightsIgnored,
    },
    environment: {
      fog: incomplete("FOG_UNAVAILABLE"),
      lighting: incomplete("LIGHTING_UNAVAILABLE"),
      darkness: incomplete("DARKNESS_UNAVAILABLE"),
      vision: visionStatus,
      regions: unsupported("REGION_SUPPORT_UNAVAILABLE"),
      fogExplorationEnabled:
        typeof sceneSource["fogExploration"] === "boolean" ? sceneSource["fogExploration"] : null,
      tokenVisionEnabled:
        typeof tokenSource["sight"] === "object"
          ? (tokenSource["sight"] as Record<string, unknown>)["enabled"] === true
          : null,
      globalLight:
        typeof sceneSource["globalLight"] === "boolean" ? sceneSource["globalLight"] : null,
      darknessLevel: darkness,
    },
    regions: regions.map(({ key }) => ({ key })),
    visibleBarriers: barriers,
    coveragePolygons: coverage,
    fogRevision,
    persistence: { beforeRevision, afterRevision, unchanged: beforeRevision === afterRevision },
    bounds: {
      truncated,
      visiblePerKind: SCENE_RENDER_LIMITS.maxVisiblePerKind,
      regions: SCENE_RENDER_LIMITS.maxRegions,
      barriers: SCENE_RENDER_LIMITS.maxBarriers,
      coverageSources: SCENE_RENDER_LIMITS.maxCoverageSources,
      coveragePointsPerSource: SCENE_RENDER_LIMITS.maxCoveragePointsPerSource,
      issues: SCENE_RENDER_LIMITS.maxIssues,
    },
    capturedAt: new Date().toISOString(),
    image,
  };
}

export async function renderSceneSnapshot(input: SceneRenderInput): Promise<SceneRenderResult> {
  return inspect(input, input.includeImage !== false);
}

export async function inspectSceneVisibility(
  input: SceneRenderInput,
): Promise<SceneVisibilityResult> {
  const result = await inspect(input, false);
  const { capturedAt: _capturedAt, image: _image, ...visibility } = result;
  return visibility;
}

registerCommand(SCENE_RENDER_COMMANDS.SNAPSHOT, renderSceneSnapshot);
registerCommand(SCENE_RENDER_COMMANDS.VISIBILITY, inspectSceneVisibility);
