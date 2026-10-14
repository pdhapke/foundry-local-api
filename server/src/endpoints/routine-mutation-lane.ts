/** One authenticated bridge mutation lane shared by routine pause and core actions. */
import { latencyEvent } from "../latency-trace.js";
const lanes = new WeakMap<object, { tail: Promise<unknown> }>();
export function enqueueRoutineMutation<T>(bridge: object, operation: () => Promise<T>): Promise<T> {
  let lane = lanes.get(bridge);
  if (!lane) {
    lane = { tail: Promise.resolve() };
    lanes.set(bridge, lane);
  }
  const queued = performance.now();
  const result = lane.tail.then(() => { latencyEvent("mutation-queue-wait", performance.now() - queued); return operation(); });
  lane.tail = result.catch(() => undefined);
  return result;
}

const uncertain = new WeakSet<object>();
export function markRoutineUncertain(bridge: object): void {
  uncertain.add(bridge);
}
export function isRoutineUncertain(bridge: object): boolean {
  return uncertain.has(bridge);
}
