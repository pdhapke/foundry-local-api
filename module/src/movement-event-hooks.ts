import {
  buildMovementEvent,
  type CollisionPoint,
  type CompactMovementEvent,
  type MovementField,
  type MovementRegion,
} from "@foundry-local-api/shared";
import type { BridgeClient } from "./bridge-client.js";

export const MOVEMENT_EVENT_NAME = "foundry-local-api.movement";

interface TokenLike extends FoundryDocument {
  parent?: FoundryScene;
  testUserPermission?: (user: FoundryUser, permission: string) => boolean;
}

interface RegionLike extends FoundryDocument {
  polygons?: readonly unknown[];
}

interface PendingMovement {
  eventId: string;
  sceneId: string;
  tokenId: string;
  userId: string;
  timestamp: number;
  waypoints: CollisionPoint[];
  movementFields: MovementField[];
  footprint: { width: number; height: number };
  incompleteReasons: string[];
}

const pending = new Map<string, PendingMovement>();
// Updates whose preUpdateToken hook already ran on this (GM) client. Their
// capture decision, including deliberate suppression, is authoritative, so the
// updateToken fallback must not re-derive and emit them a second time.
// Entries older than PRE_OBSERVED_TTL_MS belong to an update that never
// completed (e.g. rejected by the server) and are ignored.
const preObserved = new Map<string, number>();
const PRE_OBSERVED_TTL_MS = 30_000;
let eventCounter = 0;

function numeric(value: unknown, fallback: number): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function point(value: Record<string, unknown>, fallback: CollisionPoint): CollisionPoint {
  return {
    x: numeric(value["x"], fallback.x),
    y: numeric(value["y"], fallback.y),
    elevation: numeric(value["elevation"], fallback.elevation ?? 0),
  };
}

function keyedValue(container: unknown, tokenId: string): unknown {
  if (container instanceof Map) return container.get(tokenId);
  if (container && typeof container === "object")
    return (container as Record<string, unknown>)[tokenId];
  return undefined;
}

interface ParsedWaypoints {
  waypoints: CollisionPoint[];
  incompleteReasons: string[];
}

function waypointArray(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)["waypoints"];
}

function waypointList(
  options: Record<string, unknown>,
  tokenId: string,
  start: CollisionPoint,
): ParsedWaypoints {
  const prepared = keyedValue(options["_movement"], tokenId);
  const preparedPassed =
    prepared && typeof prepared === "object"
      ? (prepared as Record<string, unknown>)["passed"]
      : undefined;
  const keyed = keyedValue(options["movement"], tokenId);
  const legacy =
    options["waypoints"] ??
    (options["movement"] && typeof options["movement"] === "object"
      ? (options["movement"] as Record<string, unknown>)["waypoints"]
      : undefined);
  const candidate =
    prepared !== undefined
      ? waypointArray(preparedPassed)
      : keyed !== undefined
        ? waypointArray(keyed)
        : waypointArray(legacy);
  const movementMetadataPresent =
    options["_movement"] !== undefined ||
    options["movement"] !== undefined ||
    options["waypoints"] !== undefined;
  if (!Array.isArray(candidate))
    return {
      waypoints: [],
      incompleteReasons: movementMetadataPresent
        ? [`Movement waypoints for Token ${tokenId} could not be interpreted.`]
        : [],
    };

  const result: CollisionPoint[] = [];
  let fallback = start;
  for (let index = 0; index < candidate.length; index++) {
    const entry = candidate[index];
    if (!entry || typeof entry !== "object")
      return {
        waypoints: [],
        incompleteReasons: [`Movement waypoint ${index} for Token ${tokenId} is not an object.`],
      };
    const value = entry as Record<string, unknown>;
    if (!Number.isFinite(Number(value["x"])) || !Number.isFinite(Number(value["y"])))
      return {
        waypoints: [],
        incompleteReasons: [
          `Movement waypoint ${index} for Token ${tokenId} has non-finite coordinates.`,
        ],
      };
    const parsed = point(value, fallback);
    result.push(parsed);
    fallback = parsed;
  }
  return { waypoints: result, incompleteReasons: [] };
}

interface ParsedShape {
  polygon?: CollisionPoint[];
  hole: boolean;
  incompleteReason?: string;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function rotatePoint(
  point: CollisionPoint,
  pivot: CollisionPoint,
  degrees: number,
): CollisionPoint {
  if (degrees === 0) return point;
  const radians = (degrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const dx = point.x - pivot.x;
  const dy = point.y - pivot.y;
  return {
    x: pivot.x + dx * cosine - dy * sine,
    y: pivot.y + dx * sine + dy * cosine,
  };
}

function transformedPoint(
  localX: number,
  localY: number,
  origin: CollisionPoint,
  rotation: number,
): CollisionPoint {
  const rotated = rotatePoint({ x: localX, y: localY }, { x: 0, y: 0 }, rotation);
  return { x: origin.x + rotated.x, y: origin.y + rotated.y };
}

function curvedPolygon(
  center: CollisionPoint,
  radiusX: number,
  radiusY: number,
  rotation: number,
): CollisionPoint[] {
  // This is Foundry v14 GridlessGrid#getCircle's segment rule: the polygonal
  // approximation deviates from the curve by less than one quarter pixel.
  const maximumRadius = Math.max(radiusX, radiusY);
  const segments = Math.max(
    Math.ceil(Math.PI / Math.acos(Math.max(maximumRadius - 0.25, 0) / maximumRadius)),
    4,
  );
  return Array.from({ length: segments }, (_, index) => {
    const angle = (index / segments) * Math.PI * 2;
    return transformedPoint(Math.cos(angle) * radiusX, Math.sin(angle) * radiusY, center, rotation);
  });
}

function polygonArea(polygon: CollisionPoint[]): number {
  return Math.abs(
    polygon.reduce((area, point, index) => {
      const next = polygon[(index + 1) % polygon.length]!;
      return area + point.x * next.y - next.x * point.y;
    }, 0) / 2,
  );
}

function polygonFromShape(shape: Record<string, unknown>, index: number): ParsedShape {
  const type = typeof shape["type"] === "string" ? shape["type"] : undefined;
  const hole = shape["hole"] === true;
  if (shape["hole"] !== undefined && typeof shape["hole"] !== "boolean")
    return { hole: false, incompleteReason: `shapes.${index}.hole is not boolean` };
  if (shape["gridBased"] === true)
    return {
      hole,
      incompleteReason: `shapes.${index} uses grid-based geometry that cannot be represented without the Foundry grid metric`,
    };
  const rotation = shape["rotation"] === undefined ? 0 : finiteNumber(shape["rotation"]);
  if (rotation === undefined)
    return { hole, incompleteReason: `shapes.${index}.rotation is not finite` };

  if (type === "polygon") {
    const raw = shape["points"];
    if (!Array.isArray(raw) || raw.length < 6 || raw.length % 2 !== 0)
      return {
        hole,
        incompleteReason: `shapes.${index}.points must contain at least 3 coordinate pairs`,
      };
    const polygon: CollisionPoint[] = [];
    for (let pointIndex = 0; pointIndex < raw.length; pointIndex += 2) {
      const x = finiteNumber(raw[pointIndex]);
      const y = finiteNumber(raw[pointIndex + 1]);
      if (x === undefined || y === undefined)
        return {
          hole,
          incompleteReason: `shapes.${index}.points contains a non-finite coordinate`,
        };
      polygon.push({ x, y });
    }
    if (polygonArea(polygon) === 0)
      return { hole, incompleteReason: `shapes.${index} polygon has zero area` };
    // Foundry v14 serializes PolygonShapeData points in absolute scene coordinates.
    // `origin` is a control/rotation pivot, not a translation applied at read time.
    return { polygon, hole };
  }

  if (type === "rectangle") {
    const x = finiteNumber(shape["x"]);
    const y = finiteNumber(shape["y"]);
    const width = finiteNumber(shape["width"]);
    const height = finiteNumber(shape["height"]);
    const anchorX = shape["anchorX"] === undefined ? 0 : finiteNumber(shape["anchorX"]);
    const anchorY = shape["anchorY"] === undefined ? 0 : finiteNumber(shape["anchorY"]);
    if (x === undefined) return { hole, incompleteReason: `shapes.${index}.x is not finite` };
    if (y === undefined) return { hole, incompleteReason: `shapes.${index}.y is not finite` };
    if (width === undefined)
      return { hole, incompleteReason: `shapes.${index}.width is not finite` };
    if (height === undefined)
      return { hole, incompleteReason: `shapes.${index}.height is not finite` };
    if (anchorX === undefined)
      return { hole, incompleteReason: `shapes.${index}.anchorX is not finite` };
    if (anchorY === undefined)
      return { hole, incompleteReason: `shapes.${index}.anchorY is not finite` };
    if (width <= 0 || height <= 0)
      return { hole, incompleteReason: `shapes.${index} rectangle must have positive dimensions` };
    const origin = { x, y };
    const left = -anchorX * width;
    const top = -anchorY * height;
    const polygon = [
      transformedPoint(left, top, origin, rotation),
      transformedPoint(left + width, top, origin, rotation),
      transformedPoint(left + width, top + height, origin, rotation),
      transformedPoint(left, top + height, origin, rotation),
    ];
    return { polygon, hole };
  }

  if (type === "circle") {
    const x = finiteNumber(shape["x"]);
    const y = finiteNumber(shape["y"]);
    const radius = finiteNumber(shape["radius"]);
    if (x === undefined) return { hole, incompleteReason: `shapes.${index}.x is not finite` };
    if (y === undefined) return { hole, incompleteReason: `shapes.${index}.y is not finite` };
    if (radius === undefined)
      return { hole, incompleteReason: `shapes.${index}.radius is not finite` };
    if (radius <= 0) return { hole, incompleteReason: `shapes.${index}.radius must be positive` };
    return { polygon: curvedPolygon({ x, y }, radius, radius, 0), hole };
  }

  if (type === "ellipse") {
    const x = finiteNumber(shape["x"]);
    const y = finiteNumber(shape["y"]);
    const radiusX = finiteNumber(shape["radiusX"]);
    const radiusY = finiteNumber(shape["radiusY"]);
    if (x === undefined) return { hole, incompleteReason: `shapes.${index}.x is not finite` };
    if (y === undefined) return { hole, incompleteReason: `shapes.${index}.y is not finite` };
    if (radiusX === undefined)
      return { hole, incompleteReason: `shapes.${index}.radiusX is not finite` };
    if (radiusY === undefined)
      return { hole, incompleteReason: `shapes.${index}.radiusY is not finite` };
    if (radiusX <= 0 || radiusY <= 0)
      return { hole, incompleteReason: `shapes.${index} ellipse must have positive radii` };
    return { polygon: curvedPolygon({ x, y }, radiusX, radiusY, rotation), hole };
  }

  return {
    hole,
    incompleteReason: `shapes.${index} has unsupported or malformed type ${String(type ?? "unknown")}`,
  };
}

function actualRegionPolygons(region: RegionLike): CollisionPoint[][] | undefined {
  if (!Array.isArray(region.polygons)) return undefined;
  const result: CollisionPoint[][] = [];
  for (const polygon of region.polygons) {
    const raw =
      polygon && typeof polygon === "object"
        ? (polygon as Record<string, unknown>)["points"]
        : undefined;
    if (!Array.isArray(raw) && !(raw instanceof Float32Array) && !(raw instanceof Float64Array))
      return undefined;
    const coordinates = Array.from(raw);
    if (coordinates.length < 6 || coordinates.length % 2 !== 0) return undefined;
    const parsed: CollisionPoint[] = [];
    for (let index = 0; index < coordinates.length; index += 2) {
      const x = finiteNumber(coordinates[index]);
      const y = finiteNumber(coordinates[index + 1]);
      if (x === undefined || y === undefined) return undefined;
      parsed.push({ x, y });
    }
    if (polygonArea(parsed) === 0) return undefined;
    result.push(parsed);
  }
  return result.length ? result : undefined;
}

export function sceneMovementRegions(scene: FoundryScene): MovementRegion[] {
  let collection: Map<string, FoundryDocument>;
  try {
    collection = scene.getEmbeddedCollection("Region");
  } catch (error) {
    throw new Error("Unable to read Scene Region collection; movement geometry is unavailable.", {
      cause: error,
    });
  }
  return [...collection.values()].flatMap((document) => {
    const region = document as RegionLike;
    const source = region.toObject();
    const allFlags =
      source["flags"] && typeof source["flags"] === "object"
        ? (source["flags"] as Record<string, unknown>)
        : {};
    const localApiFlags =
      allFlags["foundry-local-api"] && typeof allFlags["foundry-local-api"] === "object"
        ? (allFlags["foundry-local-api"] as Record<string, unknown>)
        : {};
    const metadata =
      Object.values(allFlags).find(
        (value): value is Record<string, unknown> =>
          !!value &&
          typeof value === "object" &&
          ("category" in value || "triggerType" in value || "stopOnEnter" in value),
      ) ?? {};
    const rawCategory = metadata["category"] ?? metadata["triggerType"];
    const category = ["hazard", "threshold", "exit", "room", "corridor", "other"].includes(
      String(rawCategory),
    )
      ? (rawCategory as NonNullable<MovementRegion["category"]>)
      : undefined;
    const shapes = Array.isArray(source["shapes"]) ? source["shapes"] : [];
    const parsedShapes = shapes.map((shape, index) =>
      shape && typeof shape === "object"
        ? polygonFromShape(shape as Record<string, unknown>, index)
        : ({ hole: false, incompleteReason: `shapes.${index} is not an object` } as ParsedShape),
    );
    let polygons = parsedShapes.flatMap((shape) =>
      shape.polygon && !shape.hole ? [shape.polygon] : [],
    );
    let holes = parsedShapes.flatMap((shape) =>
      shape.polygon && shape.hole ? [shape.polygon] : [],
    );
    const incompleteReasons = parsedShapes.flatMap((shape) =>
      shape.incompleteReason ? [shape.incompleteReason] : [],
    );
    if (holes.length > 0 && polygons.length === 0)
      incompleteReasons.push("hole shape has no additive outer shape");
    if (!Array.isArray(source["shapes"])) incompleteReasons.push("shapes is not an array");
    else if (shapes.length === 0) incompleteReasons.push("shapes is empty");
    const firstHole = parsedShapes.findIndex((shape) => shape.hole);
    if (firstHole >= 0 && parsedShapes.slice(firstHole + 1).some((shape) => !shape.hole))
      incompleteReasons.push(
        "interleaved additive shapes and holes cannot be represented by the movement geometry model",
      );
    const restriction =
      source["restriction"] && typeof source["restriction"] === "object"
        ? (source["restriction"] as Record<string, unknown>)
        : undefined;
    if (restriction?.["enabled"] === true) {
      const constraints = source["_shapeConstraints"];
      if (constraints === null || constraints === undefined) {
        incompleteReasons.push("restriction is enabled but _shapeConstraints are unavailable");
      } else if (!Array.isArray(constraints)) {
        incompleteReasons.push("restriction is enabled but _shapeConstraints is not an array");
      } else {
        const actual = actualRegionPolygons(region);
        if (actual) {
          polygons = actual;
          holes = [];
          if (parsedShapes.some((shape) => shape.hole))
            incompleteReasons.push(
              "restricted Region holes cannot be distinguished in the available constrained polygons",
            );
        } else {
          incompleteReasons.push(
            "restriction is enabled but the constrained Region polygons are unavailable or malformed",
          );
        }
      }
    }
    const elevation =
      source["elevation"] && typeof source["elevation"] === "object"
        ? (source["elevation"] as Record<string, unknown>)
        : {};
    const bottom = elevation["bottom"] ?? source["bottom"];
    const top = elevation["top"] ?? source["top"];
    const parsedBottom = finiteNumber(bottom);
    const parsedTop = finiteNumber(top);
    const topInclusive = elevation["topInclusive"];
    if (bottom !== null && bottom !== undefined && parsedBottom === undefined)
      incompleteReasons.push("elevation.bottom is not finite or null");
    if (top !== null && top !== undefined && parsedTop === undefined)
      incompleteReasons.push("elevation.top is not finite or null");
    if (parsedBottom !== undefined && parsedTop !== undefined && parsedBottom > parsedTop)
      incompleteReasons.push("elevation.bottom is greater than elevation.top");
    if (topInclusive !== undefined && typeof topInclusive !== "boolean")
      incompleteReasons.push("elevation.topInclusive is not boolean");
    return [
      {
        id: region.id,
        ...(typeof source["name"] === "string" ? { name: source["name"] } : {}),
        polygons,
        ...(holes.length ? { holes } : {}),
        ...(incompleteReasons.length ? { incompleteReasons } : {}),
        ...(category ? { category } : {}),
        ...(parsedBottom !== undefined ? { bottom: parsedBottom } : {}),
        ...(parsedTop !== undefined ? { top: parsedTop } : {}),
        ...(typeof topInclusive === "boolean" ? { topInclusive } : {}),
        ...(metadata["stopOnEnter"] === true ? { stopOnEnter: true } : {}),
        ...(localApiFlags["burrowSurface"] === true ? { burrowSurface: true as const } : {}),
      },
    ];
  });
}

function initiatingUserOwnsToken(token: TokenLike, userId: string): boolean {
  const user = game.users?.get(userId);
  if (!user) return false;
  if (user.isGM) return true;
  return token.testUserPermission?.(user, "OWNER") === true;
}

function key(sceneId: string, tokenId: string): string {
  return `${sceneId}:${tokenId}`;
}

function prepareMovement(
  token: TokenLike,
  changes: Record<string, unknown>,
  options: Record<string, unknown>,
  userId: string,
  resolveStart: (source: Record<string, unknown>) => CollisionPoint | undefined,
  endBase: (source: Record<string, unknown>, start: CollisionPoint) => CollisionPoint,
  fallbackEventId?: string,
): PendingMovement | undefined {
  if (!("x" in changes || "y" in changes || "elevation" in changes)) return undefined;
  const sceneId = token.parent?.id;
  if (!sceneId || !userId) return undefined;
  const control = options["foundryLocalApi"];
  const policy = control && typeof control === "object" ? (control as Record<string, unknown>) : {};
  if (policy["suppressMovementEvent"] === true || policy["setup"] === true) return undefined;
  // The canonical GM observer may report player-authored moves. GM-authored setup or
  // automation is accepted only when it deliberately opts in.
  const initiatingUser = game.users?.get(userId);
  if (initiatingUser?.isGM && policy["authorizedGmMovement"] !== true) return undefined;
  if (!initiatingUserOwnsToken(token, userId)) return undefined;
  const source = token.toObject();
  const start = resolveStart(source);
  if (!start) return undefined;
  const end = point(changes, endBase(source, start));
  const supplied = waypointList(options, token.id, start);
  const waypoints = [...supplied.waypoints];
  const samePoint = (left: CollisionPoint, right: CollisionPoint) =>
    left.x === right.x && left.y === right.y && left.elevation === right.elevation;
  if (!waypoints.length || !samePoint(waypoints[0]!, start)) waypoints.unshift(start);
  if (!samePoint(waypoints.at(-1)!, end)) waypoints.push(end);
  if (waypoints.length < 2) return undefined;
  const movementFields = (["x", "y", "elevation"] as const).filter((field) => field in changes);
  const gridSize = numeric(token.parent?.grid?.size, 1);
  const footprint = {
    width: numeric(source["width"], 1) * gridSize,
    height: numeric(source["height"], 1) * gridSize,
  };
  const correlation =
    typeof options["correlationId"] === "string" ? options["correlationId"] : undefined;
  return {
    eventId:
      correlation ?? fallbackEventId ?? `${sceneId}:${token.id}:${Date.now()}:${eventCounter++}`,
    sceneId,
    tokenId: token.id,
    userId,
    timestamp: Date.now(),
    waypoints,
    movementFields,
    footprint,
    incompleteReasons: supplied.incompleteReasons,
  };
}

export function captureTokenMovement(
  token: TokenLike,
  changes: Record<string, unknown>,
  options: Record<string, unknown>,
  userId: string,
): void {
  const movement = prepareMovement(
    token,
    changes,
    options,
    userId,
    (source) => point(source, { x: 0, y: 0, elevation: 0 }),
    (_source, start) => start,
  );
  if (movement) pending.set(key(movement.sceneId, movement.tokenId), movement);
}

/**
 * Builds the movement event on the GM observer from updateToken data alone.
 *
 * preUpdateToken only runs on the client that requested the change, so when a
 * player drags their token the GM client never sees the pre-hook and has no
 * pending capture. Foundry v13+ broadcasts the prepared movement in
 * `options._movement[tokenId]` (origin plus passed waypoints) to every client,
 * which is enough to reconstruct the path after the fact. Without a readable
 * origin nothing is emitted rather than guessing a start point.
 */
export function observeTokenMovement(
  token: TokenLike,
  changes: Record<string, unknown>,
  options: Record<string, unknown>,
  userId: string,
): CompactMovementEvent | undefined {
  const scene = token.parent;
  if (!scene) return undefined;
  const prepared = keyedValue(options["_movement"], token.id);
  const record =
    prepared && typeof prepared === "object" ? (prepared as Record<string, unknown>) : undefined;
  const origin = record?.["origin"];
  const movementId = typeof record?.["id"] === "string" ? record["id"] : undefined;
  const movement = prepareMovement(
    token,
    changes,
    options,
    userId,
    () => {
      if (!origin || typeof origin !== "object") return undefined;
      const value = origin as Record<string, unknown>;
      if (!Number.isFinite(Number(value["x"])) || !Number.isFinite(Number(value["y"])))
        return undefined;
      return point(value, { x: 0, y: 0, elevation: 0 });
    },
    // The document is already updated here, so unchanged fields come from it.
    (source, start) => point(source, start),
    movementId ? `${scene.id}:${token.id}:${movementId}` : undefined,
  );
  if (!movement) return undefined;
  return buildMovementEvent({ ...movement, regions: sceneMovementRegions(scene) });
}

export function completeTokenMovement(
  token: TokenLike,
  userId: string,
): CompactMovementEvent | undefined {
  const scene = token.parent;
  if (!scene) return undefined;
  const movement = pending.get(key(scene.id, token.id));
  if (!movement) return undefined;
  pending.delete(key(scene.id, token.id));
  if (movement.userId !== userId) return undefined;
  if (!initiatingUserOwnsToken(token, userId)) return undefined;
  return buildMovementEvent({ ...movement, regions: sceneMovementRegions(scene) });
}

export function registerMovementEventHooks(client: BridgeClient): void {
  Hooks.on("preUpdateToken", (...args: unknown[]) => {
    // Every connected browser observes the same document hooks. Only the
    // explicit GM command lane is allowed to publish the canonical movement
    // event, otherwise one token move is duplicated once per open client.
    if (!game.user?.isGM) return;
    const [token, changes, options, userId] = args;
    if (
      token &&
      typeof token === "object" &&
      changes &&
      typeof changes === "object" &&
      options &&
      typeof options === "object" &&
      typeof userId === "string"
    ) {
      const document = token as TokenLike;
      if (document.parent?.id) preObserved.set(key(document.parent.id, document.id), Date.now());
      captureTokenMovement(
        document,
        changes as Record<string, unknown>,
        options as Record<string, unknown>,
        userId,
      );
    }
  });
  Hooks.on("updateToken", (...args: unknown[]) => {
    if (!game.user?.isGM) return;
    const [token, changes, options, userId] = args;
    if (!token || typeof token !== "object" || typeof userId !== "string") return;
    const document = token as TokenLike;
    const sceneId = document.parent?.id;
    const updateKey = sceneId ? key(sceneId, document.id) : undefined;
    const observedAt = updateKey === undefined ? undefined : preObserved.get(updateKey);
    if (updateKey !== undefined) preObserved.delete(updateKey);
    const sawPreHook = observedAt !== undefined && Date.now() - observedAt <= PRE_OBSERVED_TTL_MS;
    // A capture left behind by an update that never completed must not
    // swallow this one.
    if (!sawPreHook && updateKey !== undefined) pending.delete(updateKey);
    // Exactly one path per update: the pre-hook capture when this GM client
    // authored the change, otherwise the broadcast movement data.
    const event = sawPreHook
      ? completeTokenMovement(document, userId)
      : changes && typeof changes === "object" && options && typeof options === "object"
        ? observeTokenMovement(
            document,
            changes as Record<string, unknown>,
            options as Record<string, unknown>,
            userId,
          )
        : undefined;
    if (event) client.sendEvent(MOVEMENT_EVENT_NAME, event);
  });
}
