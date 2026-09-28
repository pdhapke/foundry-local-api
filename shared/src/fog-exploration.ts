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
}

export interface FogExplorationSnapshot extends FogExplorationGetInput {
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
