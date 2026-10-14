/** Narrow session operations: no arbitrary document patches or script execution. */
export const SESSION_ACTION_COMMANDS = {
  READ: "sessionActionRead",
  APPLY: "sessionActionApply",
} as const;
export type SessionAction =
  | { kind: "actor.hp"; sceneId: string; targetId: string; value: number }
  | { kind: "door.state"; sceneId: string; targetId: string; value: 0 | 1 | 2 }
  | { kind: "token.position"; sceneId: string; targetId: string; x: number; y: number; mode?: "walk" | "teleport" | undefined }
  | { kind: "token.light"; sceneId: string; targetId: string; light: { bright?: number | undefined; dim?: number | undefined; color?: string | null | undefined; alpha?: number | undefined } }
  | { kind: "combat.next"; sceneId: string; targetId: string }
  | {
      kind: "combat.initiative";
      sceneId: string;
      targetId: string;
      combatantId: string;
      value: number;
    }
  | {
      kind: "actor.condition";
      sceneId: string;
      targetId: string;
      conditionId: string;
      active: boolean;
    }
  | {
      kind: "playlist.sound";
      targetId: string;
      soundId: string;
      state: "playing" | "paused" | "stopped";
    }
  | { kind: "chat.post"; text: string; messageId?: string | undefined };
export interface SessionActionInput {
  worldId: string;
  requestingUserId: string;
  action: SessionAction;
}
export interface SessionActionApplyInput extends SessionActionInput {
  expectedState: Record<string, unknown>;
  correlationId: string;
  idempotencyKey: string;
}
export interface SessionActionState {
  worldId: string;
  action: SessionAction;
  state: Record<string, unknown>;
}
export interface SessionActionReceipt extends SessionActionState {
  correlationId: string;
  idempotencyKey: string;
  verified: true;
}
export type CoreAction =
  | Exclude<SessionAction, { kind: "playlist.sound" } | { kind: "chat.post" }>
  | { kind: "dice.roll"; formula: string }
  | {
      kind: "system.roll";
      sceneId: string;
      targetId: string;
      rollType: "ability" | "save" | "skill";
      key: string;
    };
export interface CoreActionInput {
  worldId: string;
  userId: string;
  requestId: string;
  correlationId: string;
  origin: "ai-dm";
  schemaVersion: "core-actions-v1";
  action: CoreAction;
}
export interface CoreActionResult {
  outcome: "confirmed" | "failure" | "uncertain";
  worldId: string;
  correlationId: string;
  schemaVersion: "core-actions-v1";
  action: CoreAction;
  state: Record<string, unknown> | null;
  mutated: boolean;
  message?: string;
}
export const CORE_ACTION_COMMAND = "coreActionConfirmed";
