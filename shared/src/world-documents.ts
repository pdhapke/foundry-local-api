export const WORLD_DOCUMENT_COMMANDS = {
  READ: "worldDocumentRead",
  APPLY: "worldDocumentApply",
} as const;
export const WORLD_DOCUMENT_TYPES = {
  actors: { type: "Actor" },
  items: { type: "Item" },
  journals: { type: "JournalEntry" },
  scenes: { type: "Scene" },
  combats: { type: "Combat" },
  playlists: { type: "Playlist" },
  tables: { type: "RollTable" },
  cards: { type: "Cards" },
  folders: { type: "Folder" },
  "journal-pages": { type: "JournalEntryPage", parent: "JournalEntry" },
  "actor-items": { type: "Item", parent: "Actor" },
  "actor-effects": { type: "ActiveEffect", parent: "Actor" },
  "item-effects": { type: "ActiveEffect", parent: "Item" },
  "scene-tokens": { type: "Token", parent: "Scene" },
  "scene-walls": { type: "Wall", parent: "Scene" },
  "scene-drawings": { type: "Drawing", parent: "Scene" },
  "scene-notes": { type: "Note", parent: "Scene" },
  "scene-lights": { type: "AmbientLight", parent: "Scene" },
  "scene-sounds": { type: "AmbientSound", parent: "Scene" },
  "scene-templates": { type: "MeasuredTemplate", parent: "Scene" },
  "scene-regions": { type: "Region", parent: "Scene" },
} as const;
export type WorldDocumentFamily = keyof typeof WORLD_DOCUMENT_TYPES;
export interface WorldDocumentRead {
  worldId: string;
  requestingUserId: string;
  family: WorldDocumentFamily;
  operation: "get" | "list";
  targetId?: string | undefined;
  parentId?: string | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
}
export interface WorldDocumentApply {
  worldId: string;
  requestingUserId: string;
  family: WorldDocumentFamily;
  operation: "create" | "update" | "delete";
  targetId?: string | undefined;
  parentId?: string | undefined;
  data?: Record<string, unknown> | undefined;
  expectedRevision: string | null;
  correlationId: string;
  idempotencyKey: string;
  reviewedDestructive?: boolean | undefined;
  preparationGuard?: { sceneId: string; preparationId: string } | undefined;
}
export interface WorldDocumentSource {
  worldId: string;
  family: WorldDocumentFamily;
  operation: string;
  targetId: string;
  parentId?: string | undefined;
  source: Record<string, unknown> | null;
  revision: string | null;
  correlationId?: string | undefined;
  idempotencyKey?: string | undefined;
  verified?: boolean | undefined;
}
export interface WorldDocumentList {
  worldId: string;
  family: WorldDocumentFamily;
  operation: "list";
  parentId?: string | undefined;
  documents: { id: string; name: string; type?: string | undefined; revision: string }[];
  nextOffset: number | null;
}
