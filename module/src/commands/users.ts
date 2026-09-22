// Phase 25 — Users & Client State command handlers. Registered against the
// same command dispatcher registry Phase 2 set up
// (module/src/command-registry.ts) and imported for side effects from
// module/src/index.ts.
//
// User CRUD resolves off `game.users` directly (a User isn't part of
// `game.collections`), the same pattern Phase 23's `permissions.ts` already
// uses for user-role reads/writes. Creation uses `CONFIG.User.documentClass
// .create()` — no new ambient surface needed, since User is a regular
// Document type registered in Foundry's own `CONFIG`, same generic shape
// Phase 8 already types.
//
// Create/update/delete are GM-only per PLAN.md's Phase 25 wording, gated
// here rather than on the server — same reasoning as Phase 7's world-scope
// settings write (module/src/commands/settings.ts): the server has no
// concept of which Foundry user issued a request beyond the single static
// API key (Phase 4), whereas the connected module always knows
// `game.user.isGM`.
//
// Canvas selection is read-only and scene-independent, a sibling of Phase
// 22's camera pan (module/src/commands/placeables.ts) — same "no active
// canvas" error precedent.
import {
  USER_COMMANDS,
  type CanvasSelectionResult,
  type DocumentData,
  type DocumentDeleteResult,
  type UserCreateInput,
  type UserIdInput,
  type UserStatusResult,
  type UserUpdateInput,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";

function requireUser(userId: string): FoundryUser {
  const user = game.users.get(userId);
  if (!user) {
    throw new Error(`User "${userId}" not found`);
  }
  return user;
}

function requireUserDocumentClass(): FoundryDocumentClass {
  const cls = CONFIG["User"]?.documentClass;
  if (!cls) {
    throw new Error("User document class is not registered");
  }
  return cls;
}

function requireGM(action: string): void {
  if (!game.user.isGM) {
    throw new Error(`Only a GM may ${action}.`);
  }
}

registerCommand(USER_COMMANDS.GET, ({ userId }: UserIdInput): DocumentData =>
  requireUser(userId).toObject(),
);

registerCommand(USER_COMMANDS.CREATE, async ({ data }: UserCreateInput): Promise<DocumentData> => {
  requireGM("create a user");
  const created = await requireUserDocumentClass().create(data);
  if (!created) {
    throw new Error("Failed to create user");
  }
  return created.toObject();
});

registerCommand(
  USER_COMMANDS.UPDATE,
  async ({ userId, changes }: UserUpdateInput): Promise<DocumentData> => {
    requireGM("update a user");
    const user = requireUser(userId);
    await user.update(changes);
    return user.toObject();
  },
);

registerCommand(
  USER_COMMANDS.DELETE,
  async ({ userId }: UserIdInput): Promise<DocumentDeleteResult> => {
    requireGM("delete a user");
    const user = requireUser(userId);
    await user.delete();
    return { id: userId };
  },
);

registerCommand(USER_COMMANDS.GET_STATUS, ({ userId }: UserIdInput): UserStatusResult => {
  const user = requireUser(userId);
  return { userId, active: user.active };
});

registerCommand(USER_COMMANDS.GET_CANVAS_SELECTION, (): CanvasSelectionResult => {
  if (!canvas) {
    throw new Error("No active canvas — no scene is currently being viewed");
  }
  return {
    sceneId: canvas.scene?.id ?? null,
    tokenIds: canvas.tokens.controlled.map((placeable) => placeable.document.id),
  };
});
