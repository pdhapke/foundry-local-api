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
//
// Phase 29 audit: both writes here (setting a document's ownership map and
// changing a user's world role) are privilege-elevating in exactly the way
// Phase 7's world-scope settings write and Phase 25's user CRUD already are
// — a non-GM caller could otherwise grant themselves OWNER on any document
// or promote their own account to GAMEMASTER — so they get the same
// module-side `requireGM()` gate as those, for the same reason (the server
// has no concept of which Foundry user is calling beyond the single static
// API key). The two reads (get ownership, get role) stay ungated, same
// convention as every other read in this codebase.
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

function requireGM(action: string): void {
  if (!game.user.isGM) {
    throw new Error(`Only a GM may ${action}.`);
  }
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
    requireGM("change a document's ownership");
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
    requireGM("change a user's role");
    const user = await requireUser(userId).update({ role });
    return { userId, role: user.role };
  },
);
