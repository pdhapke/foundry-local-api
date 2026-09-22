// Phase 23 — Permissions & Ownership command handlers. Registered against
// the same command dispatcher registry Phase 2 set up
// (module/src/command-registry.ts) and imported for side effects from
// module/src/index.ts.
//
// Document ownership resolves its document generically off
// `game.collections.get(documentType)`, the same pattern Phase 19's
// folder-move uses (module/src/commands/folders.ts) — no new ambient
// declaration needed, since `ownership` is just another field on the
// standard `toObject()`/`update()` surface every Document already exposes.
// User role resolves off `game.users` instead, since a User isn't part of
// `game.collections`.
import {
  PERMISSION_COMMANDS,
  type DocumentOwnershipInput,
  type DocumentOwnershipMap,
  type DocumentOwnershipResult,
  type DocumentSetOwnershipInput,
  type UserRoleInput,
  type UserRoleResult,
  type UserSetRoleInput,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";

function requireDocument(documentType: string, id: string): FoundryDocument {
  const collection = game.collections.get(documentType);
  const doc = collection?.get(id);
  if (!doc) {
    throw new Error(`${documentType} "${id}" not found`);
  }
  return doc;
}

function requireUser(userId: string): FoundryUser {
  const user = game.users.get(userId);
  if (!user) {
    throw new Error(`User "${userId}" not found`);
  }
  return user;
}

function ownershipOf(doc: FoundryDocument): DocumentOwnershipMap {
  return (doc.toObject()["ownership"] as DocumentOwnershipMap | undefined) ?? {};
}

registerCommand(
  PERMISSION_COMMANDS.GET_OWNERSHIP,
  ({ documentType, documentId }: DocumentOwnershipInput): DocumentOwnershipResult => ({
    documentType,
    documentId,
    ownership: ownershipOf(requireDocument(documentType, documentId)),
  }),
);

registerCommand(
  PERMISSION_COMMANDS.SET_OWNERSHIP,
  async ({
    documentType,
    documentId,
    ownership,
  }: DocumentSetOwnershipInput): Promise<DocumentOwnershipResult> => {
    const doc = requireDocument(documentType, documentId);
    await doc.update({ ownership });
    return { documentType, documentId, ownership: ownershipOf(doc) };
  },
);

registerCommand(
  PERMISSION_COMMANDS.GET_USER_ROLE,
  ({ userId }: UserRoleInput): UserRoleResult => ({ userId, role: requireUser(userId).role }),
);

registerCommand(
  PERMISSION_COMMANDS.SET_USER_ROLE,
  async ({ userId, role }: UserSetRoleInput): Promise<UserRoleResult> => {
    const user = await requireUser(userId).update({ role });
    return { userId, role: user.role };
  },
);
