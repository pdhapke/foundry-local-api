export const FOG_EXPLORATION_COMMANDS = {
  GET: "fogExplorationGet",
  UPDATE: "fogExplorationUpdate",
} as const;

export interface FogExplorationState {
  explored: string | null;
  positions: Record<string, { x: number; y: number; radius?: number | undefined }>;
}

export interface FogExplorationGetInput {
  sceneId: string;
  userId: string;
  /**
   * Foundry v14+ stores one FogExploration per Scene Level. Omit to use the Scene's only Level,
   * else the GM's viewed Level, else the Scene's initial Level. Ignored (must be omitted) on
   * Foundry versions without Scene Levels.
   */
  level?: string | undefined;
}

export interface FogExplorationSnapshot extends Omit<FogExplorationGetInput, "level"> {
  /** The resolved Scene Level the snapshot belongs to; null on Foundry versions without Levels. */
  level: string | null;
  exists: boolean;
  documentId: string | null;
  revision: string;
  state: FogExplorationState;
}

export interface FogExplorationUpdateInput extends FogExplorationGetInput {
  mode: "replace" | "merge";
  state: Partial<FogExplorationState>;
  expectedRevision: string;
  idempotencyKey: string;
  /** Exact restore of a previously absent record; valid only with replace and an empty state. */
  removeDocument?: boolean | undefined;
}

export interface FogExplorationUpdateResult {
  before: FogExplorationSnapshot;
  after: FogExplorationSnapshot;
  mode: "replace" | "merge";
  idempotencyKey: string;
  replayed: boolean;
}
