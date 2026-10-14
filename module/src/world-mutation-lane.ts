/** Reviewed bridge ingress shares one FIFO per native game instance.
 * Internal helpers never acquire this lane: core actions may call session helpers.
 * Batches retain step ordering, but do not claim isolation from external callers.
 */
const lanes = new WeakMap<object, { tail: Promise<unknown>; uncertain: boolean }>();
export class UncertainWorldMutationError extends Error {}
export function inWorldMutationLane<T>(world: object, run: () => T | Promise<T>): Promise<T> {
  let lane = lanes.get(world);
  if (!lane) { lane = { tail: Promise.resolve(), uncertain: false }; lanes.set(world, lane); }
  const current = lane;
  const operation = current.tail.then(async () => {
    if (current.uncertain) throw new Error("Prior reviewed mutation is uncertain; inspect state before further mutations");
    let result: T;
    try { result = await run(); }
    catch (error) { if (error instanceof UncertainWorldMutationError) current.uncertain = true; throw error; }
    if (result && typeof result === "object" && "outcome" in result && result.outcome === "uncertain") current.uncertain = true;
    return result;
  });
  current.tail = operation.catch(() => undefined);
  return operation;
}
