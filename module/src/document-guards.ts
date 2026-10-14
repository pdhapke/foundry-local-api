export type DocumentGuard = (context: unknown) => void;
const guards = new Map<string, DocumentGuard>();

/** Trusted modules register domain policy; the generic dispatcher invokes it
 * synchronously immediately before mutation. Unknown policy fails closed. */
export function registerDocumentGuard(name: string, guard: DocumentGuard): () => void {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(name) || typeof guard !== "function" || guards.has(name))
    throw new Error("Document guard registration is invalid or duplicated.");
  guards.set(name, guard);
  return () => { if (guards.get(name) === guard) guards.delete(name); };
}

export function validateDocumentGuard(name: string, context: unknown): void {
  const guard = guards.get(name);
  if (!guard) throw new Error("Required document policy is unavailable.");
  const result = guard(context) as unknown;
  if (result && typeof (result as { then?: unknown }).then === "function")
    throw new Error("Document policy must complete synchronously.");
}
