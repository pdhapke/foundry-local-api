/** Foundry v14's document update path is GM displacement, not constrained travel. */
export function preflightTokenTravel(
  token: { toObject(): Record<string, unknown>; object?: { constrainMovementPath?: (path: Record<string, unknown>[], options: Record<string, unknown>) => unknown } | undefined },
  destination: { x: number; y: number; mode?: "walk" | "teleport" | undefined },
): void {
  if (destination.mode === "teleport") return;
  const current = token.toObject();
  if (current["x"] === destination.x && current["y"] === destination.y) return;
  if (typeof token.object?.constrainMovementPath !== "function") throw new Error("Native travel preflight unavailable on the active canvas");
  const result = token.object.constrainMovementPath(
    [{ ...current, action: "walk" }, { ...current, x: destination.x, y: destination.y, action: "walk", explicit: true }],
    { ignoreWalls: false, ignoreCost: false },
  );
  if (!Array.isArray(result) || result.length !== 2 || !Array.isArray(result[0]) || typeof result[1] !== "boolean")
    throw new Error("Native travel preflight result unavailable");
  if (result[1]) throw new Error("Movement blocked by native walls, surfaces or terrain; no movement dispatched");
}
export async function moveTokenVerified(
  token: { move?: (destination: Record<string, unknown>, options: Record<string, unknown>) => Promise<boolean> },
  destination: { x: number; y: number; mode?: "walk" | "teleport" | undefined },
  options: Record<string, unknown>,
): Promise<void> {
  if (typeof token.move !== "function") throw new Error("Native constrained movement API unavailable");
  const teleport = destination.mode === "teleport";
  const action = teleport ? "displace" : "walk";
  const actions = (globalThis as unknown as { CONFIG?: { Token?: { movement?: { actions?: Record<string, { walls?: unknown; teleport?: unknown }> } } } }).CONFIG?.Token?.movement?.actions;
  if (!actions?.[action] || (!teleport && (actions[action]?.walls !== "move" || actions[action]?.teleport === true)))
    throw new Error("Supported native movement action configuration unavailable");
  const completed = await token.move(
    { x: destination.x, y: destination.y, action },
    { ...options, showRuler: false, constrainOptions: { ignoreWalls: teleport, ignoreCost: teleport } },
  );
  // Stopped/paused/partially constrained movement must never be retried as if no effect occurred.
  if (completed !== true) throw new Error("Movement stopped or constrained; reconcile authoritative position before further movement");
}
