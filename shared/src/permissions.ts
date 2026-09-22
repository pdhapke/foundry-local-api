// Phase 23 — Permissions & Ownership. Command names and payload/result
// shapes for two distinct kinds of permission read/write, shared between the
// server's permission endpoints (server/src/endpoints/permissions.ts) and the
// module's command handlers (module/src/commands/permissions.ts):
//
// - Document ownership: the per-document `ownership` map (a "default" level
//   plus optional per-user overrides, each a `CONST.DOCUMENT_OWNERSHIP_
//   LEVELS` value) every Foundry Document carries. Generic across document
//   type the same way Phase 19's folder-move is — `documentType` travels in
//   the payload rather than being baked into a per-type route, since (unlike
//   Phase 8's CRUD) ownership isn't naturally exposed per document type's own
//   route base.
// - World permission level per user: a User document's own `role` field
//   (`CONST.USER_ROLES` — Player/Trusted/Assistant GM/GM), narrower than full
//   User CRUD (left to a later phase per PLAN.md's Phase 25), consistent with
//   Phase 16/17/19's precedent of reading a phase's own wording narrowly
//   rather than building out adjacent functionality it didn't ask for.

export const PERMISSION_COMMANDS = {
  GET_OWNERSHIP: "documentGetOwnership",
  SET_OWNERSHIP: "documentSetOwnership",
  GET_USER_ROLE: "userGetRole",
  SET_USER_ROLE: "userSetRole",
} as const;

/** Foundry's per-document ownership map: `"default"` plus any explicit per-user overrides, each a `CONST.DOCUMENT_OWNERSHIP_LEVELS` value. */
export type DocumentOwnershipMap = Record<string, number>;

export interface DocumentOwnershipInput {
  documentType: string;
  documentId: string;
}

export interface DocumentSetOwnershipInput extends DocumentOwnershipInput {
  ownership: DocumentOwnershipMap;
}

export interface DocumentOwnershipResult {
  documentType: string;
  documentId: string;
  ownership: DocumentOwnershipMap;
}

export interface UserRoleInput {
  userId: string;
}

export interface UserRoleResult {
  userId: string;
  role: number;
}

export interface UserSetRoleInput extends UserRoleInput {
  role: number;
}
