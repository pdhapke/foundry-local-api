import type { CompactMovementEvent, SequencedMovementEvent } from "@foundry-local-api/shared";
import type { FoundryEventBus } from "./event-bus.js";
import type { MovementEventStore } from "./movement-event-store.js";

export const MOVEMENT_EVENT_NAME = "foundry-local-api.movement";

const transitionPriority = {
  hazard: 5,
  threshold: 4,
  exit: 4,
  room: 3,
  corridor: 2,
  other: 1,
} as const;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function finitePoint(value: unknown): value is { x: number; y: number; elevation?: number } {
  return (
    isRecord(value) &&
    typeof value["x"] === "number" &&
    Number.isFinite(value["x"]) &&
    typeof value["y"] === "number" &&
    Number.isFinite(value["y"]) &&
    (value["elevation"] === undefined ||
      (typeof value["elevation"] === "number" && Number.isFinite(value["elevation"])))
  );
}

function samePoint(left: unknown, right: unknown): boolean {
  return (
    finitePoint(left) &&
    finitePoint(right) &&
    left.x === right.x &&
    left.y === right.y &&
    (left.elevation ?? 0) === (right.elevation ?? 0)
  );
}

function validTransition(value: unknown, waypoints: unknown[]): value is RecordValue {
  if (!isRecord(value)) return false;
  const segmentIndex = value["segmentIndex"];
  const t = value["t"];
  if (
    typeof value["regionId"] !== "string" ||
    value["regionId"].length === 0 ||
    (value["regionName"] !== undefined && typeof value["regionName"] !== "string") ||
    typeof value["category"] !== "string" ||
    !(value["category"] in transitionPriority) ||
    (value["stopOnEnter"] !== undefined && value["stopOnEnter"] !== true) ||
    (value["kind"] !== "enter" && value["kind"] !== "exit") ||
    !Number.isInteger(segmentIndex) ||
    typeof segmentIndex !== "number" ||
    segmentIndex < 0 ||
    segmentIndex >= waypoints.length - 1 ||
    typeof t !== "number" ||
    !Number.isFinite(t) ||
    t < 0 ||
    t > 1 ||
    !finitePoint(value["point"])
  )
    return false;
  const from = waypoints[segmentIndex];
  const to = waypoints[segmentIndex + 1];
  if (!finitePoint(from) || !finitePoint(to)) return false;
  return samePoint(value["point"], {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    elevation: (from.elevation ?? 0) + ((to.elevation ?? 0) - (from.elevation ?? 0)) * t,
  });
}

function compareTransitions(left: RecordValue, right: RecordValue): number {
  return (
    (left["segmentIndex"] as number) - (right["segmentIndex"] as number) ||
    (left["t"] as number) - (right["t"] as number) ||
    transitionPriority[right["category"] as keyof typeof transitionPriority] -
      transitionPriority[left["category"] as keyof typeof transitionPriority] ||
    (left["regionId"] as string).localeCompare(right["regionId"] as string)
  );
}

function sameTransition(left: unknown, right: unknown): boolean {
  if (!isRecord(left) || !isRecord(right)) return false;
  return (
    left["regionId"] === right["regionId"] &&
    left["regionName"] === right["regionName"] &&
    left["category"] === right["category"] &&
    left["stopOnEnter"] === right["stopOnEnter"] &&
    left["kind"] === right["kind"] &&
    left["segmentIndex"] === right["segmentIndex"] &&
    left["t"] === right["t"] &&
    samePoint(left["point"], right["point"])
  );
}

function samePointArray(left: unknown, right: unknown[]): boolean {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((point, index) => samePoint(point, right[index]))
  );
}

export function isCompactMovementEvent(value: unknown): value is CompactMovementEvent {
  if (!isRecord(value)) return false;
  const event = value as Partial<CompactMovementEvent>;
  if (!(
    typeof event.eventId === "string" &&
    event.eventId.length > 0 &&
    event.eventType === "token_movement" &&
    Array.isArray(event.movementFields) &&
    event.movementFields.length > 0 &&
    event.movementFields.every(
      (field) => field === "x" || field === "y" || field === "elevation",
    ) &&
    typeof event.sceneId === "string" &&
    event.sceneId.length > 0 &&
    typeof event.tokenId === "string" &&
    event.tokenId.length > 0 &&
    typeof event.userId === "string" &&
    event.userId.length > 0 &&
    typeof event.timestamp === "number" &&
    Number.isFinite(event.timestamp) &&
    Array.isArray(event.waypoints) &&
    event.waypoints.length <= 256 &&
    event.waypoints.length >= 2 &&
    event.waypoints.every(finitePoint) &&
    Array.isArray(event.segments) &&
    event.segments.length === event.waypoints.length - 1 &&
    Array.isArray(event.deltas) &&
    event.deltas.length === event.segments.length &&
    Array.isArray(event.transitions) &&
    (event.geometryStatus === "complete" || event.geometryStatus === "incomplete") &&
    Array.isArray(event.incompleteReasons) &&
    event.incompleteReasons.every((reason) => typeof reason === "string" && reason.length > 0) &&
    new Set(event.incompleteReasons).size === event.incompleteReasons.length &&
    !!event.footprint &&
    Number.isFinite(event.footprint.width) &&
    Number.isFinite(event.footprint.height) &&
    event.footprint.width >= 0 &&
    event.footprint.height >= 0 &&
    finitePoint(event.from) &&
    finitePoint(event.to) &&
    finitePoint(event.acceptedPoint) &&
    Array.isArray(event.remainingPath)
  ))
    return false;
  if (
    (event.geometryStatus === "complete") !== (event.incompleteReasons.length === 0) ||
    new Set(event.movementFields).size !== event.movementFields.length ||
    !samePoint(event.from, event.waypoints[0]) ||
    !samePoint(event.to, event.waypoints.at(-1))
  )
    return false;

  for (let index = 0; index < event.segments.length; index++) {
    const segment = event.segments[index];
    const delta = event.deltas[index];
    const from = event.waypoints[index];
    const to = event.waypoints[index + 1];
    if (
      !isRecord(segment) ||
      !isRecord(delta) ||
      segment["index"] !== index ||
      !samePoint(segment["from"], from) ||
      !samePoint(segment["to"], to) ||
      !finitePoint(from) ||
      !finitePoint(to)
    )
      return false;
    const expected = {
      dx: to.x - from.x,
      dy: to.y - from.y,
      delevation: (to.elevation ?? 0) - (from.elevation ?? 0),
    };
    if (
      segment["dx"] !== expected.dx ||
      segment["dy"] !== expected.dy ||
      segment["delevation"] !== expected.delevation ||
      delta["dx"] !== expected.dx ||
      delta["dy"] !== expected.dy ||
      delta["delevation"] !== expected.delevation
    )
      return false;
  }

  const transitions = event.transitions as unknown[];
  if (!transitions.every((transition) => validTransition(transition, event.waypoints!)))
    return false;
  for (let index = 1; index < transitions.length; index++) {
    const previous = transitions[index - 1] as RecordValue;
    const current = transitions[index] as RecordValue;
    if (compareTransitions(previous, current) > 0 || sameTransition(previous, current))
      return false;
  }

  const firstStop = event.firstStop as unknown;
  if (firstStop !== undefined) {
    const stopIndex = transitions.findIndex((transition) => sameTransition(transition, firstStop));
    if (
      !isRecord(firstStop) ||
      firstStop["kind"] !== "enter" ||
      stopIndex < 0 ||
      (!["hazard", "threshold", "exit"].includes(String(firstStop["category"])) &&
        firstStop["stopOnEnter"] !== true)
    )
      return false;
    if (
      transitions
        .slice(0, stopIndex)
        .some(
          (transition) =>
            isRecord(transition) &&
            transition["kind"] === "enter" &&
            (["hazard", "threshold", "exit"].includes(String(transition["category"])) ||
              transition["stopOnEnter"] === true),
        )
    )
      return false;
    const accepted = firstStop["point"];
    const segmentIndex = firstStop["segmentIndex"] as number;
    const expectedRemaining = [accepted, ...event.waypoints.slice(segmentIndex + 1)];
    if (
      !samePoint(event.acceptedPoint, accepted) ||
      !samePointArray(event.remainingPath, expectedRemaining) ||
      !isRecord(event.pendingMovement) ||
      event.pendingMovement["status"] !== "pending" ||
      !sameTransition(event.pendingMovement["stop"], firstStop) ||
      !samePoint(event.pendingMovement["acceptedPoint"], accepted) ||
      !samePointArray(event.pendingMovement["remainingPath"], expectedRemaining)
    )
      return false;
  } else {
    if (
      transitions.some(
        (transition) =>
          isRecord(transition) &&
          transition["kind"] === "enter" &&
          (["hazard", "threshold", "exit"].includes(String(transition["category"])) ||
            transition["stopOnEnter"] === true),
      ) ||
      !samePoint(event.acceptedPoint, event.to) ||
      event.remainingPath.length !== 0 ||
      event.pendingMovement !== undefined
    )
      return false;
  }
  return true;
}

/** Validates and durably appends one canonical movement event. */
export function ingestMovementEvent(
  store: MovementEventStore,
  payload: unknown,
  reporter: { clientId: string; userId: string; lane: "gm" | "player" | "tv" },
): SequencedMovementEvent | null {
  if (!isCompactMovementEvent(payload) || reporter.lane !== "gm") return null;
  return store.append({
    ...payload,
    provenance: {
      reporterClientId: reporter.clientId,
      reporterUserId: reporter.userId,
      reporterLane: reporter.lane,
    },
  });
}

/** Subscribe the durable movement store to automatically forwarded module movement events. */
export function subscribeMovementEventStore(
  eventBus: FoundryEventBus,
  store: MovementEventStore,
  reporter: { clientId: string; userId: string; lane: "gm" },
): () => void {
  return eventBus.subscribe((name, payload) => {
    if (name !== MOVEMENT_EVENT_NAME) return;
    ingestMovementEvent(store, payload, reporter);
  });
}
