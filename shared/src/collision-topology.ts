export const COLLISION_COMMANDS = {
  VALIDATE_PATH: "collisionValidateTokenPath",
  VALIDATE_TOPOLOGY: "collisionValidateWallTopology",
} as const;

const EPSILON = 1e-9;
export interface CollisionPoint {
  x: number;
  y: number;
  elevation?: number;
}
export type CollisionDoorState = "open" | "closed" | "locked" | "barred" | "sealed";
export interface CollisionWall {
  id: string;
  c: [number, number, number, number];
  door?: number | "none" | "door" | "secret";
  ds?: number | CollisionDoorState;
  bottom?: number;
  top?: number;
  move?: number;
  dir?: number;
  hidden?: boolean;
  revision?: string;
}
export interface CollisionGrid {
  type: number;
  size: number;
  diagonalRule?: "euclidean" | "manhattan" | "5105";
}
export interface ValidateTokenPathInput {
  sceneId: string;
  tokenId: string;
  waypoints: CollisionPoint[];
  movementMode: "walk" | "fly" | "burrow";
  simulatedDoors?: Record<string, CollisionDoorState>;
}
export interface CollisionIntersection {
  wallId: string;
  x: number;
  y: number;
  t: number;
  elevation: number;
  doorType: "none" | "door" | "secret";
  doorState: CollisionDoorState | "none";
  doorOpen: boolean;
  blocking: boolean;
}
export interface PathSegmentResult {
  index: number;
  from: CollisionPoint;
  to: CollisionPoint;
  distance: number;
  blocked: boolean;
  wallIds: string[];
  firstCollisionWallIds: string[];
  firstCollision: CollisionIntersection | null;
  intersections: CollisionIntersection[];
}
export interface CollisionReadSnapshot {
  tokenRevision: string;
  sceneRevision: string;
  wallRevisions: Record<string, string>;
  topologySignature: string;
  token: {
    x: number;
    y: number;
    elevation: number;
    width: number;
    height: number;
    revision: string;
  };
  walls: Record<
    string,
    {
      revision: string;
      coordinates: [number, number, number, number];
      doorType: "none" | "door" | "secret";
      doorState: CollisionDoorState | "none";
      move: number;
      direction: number;
      bottom: number | null;
      top: number | null;
    }
  >;
  malformedWalls: Record<string, { revision: string; shapeSignature: string }>;
  fog?: {
    userId: string;
    exists: boolean;
    documentId: string | null;
    revision: string | null;
    stateSignature: string;
  };
}
export interface ValidateTokenPathResult {
  sceneId: string;
  tokenId: string;
  movementMode: string;
  reachable: boolean;
  status: "complete" | "incomplete" | "unsupported";
  incompleteReasons: string[];
  segments: PathSegmentResult[];
  firstCollision: (CollisionIntersection & { segmentIndex: number }) | null;
  malformedWallIds: string[];
  invalidSimulatedDoorIds: string[];
  modeSupport: { status: "supported" | "unsupported"; warnings: string[] };
  gridFit: { valid: boolean; errors: string[]; warnings: string[] };
  gridWarnings: string[];
  before: { x: number; y: number; elevation: number; revision: string };
  after: { x: number; y: number; elevation: number; revision: string };
  evidence: {
    before: CollisionReadSnapshot;
    after: CollisionReadSnapshot;
    unchanged: boolean;
    independentReadRequired: true;
  };
  persisted: false;
}
export interface ValidateWallTopologyInput {
  sceneId: string;
}
export interface WallTopologyResult {
  sceneId: string;
  status: "complete" | "incomplete";
  incompleteReasons: string[];
  wallCount: number;
  malformedWallIds: string[];
  zeroLengthWallIds: string[];
  duplicateGroups: string[][];
  danglingEndpointWallIds: string[];
  crossingPairs: Array<[string, string]>;
  persisted: false;
}

function hasValidWallCoordinates(wall: CollisionWall): boolean {
  const coordinates = (wall as { c?: unknown }).c;
  return (
    Array.isArray(coordinates) &&
    coordinates.length === 4 &&
    coordinates.every((value) => typeof value === "number" && Number.isFinite(value))
  );
}

function hasValidWallElevation(wall: CollisionWall): boolean {
  const bottomValid = wall.bottom === undefined || Number.isFinite(wall.bottom);
  const topValid = wall.top === undefined || Number.isFinite(wall.top);
  return (
    bottomValid &&
    topValid &&
    (wall.bottom === undefined || wall.top === undefined || wall.bottom <= wall.top)
  );
}

function isMalformedWall(wall: CollisionWall): boolean {
  return !hasValidWallCoordinates(wall) || !hasValidWallElevation(wall);
}

export function segmentIntersection(
  a: CollisionPoint,
  b: CollisionPoint,
  wall: CollisionWall,
): { x: number; y: number; t: number } | null {
  if (!hasValidWallCoordinates(wall)) return null;
  const [x3, y3, x4, y4] = wall.c;
  const dx1 = b.x - a.x,
    dy1 = b.y - a.y,
    dx2 = x4 - x3,
    dy2 = y4 - y3;
  const denominator = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denominator) < EPSILON) return null;
  const t = ((x3 - a.x) * dy2 - (y3 - a.y) * dx2) / denominator;
  const u = ((x3 - a.x) * dy1 - (y3 - a.y) * dx1) / denominator;
  if (t < -EPSILON || t > 1 + EPSILON || u < -EPSILON || u > 1 + EPSILON) return null;
  return { x: a.x + t * dx1, y: a.y + t * dy1, t: Math.max(0, Math.min(1, t)) };
}

interface Vector {
  x: number;
  y: number;
}
function cross(a: Vector, b: Vector, c: Vector): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
function convexHull(points: Vector[]): Vector[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const unique = sorted.filter(
    (p, i) => i === 0 || p.x !== sorted[i - 1]!.x || p.y !== sorted[i - 1]!.y,
  );
  if (unique.length <= 1) return unique;
  const half = (values: Vector[]) => {
    const result: Vector[] = [];
    for (const point of values) {
      while (result.length >= 2 && cross(result.at(-2)!, result.at(-1)!, point) <= EPSILON)
        result.pop();
      result.push(point);
    }
    return result;
  };
  return [...half(unique).slice(0, -1), ...half([...unique].reverse()).slice(0, -1)];
}

/** Continuous swept axis-aligned Token rectangle versus wall segment. */
export function sweptFootprintIntersection(
  from: CollisionPoint,
  to: CollisionPoint,
  width: number,
  height: number,
  wall: CollisionWall,
): { x: number; y: number; t: number } | null {
  const interval = sweptFootprintInterval(from, to, width, height, wall);
  if (!interval) return null;
  const [x1, y1, x2, y2] = wall.c;
  const t = interval.enter;
  const tokenX = from.x + (to.x - from.x) * t,
    tokenY = from.y + (to.y - from.y) * t;
  const contact = segmentRectangleContact(x1, y1, x2, y2, tokenX, tokenY, width, height);
  return { ...contact, t };
}

function sweptFootprintInterval(
  from: CollisionPoint,
  to: CollisionPoint,
  width: number,
  height: number,
  wall: CollisionWall,
): { enter: number; leave: number } | null {
  if (
    !hasValidWallCoordinates(wall) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  )
    return null;
  const [x1, y1, x2, y2] = wall.c;
  const offsets = [
    { x: -width, y: -height },
    { x: -width, y: 0 },
    { x: 0, y: -height },
    { x: 0, y: 0 },
  ];
  const obstacle = convexHull(
    [
      { x: x1, y: y1 },
      { x: x2, y: y2 },
    ].flatMap((p) => offsets.map((o) => ({ x: p.x + o.x, y: p.y + o.y }))),
  );
  if (obstacle.length < 3) return null;
  const velocity = { x: to.x - from.x, y: to.y - from.y };
  let enter = 0,
    leave = 1;
  for (let i = 0; i < obstacle.length; i++) {
    const start = obstacle[i]!,
      end = obstacle[(i + 1) % obstacle.length]!;
    const initial = cross(start, end, from);
    const delta = (end.x - start.x) * velocity.y - (end.y - start.y) * velocity.x;
    if (Math.abs(delta) < EPSILON) {
      if (initial < -EPSILON) return null;
      continue;
    }
    const time = -initial / delta;
    if (delta > 0) enter = Math.max(enter, time);
    else leave = Math.min(leave, time);
    if (enter - leave > EPSILON) return null;
  }
  if (leave < -EPSILON || enter > 1 + EPSILON) return null;
  const boundedEnter = Math.max(0, Math.min(1, enter));
  const boundedLeave = Math.max(0, Math.min(1, leave));
  if (boundedEnter <= EPSILON && boundedLeave <= EPSILON) return null;
  return { enter: boundedEnter, leave: boundedLeave };
}
function segmentRectangleContact(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  left: number,
  top: number,
  width: number,
  height: number,
): Vector {
  const dx = x2 - x1,
    dy = y2 - y1;
  let minimum = 0,
    maximum = 1;
  for (const [p, q] of [
    [-dx, x1 - left],
    [dx, left + width - x1],
    [-dy, y1 - top],
    [dy, top + height - y1],
  ] as Array<[number, number]>) {
    if (Math.abs(p) < EPSILON) continue;
    const ratio = q / p;
    if (p < 0) minimum = Math.max(minimum, ratio);
    else maximum = Math.min(maximum, ratio);
  }
  const u = Math.max(0, Math.min(1, minimum <= maximum ? minimum : 0));
  return { x: x1 + u * dx, y: y1 + u * dy };
}

function elevationAt(from: CollisionPoint, to: CollisionPoint, t: number): number {
  const start = from.elevation ?? 0;
  return start + ((to.elevation ?? start) - start) * t;
}
function elevationBlocks(
  from: CollisionPoint,
  to: CollisionPoint,
  t: number,
  wall: CollisionWall,
): boolean {
  const e = elevationAt(from, to, t);
  return e >= (wall.bottom ?? -Infinity) - EPSILON && e <= (wall.top ?? Infinity) + EPSILON;
}

function elevationInterval(
  from: CollisionPoint,
  to: CollisionPoint,
  wall: CollisionWall,
): { enter: number; leave: number } | null {
  if (!hasValidWallElevation(wall)) return null;
  const start = from.elevation ?? 0;
  const end = to.elevation ?? start;
  const delta = end - start;
  const bottom = wall.bottom ?? -Infinity;
  const top = wall.top ?? Infinity;
  if (Math.abs(delta) <= EPSILON)
    return elevationBlocks(from, to, 0, wall) ? { enter: 0, leave: 1 } : null;
  const first = (bottom - start) / delta;
  const second = (top - start) / delta;
  const enter = Math.max(0, Math.min(first, second));
  const leave = Math.min(1, Math.max(first, second));
  return enter <= leave + EPSILON ? { enter, leave } : null;
}

function sweptFootprintIntersectionAtElevation(
  from: CollisionPoint,
  to: CollisionPoint,
  width: number,
  height: number,
  wall: CollisionWall,
): { x: number; y: number; t: number } | null {
  const footprint = sweptFootprintInterval(from, to, width, height, wall);
  const elevation = elevationInterval(from, to, wall);
  if (!footprint || !elevation) return null;
  const enter = Math.max(footprint.enter, elevation.enter);
  const leave = Math.min(footprint.leave, elevation.leave);
  if (enter > leave + EPSILON) return null;
  const t = Math.max(0, Math.min(1, enter));
  if (t <= EPSILON && leave <= EPSILON) return null;
  const [x1, y1, x2, y2] = wall.c;
  const tokenX = from.x + (to.x - from.x) * t;
  const tokenY = from.y + (to.y - from.y) * t;
  return { ...segmentRectangleContact(x1, y1, x2, y2, tokenX, tokenY, width, height), t };
}
function directionBlocks(from: CollisionPoint, to: CollisionPoint, wall: CollisionWall): boolean {
  if (!wall.dir) return true;
  const [x1, y1, x2, y2] = wall.c;
  const side = (p: CollisionPoint) => (x2 - x1) * (p.y - y1) - (y2 - y1) * (p.x - x1);
  const before = side(from),
    after = side(to);
  return wall.dir === 1
    ? after > before + EPSILON
    : wall.dir === 2
      ? after < before - EPSILON
      : true;
}
function doorType(wall: CollisionWall): "none" | "door" | "secret" {
  if (wall.door === 2 || wall.door === "secret") return "secret";
  if (wall.door === 1 || wall.door === "door") return "door";
  return "none";
}
function doorState(wall: CollisionWall): CollisionDoorState | "none" {
  if (doorType(wall) === "none") return "none";
  if (wall.ds === 1 || wall.ds === "open") return "open";
  if (wall.ds === 2 || wall.ds === "locked") return "locked";
  if (wall.ds === "barred") return "barred";
  if (wall.ds === "sealed") return "sealed";
  return "closed";
}
function isCollisionDoorState(value: unknown): value is CollisionDoorState {
  return (
    value === "open" ||
    value === "closed" ||
    value === "locked" ||
    value === "barred" ||
    value === "sealed"
  );
}
export function pathDistance(a: CollisionPoint, b: CollisionPoint, grid: CollisionGrid): number {
  const dx = Math.abs(b.x - a.x) / Math.max(1, grid.size),
    dy = Math.abs(b.y - a.y) / Math.max(1, grid.size);
  if (grid.type === 0 || grid.diagonalRule === "euclidean") return Math.hypot(dx, dy) * grid.size;
  if (grid.diagonalRule === "manhattan") return (dx + dy) * grid.size;
  const diagonal = Math.min(dx, dy),
    straight = Math.max(dx, dy) - diagonal;
  return grid.diagonalRule === "5105"
    ? (straight + Math.floor(diagonal / 2) * 3 + (diagonal % 2)) * grid.size
    : (straight + diagonal) * grid.size;
}
function topologySignature(sceneRevision: string, walls: CollisionWall[]): string {
  return JSON.stringify({
    sceneRevision,
    walls: [...walls]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((w) =>
        isMalformedWall(w)
          ? [w.id, w.revision ?? "unavailable", "malformed", wallShapeSignature(w)]
          : [
              w.id,
              w.revision ?? "unavailable",
              w.c,
              w.door ?? 0,
              w.ds ?? 0,
              w.move ?? 1,
              w.dir ?? 0,
              w.bottom ?? null,
              w.top ?? null,
            ],
      ),
  });
}

function boundedShapeSignature(value: unknown): string {
  let hash = 0x811c9dc5;
  const seen = new WeakSet<object>();
  const add = (text: string) => {
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
  };
  const visit = (current: unknown, depth: number): void => {
    if (current === null) {
      add("null;");
      return;
    }
    switch (typeof current) {
      case "undefined":
        add("undefined;");
        return;
      case "number":
        add(
          Number.isNaN(current)
            ? "number:NaN;"
            : current === Infinity
              ? "number:+Infinity;"
              : current === -Infinity
                ? "number:-Infinity;"
                : Object.is(current, -0)
                  ? "number:-0;"
                  : `number:${current};`,
        );
        return;
      case "string":
        add(`string:${current.length}:`);
        add(current);
        add(";");
        return;
      case "boolean":
        add(`boolean:${current};`);
        return;
      case "bigint":
        add(`bigint:${current};`);
        return;
      case "symbol":
        add(`symbol:${String(current.description)};`);
        return;
      case "function":
        add(`function:${current.name};`);
        return;
    }
    if (seen.has(current)) {
      add("circular;");
      return;
    }
    seen.add(current);
    if (depth >= 32) {
      add(`depth-limit:${Object.prototype.toString.call(current)};`);
      return;
    }
    if (Array.isArray(current)) {
      add(`array:${current.length}:[`);
      for (let index = 0; index < current.length; index++) {
        add(`${index}:`);
        if (index in current) visit(current[index], depth + 1);
        else add("hole;");
      }
      add("];");
      return;
    }
    const record = current as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    add(`object:${Object.prototype.toString.call(current)}:${keys.length}:{`);
    for (const key of keys) {
      add(`${key.length}:${key}=`);
      visit(record[key], depth + 1);
    }
    add("};");
  };
  visit(value, 0);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function wallShapeSignature(wall: CollisionWall): string {
  return boundedShapeSignature({
    coordinates: (wall as { c?: unknown }).c,
    bottom: (wall as { bottom?: unknown }).bottom,
    top: (wall as { top?: unknown }).top,
  });
}

export function validatePathGeometry(
  input: ValidateTokenPathInput,
  token: {
    x: number;
    y: number;
    elevation?: number;
    revision: string;
    sceneRevision?: string;
    width?: number;
    height?: number;
  },
  walls: CollisionWall[],
  grid: CollisionGrid,
): ValidateTokenPathResult {
  const malformedWallIds = walls.filter(isMalformedWall).map((w) => w.id);
  const zeroLengthWallIds = walls
    .filter((w) => !malformedWallIds.includes(w.id) && w.c[0] === w.c[2] && w.c[1] === w.c[3])
    .map((w) => w.id);
  const validWalls = walls.filter((w) => !malformedWallIds.includes(w.id));
  const points: CollisionPoint[] = [
    { x: token.x, y: token.y, elevation: token.elevation ?? 0 },
    ...input.waypoints,
  ];
  const width = token.width ?? grid.size,
    height = token.height ?? grid.size;
  const gridErrors: string[] = [],
    gridWarnings: string[] = [];
  if (!Number.isFinite(grid.size) || grid.size <= 0)
    gridErrors.push("Scene grid size must be a positive finite number.");
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    gridErrors.push("Token footprint must have positive finite width and height.");
  if (grid.type !== 0 && gridErrors.length === 0) {
    if (
      Math.abs(token.x / grid.size - Math.round(token.x / grid.size)) > EPSILON ||
      Math.abs(token.y / grid.size - Math.round(token.y / grid.size)) > EPSILON
    )
      gridErrors.push("Token starting position is not aligned to the Scene grid.");
    for (const [index, p] of points.slice(1).entries())
      if (
        Math.abs(p.x / grid.size - Math.round(p.x / grid.size)) > EPSILON ||
        Math.abs(p.y / grid.size - Math.round(p.y / grid.size)) > EPSILON
      )
        gridErrors.push(`waypoints.${index} is not aligned to the Scene grid.`);
    if (
      Math.abs(width / grid.size - Math.round(width / grid.size)) > EPSILON ||
      Math.abs(height / grid.size - Math.round(height / grid.size)) > EPSILON
    )
      gridErrors.push("Token footprint is not an integral number of grid spaces.");
  }
  const modeSupport =
    input.movementMode === "burrow"
      ? {
          status: "unsupported" as const,
          warnings: ["Burrowing collision cannot be derived from Foundry wall geometry."],
        }
      : { status: "supported" as const, warnings: [] as string[] };
  const simulatedDoors = new Map<string, CollisionDoorState>();
  const invalidSimulatedDoorIds: string[] = [];
  for (const [id, requestedState] of Object.entries(input.simulatedDoors ?? {})) {
    const wall = validWalls.find((candidate) => candidate.id === id);
    if (!wall || doorType(wall) === "none" || !isCollisionDoorState(requestedState)) {
      invalidSimulatedDoorIds.push(id);
      continue;
    }
    simulatedDoors.set(id, requestedState);
  }
  invalidSimulatedDoorIds.sort();
  const segments = points.slice(1).map((to, index): PathSegmentResult => {
    const from = points[index]!;
    const intersections = validWalls
      .flatMap((wall): CollisionIntersection[] => {
        const hit = sweptFootprintIntersectionAtElevation(from, to, width, height, wall);
        if (!hit || !directionBlocks(from, to, wall) || wall.move === 0) return [];
        const type = doorType(wall),
          state = simulatedDoors.get(wall.id) ?? doorState(wall),
          open = type !== "none" && state === "open";
        return [
          {
            wallId: wall.id,
            ...hit,
            elevation: elevationAt(from, to, hit.t),
            doorType: type,
            doorState: state,
            doorOpen: open,
            blocking: !open,
          },
        ];
      })
      .sort((a, b) => a.t - b.t || a.wallId.localeCompare(b.wallId));
    const first = intersections.find((hit) => hit.blocking) ?? null;
    return {
      index,
      from,
      to,
      distance: pathDistance(from, to, grid),
      blocked: modeSupport.status === "unsupported" || Boolean(first),
      wallIds: intersections.filter((h) => h.blocking).map((h) => h.wallId),
      firstCollisionWallIds: first
        ? intersections
            .filter((h) => h.blocking && Math.abs(h.t - first.t) <= EPSILON)
            .map((h) => h.wallId)
        : [],
      firstCollision: first,
      intersections,
    };
  });
  const incompleteReasons = [
    ...(malformedWallIds.length
      ? [`Malformed wall geometry: ${malformedWallIds.join(", ")}.`]
      : []),
    ...(zeroLengthWallIds.length
      ? [`Incomplete zero-length wall geometry: ${zeroLengthWallIds.join(", ")}.`]
      : []),
    ...(invalidSimulatedDoorIds.length
      ? [
          `Door simulation targets are missing or are not door walls: ${invalidSimulatedDoorIds.join(", ")}.`,
        ]
      : []),
    ...gridErrors,
  ];
  const status =
    modeSupport.status === "unsupported"
      ? "unsupported"
      : incompleteReasons.length
        ? "incomplete"
        : "complete";
  const firstCollision =
    segments
      .flatMap((s) => (s.firstCollision ? [{ ...s.firstCollision, segmentIndex: s.index }] : []))
      .sort(
        (a, b) => a.segmentIndex - b.segmentIndex || a.t - b.t || a.wallId.localeCompare(b.wallId),
      )[0] ?? null;
  const sceneRevision = token.sceneRevision ?? "unavailable";
  const snapshot: CollisionReadSnapshot = {
    tokenRevision: token.revision,
    sceneRevision,
    wallRevisions: Object.fromEntries(walls.map((w) => [w.id, w.revision ?? "unavailable"])),
    topologySignature: topologySignature(sceneRevision, walls),
    token: {
      x: token.x,
      y: token.y,
      elevation: token.elevation ?? 0,
      width,
      height,
      revision: token.revision,
    },
    walls: Object.fromEntries(
      validWalls.map((wall) => [
        wall.id,
        {
          revision: wall.revision ?? "unavailable",
          coordinates: [...wall.c] as [number, number, number, number],
          doorType: doorType(wall),
          doorState: doorState(wall),
          move: wall.move ?? 1,
          direction: wall.dir ?? 0,
          bottom: wall.bottom ?? null,
          top: wall.top ?? null,
        },
      ]),
    ),
    malformedWalls: Object.fromEntries(
      walls
        .filter((wall) => malformedWallIds.includes(wall.id))
        .map((wall) => [
          wall.id,
          {
            revision: wall.revision ?? "unavailable",
            shapeSignature: wallShapeSignature(wall),
          },
        ]),
    ),
  };
  return {
    sceneId: input.sceneId,
    tokenId: input.tokenId,
    movementMode: input.movementMode,
    reachable: status === "complete" && segments.every((s) => !s.blocked),
    status,
    incompleteReasons,
    segments,
    firstCollision,
    malformedWallIds,
    invalidSimulatedDoorIds,
    modeSupport,
    gridFit: {
      valid: gridErrors.length === 0 && gridWarnings.length === 0,
      errors: gridErrors,
      warnings: gridWarnings,
    },
    gridWarnings: [...gridErrors, ...gridWarnings],
    before: { x: token.x, y: token.y, elevation: token.elevation ?? 0, revision: token.revision },
    after: { x: token.x, y: token.y, elevation: token.elevation ?? 0, revision: token.revision },
    evidence: {
      before: snapshot,
      after: structuredClone(snapshot),
      unchanged: true,
      independentReadRequired: true,
    },
    persisted: false,
  };
}

export function inspectWallTopology(sceneId: string, walls: CollisionWall[]): WallTopologyResult {
  const malformed = walls.filter(isMalformedWall);
  const valid = walls.filter((w) => !malformed.includes(w));
  const key = (w: CollisionWall) => [`${w.c[0]},${w.c[1]}`, `${w.c[2]},${w.c[3]}`].sort().join("|");
  const groups = new Map<string, string[]>(),
    endpointCounts = new Map<string, number>();
  for (const wall of valid) {
    groups.set(key(wall), [...(groups.get(key(wall)) ?? []), wall.id]);
    for (const p of [`${wall.c[0]},${wall.c[1]}`, `${wall.c[2]},${wall.c[3]}`])
      endpointCounts.set(p, (endpointCounts.get(p) ?? 0) + 1);
  }
  const crossingPairs: Array<[string, string]> = [];
  for (let i = 0; i < valid.length; i++)
    for (let j = i + 1; j < valid.length; j++) {
      const left = valid[i]!,
        right = valid[j]!;
      const hit = segmentIntersection(
        { x: left.c[0], y: left.c[1] },
        { x: left.c[2], y: left.c[3] },
        right,
      );
      if (hit && hit.t > EPSILON && hit.t < 1 - EPSILON) crossingPairs.push([left.id, right.id]);
    }
  const zeroLengthWallIds = valid
    .filter((w) => w.c[0] === w.c[2] && w.c[1] === w.c[3])
    .map((w) => w.id);
  const incompleteReasons = [
    ...(malformed.length
      ? [`Malformed wall geometry: ${malformed.map((w) => w.id).join(", ")}.`]
      : []),
    ...(zeroLengthWallIds.length ? [`Zero-length walls: ${zeroLengthWallIds.join(", ")}.`] : []),
  ];
  return {
    sceneId,
    status: incompleteReasons.length ? "incomplete" : "complete",
    incompleteReasons,
    wallCount: walls.length,
    malformedWallIds: malformed.map((w) => w.id),
    zeroLengthWallIds,
    duplicateGroups: [...groups.values()].filter((ids) => ids.length > 1),
    danglingEndpointWallIds: valid
      .filter(
        (w) =>
          endpointCounts.get(`${w.c[0]},${w.c[1]}`) === 1 ||
          endpointCounts.get(`${w.c[2]},${w.c[3]}`) === 1,
      )
      .map((w) => w.id),
    crossingPairs,
    persisted: false,
  };
}
