export const DND5E_SIMULATION_COMMANDS = { SIMULATE: "dnd5eSimulateAction" } as const;
export type Dnd5eSimulationAction =
  | { kind: "attack"; itemId?: string; modifier?: number; targetAC?: number; damage?: string }
  | { kind: "save"; ability?: string; skill?: string; modifier?: number; dc: number }
  | { kind: "damage"; itemId?: string; amount?: number; formula?: string; damageType?: string }
  | { kind: "effect"; effectId: string; active: boolean; targetActorId?: string }
  | { kind: "resource"; path: string; delta: number; min?: number; max?: number }
  | { kind: "rest"; restType: "short" | "long" }
  | { kind: "combat"; transition: "start" | "next-turn" | "next-round" | "end" };
export interface Dnd5eSimulationInput {
  effectiveUserId: string;
  actorId: string;
  targetActorId?: string;
  tokenId?: string;
  sceneId?: string;
  combatId?: string;
  action?: Dnd5eSimulationAction;
  actions?: Dnd5eSimulationAction[];
  continueOnError?: boolean;
  seed?: number;
  suppliedRolls?: number[];
  noPersist: true;
  expectedRevisions: Array<{
    kind: "actor" | "target" | "item" | "token" | "combat";
    id: string;
    revision: string;
  }>;
  expectedSystemVersion: "6.0.3";
}
export interface ProjectedDiff {
  path: string;
  before: unknown;
  after: unknown;
}
export interface Dnd5eSimulationResult {
  actorId: string;
  actionKind: string;
  seed: number;
  rolls: number[];
  total?: number;
  success?: boolean;
  projectedDiffs: ProjectedDiff[];
  completeness: "complete" | "partial" | "unsupported";
  warnings: string[];
  resolvedContext: {
    itemId?: string;
    targetActorId?: string;
    modifier?: number;
    targetAC?: number;
    damageFormula?: string;
    damageType?: string;
  };
  documentRevisions: Array<{
    kind: "actor" | "target" | "item" | "token" | "combat";
    id: string;
    before: string;
    after: string;
  }>;
  beforeRevision: string;
  afterRevision: string;
  beforeCounts: { chat: number; combat: number; effects: number };
  afterCounts: { chat: number; combat: number; effects: number };
  persisted: false;
  deterministic: true;
  steps: Array<{
    index: number;
    actionKind: Dnd5eSimulationAction["kind"];
    status: "projected" | "failed";
    rolls: number[];
    total?: number;
    success?: boolean;
    projectedDiffs: ProjectedDiff[];
    warnings: string[];
    errorCode?: string;
  }>;
  completedSteps: number;
  stoppedAtStep: number | null;
}
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
export function rollFormula(
  formula: string,
  seed: number,
  supplied: number[] = [],
): { rolls: number[]; total: number } {
  const match = /^(\d{1,2})d(\d{1,4})([+-]\d+)?$/.exec(formula.replace(/\s/g, ""));
  if (!match) throw new Error(`Unsupported bounded dice formula "${formula}".`);
  const count = Number(match[1]),
    faces = Number(match[2]),
    bonus = Number(match[3] ?? 0);
  if (count < 1 || count > 100 || faces < 2 || faces > 1000)
    throw new Error("Dice formula is outside simulation bounds.");
  const random = seededRandom(seed);
  const rolls: number[] = [];
  for (let i = 0; i < count; i++) {
    const value = supplied[i] ?? Math.floor(random() * faces) + 1;
    if (!Number.isInteger(value) || value < 1 || value > faces)
      throw new Error(`Supplied roll ${i} is outside 1..${faces}.`);
    rolls.push(value);
  }
  return { rolls, total: rolls.reduce((a, b) => a + b, 0) + bonus };
}
