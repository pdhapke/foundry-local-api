/** Native combat primitives; rules choices are supplied by the authenticated GM. */
export const GM_COMBAT_COMMANDS = { READ: "gmCombatRead", APPLY: "gmCombatApply" } as const;
export const GM_COMBAT_KINDS = [
  "read",
  "create",
  "add-combatants",
  "remove-combatants",
  "initiative",
  "start",
  "next",
  "end",
  "budget-initialize",
  "budget-spend",
  "budget-adjust",
  "ready",
  "ready-expire",
  "interrupt-open",
  "interrupt-resolve",
  "special-decision",
] as const;
export type CombatBudgetResource = "action" | "bonus" | "reaction" | "movement";
export interface CombatBudget {
  action: number;
  bonus: number;
  reaction: number;
  movement: number;
  movementMode: string;
  movementBase: number;
  turnKey: string;
}
export interface CombatReady {
  id: string;
  combatantId: string;
  trigger: string;
  activityUuid: string | null;
  concentrationEffectId: string | null;
  expiresBeforeTurn: string;
  status: "held" | "spent" | "expired";
  heldSpell?: {
    castReceiptKey: string;
    tokenId: string;
    actorUuid: string;
    itemId: string;
    activityId: string;
    spellSlot: string | null;
    scaling: number;
    originalConcentration: boolean;
  };
}
export interface CombatInterrupt {
  id: string;
  kind: "opportunity" | "ready" | "reaction" | "legendary" | "lair" | "mythic";
  combatantId: string;
  trigger: string;
  readyId: string | null;
  status: "pending" | "accepted" | "declined";
  activityUuid: string | null;
  resolutionReceipt: string | null;
  /** Same outer durable native activity reservation; prevents double reaction spend. */
  reservedActivityKey?: string;
}
export interface CombatLedger {
  version: 1;
  revision: number;
  cursor: string;
  budgets: Record<string, CombatBudget>;
  ready: CombatReady[];
  interrupts: CombatInterrupt[];
  decisions: {
    kind: string;
    combatantId: string;
    ruling: string;
    activityUuid: string | null;
    round: number;
    turn: number | null;
  }[];
}
const fields: Record<string, string[]> = {
  read: ["combatId"],
  create: ["tokenIds"],
  "add-combatants": ["combatId", "tokenIds"],
  "remove-combatants": ["combatId", "combatantIds"],
  initiative: ["combatId", "combatantIds", "rollMode"],
  start: ["combatId"],
  next: ["combatId"],
  end: ["combatId"],
  "budget-initialize": [
    "combatId",
    "combatantId",
    "movementMode",
    "actionCount",
    "bonusCount",
    "reactionCount",
    "ruling",
  ],
  "budget-spend": ["combatId", "combatantId", "resource", "amount", "ruling"],
  "budget-adjust": ["combatId", "combatantId", "resource", "amount", "ruling"],
  ready: [
    "combatId",
    "combatantId",
    "choiceId",
    "trigger",
    "activityUuid",
    "concentrationEffectId",
  ],
  "ready-expire": ["combatId", "choiceId"],
  "interrupt-open": [
    "combatId",
    "combatantId",
    "choiceId",
    "interruptKind",
    "trigger",
    "readyId",
    "activityUuid",
  ],
  "interrupt-resolve": ["combatId", "choiceId", "decision", "resolutionReceipt"],
  "special-decision": ["combatId", "combatantId", "decisionKind", "ruling", "activityUuid"],
};
const textFields = [
  "combatId",
  "combatantId",
  "movementMode",
  "resource",
  "ruling",
  "choiceId",
  "trigger",
  "activityUuid",
  "concentrationEffectId",
  "interruptKind",
  "readyId",
  "decision",
  "resolutionReceipt",
  "decisionKind",
  "rollMode",
];
/** Validation runs both at transport and native dispatcher, which can be called directly. */
export function validateGmCombatAction(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid combat action");
  const a = value as Record<string, unknown>;
  const kind = a["kind"];
  if (typeof kind !== "string" || !fields[kind]) throw new Error("Unsupported combat action kind");
  if (Object.keys(a).some((k) => k !== "kind" && !fields[kind]!.includes(k)))
    throw new Error("Unexpected combat action field");
  for (const field of textFields)
    if (
      a[field] !== undefined &&
      (typeof a[field] !== "string" ||
        !(a[field] as string).trim() ||
        (a[field] as string).length > 2000)
    )
      throw new Error(`Invalid ${field}`);
  if (kind !== "create" && typeof a["combatId"] !== "string") throw new Error("combatId required");
  if (["create", "add-combatants", "remove-combatants", "initiative"].includes(kind)) {
    const ids = a[kind === "create" || kind === "add-combatants" ? "tokenIds" : "combatantIds"];
    if (
      !Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > 100 ||
      ids.some((id) => typeof id !== "string" || !id || id.length > 100) ||
      new Set(ids).size !== ids.length
    )
      throw new Error("Explicit unique IDs required (1..100)");
  }
  if (
    [
      "budget-initialize",
      "budget-spend",
      "budget-adjust",
      "ready",
      "interrupt-open",
      "special-decision",
    ].includes(kind) &&
    !a["combatantId"]
  )
    throw new Error("combatantId required");
  if (
    ["ready", "ready-expire", "interrupt-open", "interrupt-resolve"].includes(kind) &&
    !a["choiceId"]
  )
    throw new Error("choiceId required");
  if (["ready", "interrupt-open"].includes(kind) && !a["trigger"])
    throw new Error("Explicit trigger required");
  if (
    ["budget-initialize", "budget-spend", "budget-adjust", "special-decision"].includes(kind) &&
    !a["ruling"]
  )
    throw new Error("Explicit ruling required");
  if (["budget-spend", "budget-adjust"].includes(kind)) {
    if (!["action", "bonus", "reaction", "movement"].includes(String(a["resource"])))
      throw new Error("Invalid budget resource");
    if (
      typeof a["amount"] !== "number" ||
      !Number.isFinite(a["amount"]) ||
      a["amount"] < (kind === "budget-spend" ? 0.01 : 0) ||
      a["amount"] > 10000 ||
      (a["resource"] !== "movement" && !Number.isInteger(a["amount"]))
    )
      throw new Error("Invalid budget amount");
  }
  if (kind === "budget-initialize") {
    if (!a["movementMode"]) throw new Error("Explicit movementMode required");
    for (const field of ["actionCount", "bonusCount", "reactionCount"])
      if (
        a[field] !== undefined &&
        (!Number.isInteger(a[field]) || Number(a[field]) < 0 || Number(a[field]) > 10)
      )
        throw new Error(`Invalid ${field}`);
  }
  if (
    kind === "initiative" &&
    !["publicroll", "gmroll", "blindroll", "selfroll"].includes(String(a["rollMode"]))
  )
    throw new Error("Explicit native rollMode required");
  if (
    kind === "interrupt-open" &&
    !["opportunity", "ready", "reaction", "legendary", "lair", "mythic"].includes(
      String(a["interruptKind"]),
    )
  )
    throw new Error("Invalid interruption kind");
  if (kind === "interrupt-resolve" && !["accept", "decline"].includes(String(a["decision"])))
    throw new Error("Explicit interruption decision required");
  if (
    kind === "special-decision" &&
    ![
      "legendary-resistance",
      "legendary",
      "lair",
      "mythic",
      "extra-attack",
      "dash",
      "dodge",
      "disengage",
      "help",
      "improvised",
      "surprise",
    ].includes(String(a["decisionKind"]))
  )
    throw new Error("Invalid special decision kind");
}
