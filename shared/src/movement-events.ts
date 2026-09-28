import type { CollisionPoint } from "./collision-topology.js";

export const MOVEMENT_COMMANDS = { BUILD_EVENT: "movementBuildEvent" } as const;
export type MovementEventType = "token_movement";
export type MovementField = "x" | "y" | "elevation";
export type MovementRegionCategory =
  "hazard" | "threshold" | "exit" | "room" | "corridor" | "other";
export interface MovementRegion {
  id: string;
  name?: string;
  polygons: CollisionPoint[][];
  holes?: CollisionPoint[][];
  incompleteReasons?: string[];
  category?: MovementRegionCategory;
  bottom?: number;
  top?: number;
  topInclusive?: boolean;
  stopOnEnter?: boolean;
}
export interface MovementEventInput {
  eventId: string;
  sceneId: string;
  tokenId: string;
  userId: string;
  waypoints: CollisionPoint[];
  regions: MovementRegion[];
  timestamp?: number;
  eventType?: MovementEventType;
  movementFields?: MovementField[];
  footprint?: { width: number; height: number };
  incompleteReasons?: string[];
}
export interface MovementSegment {
  index: number;
  from: CollisionPoint;
  to: CollisionPoint;
  dx: number;
  dy: number;
  delevation: number;
}
export interface RegionTransition {
  regionId: string;
  regionName?: string;
  category: MovementRegionCategory;
  stopOnEnter?: true;
  kind: "enter" | "exit";
  segmentIndex: number;
  t: number;
  point: CollisionPoint;
}
export interface PendingMovement {
  status: "pending";
  stop: RegionTransition;
  acceptedPoint: CollisionPoint;
  remainingPath: CollisionPoint[];
}
export interface CompactMovementEvent {
  eventId: string;
  eventType: MovementEventType;
  movementFields: MovementField[];
  sceneId: string;
  tokenId: string;
  userId: string;
  timestamp: number;
  from: CollisionPoint;
  to: CollisionPoint;
  footprint: { width: number; height: number };
  geometryStatus: "complete" | "incomplete";
  incompleteReasons: string[];
  deltas: Array<{ dx: number; dy: number; delevation: number }>;
  waypoints: CollisionPoint[];
  segments: MovementSegment[];
  transitions: RegionTransition[];
  firstStop?: RegionTransition;
  acceptedPoint: CollisionPoint;
  remainingPath: CollisionPoint[];
  pendingMovement?: PendingMovement;
  provenance?: {
    reporterClientId: string;
    reporterUserId: string;
    reporterLane: "gm" | "player" | "tv";
  };
}
export interface MovementCursorQuery {
  cursor?: string;
  sceneId?: string;
  tokenId?: string;
  userId?: string;
  eventType?: MovementEventType;
  movementField?: MovementField;
  transitionKind?: "enter" | "exit";
  limit?: number;
}
export interface SequencedMovementEvent extends CompactMovementEvent {
  sequence: number;
}
export interface MissingSequenceRange {
  fromSequence: number;
  toSequence: number;
}
export interface MovementEventPage {
  events: SequencedMovementEvent[];
  nextCursor: string;
  generation: string;
  gap?: {
    code: "CURSOR_GAP";
    reason: "restart" | "expired";
    oldestSequence: number;
    requestedGeneration: string;
    currentGeneration: string;
    missingRanges: MissingSequenceRange[];
    missingRangesComplete: boolean;
    reconciliationRequired: true;
  };
}

const EPS = 1e-7;
const priority: Record<MovementRegionCategory, number> = {
  hazard: 5,
  threshold: 4,
  exit: 4,
  room: 3,
  corridor: 2,
  other: 1,
};
const interpolate = (a: CollisionPoint, b: CollisionPoint, t: number): CollisionPoint => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  elevation: (a.elevation ?? 0) + ((b.elevation ?? 0) - (a.elevation ?? 0)) * t,
});
function pointOnEdge(p: CollisionPoint, a: CollisionPoint, b: CollisionPoint): boolean {
  const cross = (p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x);
  return (
    Math.abs(cross) <= EPS &&
    p.x >= Math.min(a.x, b.x) - EPS &&
    p.x <= Math.max(a.x, b.x) + EPS &&
    p.y >= Math.min(a.y, b.y) - EPS &&
    p.y <= Math.max(a.y, b.y) + EPS
  );
}
function pointInPolygon(p: CollisionPoint, poly: CollisionPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!,
      b = poly[j]!;
    if (pointOnEdge(p, a, b)) return true;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
      inside = !inside;
  }
  return inside;
}
function segmentsTouch(
  a: CollisionPoint,
  b: CollisionPoint,
  c: CollisionPoint,
  d: CollisionPoint,
): boolean {
  const o = (p: CollisionPoint, q: CollisionPoint, r: CollisionPoint) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return (
    o(a, b, c) * o(a, b, d) <= EPS &&
    o(c, d, a) * o(c, d, b) <= EPS &&
    Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) <=
      Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) + EPS &&
    Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) <=
      Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) + EPS
  );
}
function polygonTouchesFootprint(
  center: CollisionPoint,
  poly: CollisionPoint[],
  fp: { width: number; height: number },
): boolean {
  const c = [
    { x: center.x, y: center.y },
    { x: center.x + fp.width, y: center.y },
    { x: center.x + fp.width, y: center.y + fp.height },
    { x: center.x, y: center.y + fp.height },
  ];
  if (c.some((p) => pointInPolygon(p, poly))) return true;
  if (
    poly.some(
      (p) =>
        p.x >= center.x - EPS &&
        p.x <= center.x + fp.width + EPS &&
        p.y >= center.y - EPS &&
        p.y <= center.y + fp.height + EPS,
    )
  )
    return true;
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < poly.length; j++)
      if (segmentsTouch(c[i]!, c[(i + 1) % 4]!, poly[j]!, poly[(j + 1) % poly.length]!))
        return true;
  return false;
}
function footprintInsidePolygon(
  origin: CollisionPoint,
  poly: CollisionPoint[],
  fp: { width: number; height: number },
): boolean {
  const corners = [
    { x: origin.x, y: origin.y },
    { x: origin.x + fp.width, y: origin.y },
    { x: origin.x + fp.width, y: origin.y + fp.height },
    { x: origin.x, y: origin.y + fp.height },
  ];
  return corners.every((corner) => pointInPolygon(corner, poly));
}
function contains(
  region: MovementRegion,
  p: CollisionPoint,
  fp: { width: number; height: number },
): boolean {
  const z = p.elevation ?? 0;
  if (
    (region.bottom !== undefined && z < region.bottom - EPS) ||
    (region.top !== undefined &&
      (region.topInclusive === false ? z >= region.top - EPS : z > region.top + EPS))
  )
    return false;
  const touchesOuter = region.polygons.some(
    (poly) => poly.length >= 3 && polygonTouchesFootprint(p, poly, fp),
  );
  if (!touchesOuter) return false;
  return !(region.holes ?? []).some(
    (hole) => hole.length >= 3 && footprintInsidePolygon(p, hole, fp),
  );
}
function candidateTimes(
  a: CollisionPoint,
  b: CollisionPoint,
  region: MovementRegion,
  fp: { width: number; height: number },
): number[] {
  const values = [0, 1],
    dx = b.x - a.x,
    dy = b.y - a.y,
    dz = (b.elevation ?? 0) - (a.elevation ?? 0);
  const push = (t: number) => {
    if (t > EPS && t < 1 - EPS && Number.isFinite(t)) values.push(t);
  };
  for (const poly of [...region.polygons, ...(region.holes ?? [])])
    for (let i = 0; i < poly.length; i++) {
      const c = poly[i]!,
        d = poly[(i + 1) % poly.length]!;
      for (const ox of [0, fp.width])
        for (const oy of [0, fp.height]) {
          const den = dx * (d.y - c.y) - dy * (d.x - c.x);
          if (Math.abs(den) >= EPS) {
            const t = ((c.x - (a.x + ox)) * (d.y - c.y) - (c.y - (a.y + oy)) * (d.x - c.x)) / den,
              u = ((c.x - (a.x + ox)) * dy - (c.y - (a.y + oy)) * dx) / den;
            if (u >= -EPS && u <= 1 + EPS) push(t);
          }
        }
      for (const x of [c.x, c.x - fp.width]) if (Math.abs(dx) > EPS) push((x - a.x) / dx);
      for (const y of [c.y, c.y - fp.height]) if (Math.abs(dy) > EPS) push((y - a.y) / dy);
    }
  if (Math.abs(dz) > EPS) {
    if (region.bottom !== undefined) push((region.bottom - (a.elevation ?? 0)) / dz);
    if (region.top !== undefined) push((region.top - (a.elevation ?? 0)) / dz);
  }
  return [...new Set(values.map((v) => Math.max(0, Math.min(1, v)).toFixed(10)))]
    .map(Number)
    .sort((x, y) => x - y);
}
function transitionsFor(
  a: CollisionPoint,
  b: CollisionPoint,
  region: MovementRegion,
  fp: { width: number; height: number },
  segmentIndex: number,
): RegionTransition[] {
  const times = candidateTimes(a, b, region, fp),
    probes = [0, ...times.slice(1).map((t, i) => (times[i]! + t) / 2), 1].sort((x, y) => x - y),
    states = probes.map((t) => contains(region, interpolate(a, b, t), fp)),
    out: RegionTransition[] = [];
  for (let i = 1; i < states.length; i++)
    if (states[i] !== states[i - 1]) {
      let lo = probes[i - 1]!,
        hi = probes[i]!;
      const before = states[i - 1]!;
      for (let n = 0; n < 50; n++) {
        const mid = (lo + hi) / 2;
        if (contains(region, interpolate(a, b, mid), fp) === before) lo = mid;
        else hi = mid;
      }
      const t = (lo + hi) / 2;
      out.push({
        regionId: region.id,
        ...(region.name ? { regionName: region.name } : {}),
        category: region.category ?? "other",
        ...(region.stopOnEnter === true ? { stopOnEnter: true as const } : {}),
        kind: states[i]! ? "enter" : "exit",
        segmentIndex,
        t,
        point: interpolate(a, b, t),
      });
    }
  return out;
}
export function buildMovementEvent(input: MovementEventInput): CompactMovementEvent {
  if (input.waypoints.length < 2 || input.waypoints.length > 256)
    throw new Error("Movement requires 2-256 ordered waypoints.");
  if (
    input.waypoints.some(
      (p) => !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.elevation ?? 0),
    )
  )
    throw new Error("Movement waypoints must contain finite coordinates.");
  const footprint = input.footprint ?? { width: 0, height: 0 };
  if (footprint.width < 0 || footprint.height < 0)
    throw new Error("Movement footprint dimensions cannot be negative.");
  const segments = input.waypoints.slice(1).map((to, index) => {
    const from = input.waypoints[index]!;
    return {
      index,
      from,
      to,
      dx: to.x - from.x,
      dy: to.y - from.y,
      delevation: (to.elevation ?? 0) - (from.elevation ?? 0),
    };
  });
  const transitions = input.incompleteReasons?.length
    ? []
    : segments.flatMap((s) =>
        input.regions.flatMap((r) =>
          r.incompleteReasons?.length ? [] : transitionsFor(s.from, s.to, r, footprint, s.index),
        ),
      );
  transitions.sort(
    (l, r) =>
      l.segmentIndex - r.segmentIndex ||
      l.t - r.t ||
      priority[r.category] - priority[l.category] ||
      l.regionId.localeCompare(r.regionId),
  );
  const stable = transitions.filter(
    (t, i, all) =>
      !all
        .slice(0, i)
        .some(
          (p) =>
            p.regionId === t.regionId &&
            p.kind === t.kind &&
            p.segmentIndex === t.segmentIndex &&
            Math.abs(p.t - t.t) < EPS,
        ),
  );
  const firstStop = stable.find(
    (t) =>
      t.kind === "enter" &&
      (input.regions.find((r) => r.id === t.regionId)?.stopOnEnter === true ||
        ["hazard", "threshold", "exit"].includes(t.category)),
  );
  const acceptedPoint = firstStop?.point ?? input.waypoints.at(-1)!;
  const remainingPath = firstStop
    ? [acceptedPoint, ...input.waypoints.slice(firstStop.segmentIndex + 1)]
    : [];
  const movementFields = [
    ...new Set(
      input.movementFields ??
        segments.flatMap((s) => [
          ...(s.dx ? ["x" as const] : []),
          ...(s.dy ? ["y" as const] : []),
          ...(s.delevation ? ["elevation" as const] : []),
        ]),
    ),
  ];
  const incompleteReasons = [
    ...(input.incompleteReasons ?? []),
    ...input.regions.flatMap((region) =>
      (region.incompleteReasons ?? []).map((reason) => `Region ${region.id}: ${reason}`),
    ),
  ];
  return {
    eventId: input.eventId,
    eventType: input.eventType ?? "token_movement",
    movementFields,
    sceneId: input.sceneId,
    tokenId: input.tokenId,
    userId: input.userId,
    timestamp: input.timestamp ?? Date.now(),
    from: input.waypoints[0]!,
    to: input.waypoints.at(-1)!,
    footprint,
    geometryStatus: incompleteReasons.length ? "incomplete" : "complete",
    incompleteReasons,
    deltas: segments.map(({ dx, dy, delevation }) => ({ dx, dy, delevation })),
    waypoints: input.waypoints.map((p) => ({ ...p })),
    segments,
    transitions: stable,
    ...(firstStop ? { firstStop } : {}),
    acceptedPoint,
    remainingPath,
    ...(firstStop
      ? { pendingMovement: { status: "pending", stop: firstStop, acceptedPoint, remainingPath } }
      : {}),
  };
}
