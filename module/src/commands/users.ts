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
//
// Phase 44 added target read/write, resolving off `game.user.targets` (a Set
// of Token placeables, distinct from `canvas.tokens.controlled` which is
// selection) and each Token placeable's own `setTarget()`. Replacing the
// target set (the non-additive default) is done manually — clear every
// existing target with `releaseOthers: false`, then set each new one the
// same way — rather than relying on `setTarget()`'s own `releaseOthers`
// default (`true`), which would otherwise clear on every call in a multi-
// target loop instead of just once up front.
import {
  USER_COMMANDS,
  type ActiveGmResult,
  type CanvasSelectionResult,
  type CanvasTargetsResult,
  type DocumentData,
  type DocumentDeleteResult,
  type SetCanvasTargetsInput,
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

/**
 * User source data deliberately represents every password as an empty string.
 * Foundry's normal Document diff therefore drops an explicit request to clear
 * a password unless diffing is disabled. Keep that exception entirely inside
 * this GM-only command: callers cannot select update options, and ordinary
 * User updates retain Foundry's default diff behavior.
 */
function userUpdateOptions(changes: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!Object.hasOwn(changes, "password")) return undefined;
  if (typeof changes["password"] !== "string") {
    throw new Error("A User password update must be a string.");
  }
  return { diff: false };
}

function safeUserData(user: { toObject(): Record<string, unknown> }): DocumentData {
  const data = user.toObject();
  // Do not rely on Foundry's current blank-password projection as the API's
  // secrecy boundary. Password material is never useful in a response.
  delete data["password"];
  return data;
}

registerCommand(USER_COMMANDS.GET, ({ userId }: UserIdInput): DocumentData =>
  safeUserData(requireUser(userId)),
);

registerCommand(USER_COMMANDS.CREATE, async ({ data }: UserCreateInput): Promise<DocumentData> => {
  requireGM("create a user");
  const created = await requireUserDocumentClass().create(data);
  if (!created) {
    throw new Error("Failed to create user");
  }
  return safeUserData(created);
});

registerCommand(
  USER_COMMANDS.UPDATE,
  async ({ userId, changes }: UserUpdateInput): Promise<DocumentData> => {
    requireGM("update a user");
    const user = requireUser(userId);
    await user.update(changes, userUpdateOptions(changes));
    return safeUserData(user);
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

registerCommand(USER_COMMANDS.GET_ACTIVE_GM, (): ActiveGmResult => ({
  userId: game.users.activeGM?.id ?? null,
}));

registerCommand(USER_COMMANDS.GET_CANVAS_SELECTION, (): CanvasSelectionResult => {
  if (!canvas) {
    throw new Error("No active canvas — no scene is currently being viewed");
  }
  return {
    sceneId: canvas.scene?.id ?? null,
    tokenIds: canvas.tokens.controlled.map((placeable) => placeable.document.id),
  };
});

function currentTargetsResult(): CanvasTargetsResult {
  if (!canvas) {
    throw new Error("No active canvas — no scene is currently being viewed");
  }
  return {
    sceneId: canvas.scene?.id ?? null,
    tokenIds: Array.from(game.user.targets).map((placeable) => placeable.document.id),
  };
}

registerCommand(USER_COMMANDS.GET_TARGETS, (): CanvasTargetsResult => currentTargetsResult());

registerCommand(
  USER_COMMANDS.SET_TARGETS,
  ({ tokenIds, additive }: SetCanvasTargetsInput): CanvasTargetsResult => {
    if (!canvas) {
      throw new Error("No active canvas — no scene is currently being viewed");
    }
    if (!additive) {
      for (const placeable of Array.from(game.user.targets)) {
        placeable.setTarget(false, { user: game.user, releaseOthers: false });
      }
    }
    for (const tokenId of tokenIds) {
      const placeable = canvas.tokens.placeables.find((t) => t.id === tokenId);
      if (!placeable) {
        throw new Error(`Token "${tokenId}" not found on the current canvas`);
      }
      placeable.setTarget(true, { user: game.user, releaseOthers: false });
    }
    return currentTargetsResult();
  },
);
