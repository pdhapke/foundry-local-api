// Phase 8 — Generic Document CRUD Core command handlers. Registered against
// the same command dispatcher registry Phase 2 set up
// (module/src/command-registry.ts) and imported for side effects from
// module/src/index.ts.
//
// Unlike every earlier phase's handlers, these five are registered ONCE and
// serve every Foundry document type: `documentType` travels in the payload
// and selects `game.collections.get(documentType)` (the world's live
// collection of that type) or `CONFIG[documentType].documentClass` (the
// class used to construct new ones), per PLAN.md's Phase 8 note that
// Foundry's Document API is uniform across types. The server-side route/tool
// factory (server/src/endpoints/documents.ts) is what turns this one generic
// set of commands into per-type REST routes and MCP tools.
import {
  DOCUMENT_COMMANDS,
  type DocumentCreateInput,
  type DocumentData,
  type DocumentDeleteResult,
  type DocumentIdInput,
  type DocumentTypeInput,
  type DocumentUpdateInput,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";

export function requireCollection(documentType: string): Map<string, FoundryDocument> {
  const collection = game.collections.get(documentType);
  if (!collection) {
    throw new Error(`Unknown document type "${documentType}"`);
  }
  return collection;
}

function requireDocument(documentType: string, id: string): FoundryDocument {
  const doc = requireCollection(documentType).get(id);
  if (!doc) {
    throw new Error(`${documentType} "${id}" not found`);
  }
  return doc;
}

export function requireDocumentClass(documentType: string): FoundryDocumentClass {
  const cls = CONFIG[documentType]?.documentClass;
  if (!cls) {
    throw new Error(`Unknown document type "${documentType}"`);
  }
  return cls;
}

registerCommand(DOCUMENT_COMMANDS.LIST, ({ documentType }: DocumentTypeInput): DocumentData[] =>
  Array.from(requireCollection(documentType).values()).map((doc) => doc.toObject()),
);

registerCommand(DOCUMENT_COMMANDS.GET, ({ documentType, id }: DocumentIdInput): DocumentData =>
  requireDocument(documentType, id).toObject(),
);

registerCommand(
  DOCUMENT_COMMANDS.CREATE,
  async ({ documentType, data }: DocumentCreateInput): Promise<DocumentData> => {
    const created = await requireDocumentClass(documentType).create(data);
    if (!created) {
      throw new Error(`Failed to create ${documentType}`);
    }
    return created.toObject();
  },
);

registerCommand(
  DOCUMENT_COMMANDS.UPDATE,
  async ({ documentType, id, changes }: DocumentUpdateInput): Promise<DocumentData> => {
    const doc = requireDocument(documentType, id);
    await doc.update(changes);
    return doc.toObject();
  },
);

registerCommand(
  DOCUMENT_COMMANDS.DELETE,
  async ({ documentType, id }: DocumentIdInput): Promise<DocumentDeleteResult> => {
    const doc = requireDocument(documentType, id);
    await doc.delete();
    return { id };
  },
);
