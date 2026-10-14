import type { NativeGmApplyInput, NativeGmInput } from "./native-gm.js";

export const GM_ACTIVITIES_COMMANDS = {
  READ: "gmActivitiesRead",
  APPLY: "gmActivitiesApply",
} as const;
export interface GmActivityDecision {
  targetTokenId: string;
  decisionId: string;
  edition: "2014" | "2024";
  range: "in-range" | "long-range" | "out-of-range";
  reach: "in-reach" | "not-applicable" | "out-of-reach";
  lineOfEffect: boolean;
  cover: "none" | "half" | "three-quarters" | "total";
  reason: string;
}
export interface GmActivityAction extends Record<string, unknown> {
  mode: "use";
  tokenId: string;
  actorId: string;
  itemId: string;
  activityId: string;
  targetTokenIds: string[];
  rulesDecisions: GmActivityDecision[];
  advantage: "normal" | "advantage" | "disadvantage";
  rollMode: "publicroll" | "gmroll" | "blindroll" | "selfroll";
  damage?: boolean;
  phase?: "ready" | "release";
  ready?: { choiceId: string; trigger: string; ruling: string };
  release?: { readyId: string; castReceipt: string };
  template?: { placements: { x: number; y: number; direction: number }[]; ruling: string };
  summon?: {
    profileId: string;
    actorId: string;
    creatureSize?: string;
    creatureType?: string;
    placements: { x: number; y: number; elevation: number; rotation: number }[];
    ruling: string;
  };
  spellSlot?: string;
  scaling?: number;
  concentration?: { begin: true; endEffectId?: string };
  attack?: { abilityId: string; ammunitionId?: string; attackMode?: string; mastery?: string };
}
export type GmActivityInput = NativeGmInput & { action: GmActivityAction };
export type GmActivityApplyInput = NativeGmApplyInput & { action: GmActivityAction };
