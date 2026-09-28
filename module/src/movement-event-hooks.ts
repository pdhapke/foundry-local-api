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

interface PendingMovement {
  eventId: string;
  sceneId: string;
  tokenId: string;
  userId: string;
  timestamp: number;
  waypoints: CollisionPoint[];
  movementFields: MovementField[];
  footprint: { width: number; height: number };
}

const pending = new Map<string, PendingMovement>();
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

function waypointList(options: Record<string, unknown>): CollisionPoint[] {
  const movement = options["movement"];
  const candidate =
    options["waypoints"] ??
    (movement && typeof movement === "object"
      ? (movement as Record<string, unknown>)["waypoints"]
      : undefined);
  if (!Array.isArray(candidate)) return [];
  return candidate.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const value = entry as Record<string, unknown>;
    if (!Number.isFinite(Number(value["x"])) || !Number.isFinite(Number(value["y"]))) return [];
    return [point(value, { x: 0, y: 0, elevation: 0 })];
  });
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

export function sceneMovementRegions(scene: FoundryScene): MovementRegion[] {
  let collection: Map<string, FoundryDocument>;
  try {
    collection = scene.getEmbeddedCollection("Region");
  } catch (error) {
    throw new Error("Unable to read Scene Region collection; movement geometry is unavailable.", {
      cause: error,
    });
  }
  return [...collection.values()].flatMap((region) => {
    const source = region.toObject();
    const allFlags =
      source["flags"] && typeof source["flags"] === "object"
        ? (source["flags"] as Record<string, unknown>)
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
    const polygons = parsedShapes.flatMap((shape) =>
      shape.polygon && !shape.hole ? [shape.polygon] : [],
    );
    const holes = parsedShapes.flatMap((shape) =>
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
    const elevation =
      source["elevation"] && typeof source["elevation"] === "object"
        ? (source["elevation"] as Record<string, unknown>)
        : {};
    const bottom = elevation["bottom"] ?? source["bottom"];
    const top = elevation["top"] ?? source["top"];
    const parsedBottom = finiteNumber(bottom);
    const parsedTop = finiteNumber(top);
    if (bottom !== null && bottom !== undefined && parsedBottom === undefined)
      incompleteReasons.push("elevation.bottom is not finite or null");
    if (top !== null && top !== undefined && parsedTop === undefined)
      incompleteReasons.push("elevation.top is not finite or null");
    if (parsedBottom !== undefined && parsedTop !== undefined && parsedBottom > parsedTop)
      incompleteReasons.push("elevation.bottom is greater than elevation.top");
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
        ...(metadata["stopOnEnter"] === true ? { stopOnEnter: true } : {}),
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

export function captureTokenMovement(
  token: TokenLike,
  changes: Record<string, unknown>,
  options: Record<string, unknown>,
  userId: string,
): void {
  if (!("x" in changes || "y" in changes || "elevation" in changes)) return;
  const sceneId = token.parent?.id;
  if (!sceneId || !userId) return;
  const control = options["foundryLocalApi"];
  const policy = control && typeof control === "object" ? (control as Record<string, unknown>) : {};
  if (policy["suppressMovementEvent"] === true || policy["setup"] === true) return;
  // The canonical GM observer may report player-authored moves. GM-authored setup or
  // automation is accepted only when it deliberately opts in.
  if (game.user?.id === userId && policy["authorizedGmMovement"] !== true) return;
  if (!initiatingUserOwnsToken(token, userId)) return;
  const source = token.toObject();
  const start = point(source, { x: 0, y: 0, elevation: 0 });
  const end = point(changes, start);
  const supplied = waypointList(options);
  const waypoints = [start, ...supplied, end].filter(
    (entry, index, all) =>
      index === 0 ||
      entry.x !== all[index - 1]!.x ||
      entry.y !== all[index - 1]!.y ||
      entry.elevation !== all[index - 1]!.elevation,
  );
  if (waypoints.length < 2) return;
  const movementFields = (["x", "y", "elevation"] as const).filter((field) => field in changes);
  const gridSize = numeric(token.parent?.grid?.size, 1);
  const footprint = {
    width: numeric(source["width"], 1) * gridSize,
    height: numeric(source["height"], 1) * gridSize,
  };
  const correlation =
    typeof options["correlationId"] === "string" ? options["correlationId"] : undefined;
  pending.set(key(sceneId, token.id), {
    eventId: correlation ?? `${sceneId}:${token.id}:${Date.now()}:${eventCounter++}`,
    sceneId,
    tokenId: token.id,
    userId,
    timestamp: Date.now(),
    waypoints,
    movementFields,
    footprint,
  });
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
    )
      captureTokenMovement(
        token as TokenLike,
        changes as Record<string, unknown>,
        options as Record<string, unknown>,
        userId,
      );
  });
  Hooks.on("updateToken", (...args: unknown[]) => {
    if (!game.user?.isGM) return;
    const [token, _changes, _options, userId] = args;
    if (!token || typeof token !== "object" || typeof userId !== "string") return;
    const event = completeTokenMovement(token as TokenLike, userId);
    if (event) client.sendEvent(MOVEMENT_EVENT_NAME, event);
  });
}
