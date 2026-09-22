// Phase 8 — Generic Document CRUD Core command names and payload/result
// shapes, shared between the server's document endpoint factory
// (server/src/endpoints/documents.ts) and the module's generic document
// command handlers (module/src/commands/documents.ts).
//
// Unlike Phase 6/7's fixed, per-purpose commands, these five commands are
// generic across every Foundry document type: `documentType` (Foundry's own
// type name, e.g. "JournalEntry", "Actor") travels in the payload and
// selects the `game.collections`/`CONFIG` entry module-side. Document data
// itself is intentionally untyped (`Record<string, unknown>`) — this layer
// doesn't know or care about any one document type's schema.

export const DOCUMENT_COMMANDS = {
  LIST: "documentList",
  GET: "documentGet",
  CREATE: "documentCreate",
  UPDATE: "documentUpdate",
  DELETE: "documentDelete",
} as const;

export interface DocumentTypeInput {
  documentType: string;
}

export interface DocumentIdInput extends DocumentTypeInput {
  id: string;
}

export interface DocumentCreateInput extends DocumentTypeInput {
  data: Record<string, unknown>;
}

export interface DocumentUpdateInput extends DocumentIdInput {
  changes: Record<string, unknown>;
}

/** A document's plain data, as returned by Foundry's `Document#toObject()`. */
export type DocumentData = Record<string, unknown>;

export interface DocumentDeleteResult {
  id: string;
}
