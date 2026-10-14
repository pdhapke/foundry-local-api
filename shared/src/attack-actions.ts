export const ATTACK_PROTOCOL = "attack-actions-v1" as const;
export const ATTACK_COMMAND = "attackConfirmed";
export const ATTACK_STATE_COMMAND = "attackState";
export const ATTACK_SEQUENCE_PROTOCOL = "attack-sequence-v1";
export const ATTACK_SEQUENCE_COMMAND = "attackSequenceConfirmed";
export type AttackSequenceAction = { mode: "execute"; steps: { stepId: string; attack: AttackRollAction }[]; maxDurationMs: number }
  | { mode: "resume"; priorSequenceRequestId: string; continuationId: string; maxDurationMs: number };
export interface AttackSequenceInput {
  schemaVersion: typeof ATTACK_SEQUENCE_PROTOCOL; worldId: string; userId: string; requestId: string;
  correlationId: string; origin: "ai-dm"; action: AttackSequenceAction;
}
export interface AttackSequenceResult {
  schemaVersion: typeof ATTACK_SEQUENCE_PROTOCOL; worldId: string; userId: string; requestId: string;
  correlationId: string; action: AttackSequenceAction;
  outcome: "confirmed" | "partial" | "decision-required" | "failure" | "uncertain"; mutated: boolean;
  state: { sequenceRequestId: string; plan: { stepId: string; attack: AttackRollAction }[]; completedStepCount: number; steps: { stepId: string; rollReceipt: AttackResult; applyReceipt: AttackResult | null }[];
    continuation: { id: string; priorSequenceRequestId: string; nextStepIndex: number } | null; limitations: string[] } | null;
  message?: string;
}
export type AttackRollAction = {
  mode: "roll"; sceneId: string; attackerTokenId: string; actorId: string;
  itemId: string; activityId: string; targetTokenId: string;
  advantage: "normal" | "advantage" | "disadvantage";
  attackMode?: string | undefined; ammunitionId?: string | undefined; abilityId?: string | undefined;
};
export type AttackAction = AttackRollAction | { mode: "apply"; priorAttackRequestId: string; decisionId?: string | undefined };
export interface AttackInput {
  schemaVersion: typeof ATTACK_PROTOCOL; worldId: string; userId: string;
  requestId: string; correlationId: string; origin: "ai-dm"; action: AttackAction;
}
export interface AttackResult {
  schemaVersion: typeof ATTACK_PROTOCOL; worldId: string; userId: string;
  requestId: string; correlationId: string; action: AttackAction;
  outcome: "confirmed" | "failure" | "uncertain" | "decision-required";
  mutated: boolean; state: Record<string, unknown> | null; message?: string;
}
export interface AttackStateInput {
  schemaVersion: typeof ATTACK_PROTOCOL; worldId: string; userId: string; sceneId?: string | undefined; actorId?: string | undefined;
}
