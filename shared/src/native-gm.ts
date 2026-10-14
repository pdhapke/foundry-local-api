/** Exact-version native operations. A transport credential never grants world authority. */
export const NATIVE_GM_VERSION = "gm-actions-v1" as const;
export interface NativeGmInput {
  schemaVersion: typeof NATIVE_GM_VERSION;
  worldId: string;
  userId: string;
  sceneId: string;
  action: Record<string, unknown>;
}
export interface NativeGmApplyInput extends NativeGmInput {
  expectedState: Record<string, unknown>;
  idempotencyKey: string;
  correlationId: string;
}
export interface NativeGmReceipt {
  action: Record<string, unknown>;
  schemaVersion: typeof NATIVE_GM_VERSION;
  worldId: string;
  userId: string;
  sceneId: string;
  idempotencyKey: string;
  correlationId: string;
  outcome: "confirmed" | "uncertain" | "failure";
  before: Record<string, unknown>;
  after: Record<string, unknown> | null;
  data: unknown;
  message?: string;
}
