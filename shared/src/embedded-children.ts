export const EMBEDDED_CHILD_COMMANDS = {
  LIST: "embeddedChildList",
  GET: "embeddedChildGet",
  CREATE: "embeddedChildCreate",
  UPDATE: "embeddedChildUpdate",
  DELETE: "embeddedChildDelete",
} as const;

export type EmbeddedChildFamily =
  "Tile" | "RegionBehavior" | "PlaylistSound" | "TableResult" | "Card";

export interface EmbeddedChildParentInput {
  family: EmbeddedChildFamily;
  parentId: string;
  /** Required only for RegionBehavior because its Region parent is itself embedded on a Scene. */
  sceneId?: string | undefined;
}

export interface EmbeddedChildIdInput extends EmbeddedChildParentInput {
  childId: string;
}

export interface EmbeddedChildCreateInput extends EmbeddedChildParentInput {
  data: Record<string, unknown> & { _id: string };
  expectedParentRevision: string;
  idempotencyKey: string;
  dryRun?: boolean | undefined;
}

export interface EmbeddedChildUpdateInput extends EmbeddedChildIdInput {
  changes: Record<string, unknown>;
  expectedParentRevision: string;
  expectedChildRevision: string;
  idempotencyKey: string;
  dryRun?: boolean | undefined;
}

export interface EmbeddedChildDeleteInput extends EmbeddedChildIdInput {
  expectedParentRevision: string;
  expectedChildRevision: string;
  idempotencyKey: string;
  dryRun?: boolean | undefined;
}

export interface EmbeddedChildDiffEntry {
  path: string;
  kind: "added" | "changed" | "removed";
  before?: unknown;
  after?: unknown;
}

export interface EmbeddedChildValidationWarning {
  code: string;
  path: string;
  message: string;
}

export interface EmbeddedChildReadResult {
  family: EmbeddedChildFamily;
  parentId: string;
  childId: string;
  parentRevision: string;
  childRevision: string;
  data: Record<string, unknown>;
}

export interface EmbeddedChildMutationResult extends EmbeddedChildReadResult {
  replayed: boolean;
  dryRun: boolean;
  persisted: boolean;
  subtype?: string | undefined;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  diff: EmbeddedChildDiffEntry[];
  warnings: EmbeddedChildValidationWarning[];
  migrationWarnings: string[];
  deleted?: boolean;
  alreadyAbsent?: boolean;
  siblingsVerified: true;
  siblingCount: number;
}

export interface EmbeddedChildListResult {
  family: EmbeddedChildFamily;
  parentId: string;
  parentRevision: string;
  children: Array<{ childId: string; revision: string; data: Record<string, unknown> }>;
}
