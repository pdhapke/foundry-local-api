// Public bridge contracts for the optional Trails of Destiny system.
//
// These DTOs deliberately contain only serializable data. Foundry documents,
// prepared data-model instances, and the system's retained source snapshots
// must be normalized/redacted by the module handlers before crossing the
// bridge.

export const TRAILS_COMMANDS = {
  CONFIG: "trails-of-destiny.get-config",
  ACTOR_SHEET: "trails-of-destiny.get-actor-sheet",
  ACTOR_INVENTORY: "trails-of-destiny.get-actor-inventory",
  LIST_CATALOGS: "trails-of-destiny.list-catalogs",
  GET_CATALOG: "trails-of-destiny.get-catalog",
  EVALUATE_CREATION: "trails-of-destiny.evaluate-creation",
  ROLL_ACTION: "trails-of-destiny.roll-action",
  PREVIEW_INITIATIVE: "trails-of-destiny.preview-initiative",
  PREVIEW_THREAT_CONTEST: "trails-of-destiny.preview-threat-contest",
  PREVIEW_DAMAGE: "trails-of-destiny.preview-damage",
  PREVIEW_RECOVERY: "trails-of-destiny.preview-recovery",
  EXPERIENCE_PROGRESS: "trails-of-destiny.get-experience-progress",
  PREVIEW_BUILDER: "trails-of-destiny.preview-builder",
} as const;

export type TrailsGetConfigInput = undefined;
export type TrailsListCatalogsInput = undefined;

export type TrailsJsonPrimitive = boolean | number | string | null;
export type TrailsJsonValue =
  TrailsJsonPrimitive | TrailsJsonValue[] | { [key: string]: TrailsJsonValue };
export interface TrailsJsonObject {
  [key: string]: TrailsJsonValue;
}

/** Versions with distinct ownership; none may be inferred from another. */
export interface TrailsContractVersions {
  packageVersion: string;
  rulesVersion: string | null;
  gameplayRulesVersion: string | null;
}

export interface TrailsSourceCitation {
  chapter?: number | undefined;
  printedPage?: number | undefined;
  printedPages?: number[] | undefined;
  pdfPage?: number | undefined;
  section?: string | undefined;
  sections?: string[] | undefined;
  entry?: string | undefined;
  bookHash?: string | undefined;
}

export type TrailsIssueSeverity = "error" | "review" | "manual" | "reference";

export interface TrailsIssue {
  code: string;
  message: string;
  path?: string | undefined;
  severity: TrailsIssueSeverity;
  lane?: string | undefined;
  source?: TrailsSourceCitation | undefined;
}

export interface TrailsUnmappedValue {
  path: string;
  reason: string;
  value: TrailsJsonValue;
}

export type TrailsRuleStatus = "implemented" | "interpretation" | "reference" | "unresolved";
export type TrailsActorType = "character" | "npc";
export type TrailsItemType = "talent" | "connection" | "craft" | "equipment" | "quartz" | "core";
export type TrailsResourceId = "durability" | "health" | "vigor" | "mana" | "energy";

export interface TrailsConfigEntry {
  id: string;
  label: string;
}

export interface TrailsThreatClassification {
  id: "attack" | "assault";
  defense: "guard" | "ward";
  reaction: "defense" | "resistance";
  reactionResource: "vigor" | "mana";
  source: TrailsSourceCitation;
}

export interface TrailsCatalogDescriptor {
  packId: string;
  label: string;
}

export interface TrailsCapabilities {
  evaluateCreation: boolean;
  runtimeCatalogs: boolean;
  resolveActionRoll: boolean;
  previewInitiative: boolean;
  previewThreatContest: boolean;
  previewPostMitigationDamage: boolean;
  buildRecoveryPlan: boolean;
  experienceProgress: boolean;
  parseBuilderV1: boolean;
  validateBuilderV1: boolean;
  previewBuilderV1: boolean;
}

export interface TrailsConfigResult {
  versions: TrailsContractVersions;
  abilities: TrailsConfigEntry[];
  itemTypes: TrailsConfigEntry[];
  damageTypes: TrailsConfigEntry[];
  dieRanks: number[];
  threatClassifications: TrailsThreatClassification[];
  catalogs: TrailsCatalogDescriptor[];
  capabilities: TrailsCapabilities;
}

export interface TrailsActorIdInput {
  id: string;
}

export interface TrailsPreparedAbility {
  id: string;
  label: string;
  value: number;
  bonus: number;
  total: number;
  bonusDice: number;
}

export interface TrailsPreparedResource {
  id: TrailsResourceId;
  value: number;
  max: number;
}

export interface TrailsReadinessCounts {
  error: number;
  review: number;
  manual: number;
  reference: number;
  retained: number;
}

export interface TrailsReadinessSummary {
  ready: boolean;
  issues: TrailsIssue[];
  blockingIssues: TrailsIssue[];
  retained: TrailsUnmappedValue[];
  counts: TrailsReadinessCounts;
}

export interface TrailsActorSheetResult {
  versions: TrailsContractVersions;
  id: string;
  name: string;
  type: TrailsActorType;
  schemaVersion: number;
  actorRulesVersion: string;
  level: number;
  concept: string;
  historyId: string;
  destinyId: string;
  elementalAffinityId: string;
  martialAffinityId: string;
  nativeLanguage: string;
  languages: string[];
  abilities: TrailsPreparedAbility[];
  resources: TrailsPreparedResource[];
  defenses: { guard: number; ward: number; armor: number };
  actions: number;
  reputation: number;
  movement: { combat: number; overland: number };
  carryingCapacity: number;
  currency: { mira: number; equipmentAllowance: number };
  readiness: TrailsReadinessSummary;
  boundary: string;
}

export interface TrailsItemOrigin {
  kind: string;
  sourceCatalogId: string;
  sourceInstanceId: string;
  sourceUuid: string;
  grantId: string;
  slotId: string;
}

interface TrailsInventoryItemBase {
  /** Foundry embedded-document identity; distinct from both system identities. */
  _id: string;
  /** Reusable canonical catalog identity; duplicate values are valid. */
  catalogId: string;
  /** Identity of this owned copy; never generated by a read operation. */
  instanceId: string;
  name: string;
  schemaVersion: number;
  status: TrailsRuleStatus;
  provenance: string;
  source: TrailsSourceCitation;
  origin: TrailsItemOrigin;
}

export interface TrailsTalentInventoryItem extends TrailsInventoryItemBase {
  type: "talent";
  details: {
    category: string;
    rank: number;
    skillPointCost: number;
    choice: string;
    rolls: number[];
    active: boolean;
    purchaseOrder: number;
  };
}

export interface TrailsConnectionInventoryItem extends TrailsInventoryItemBase {
  type: "connection";
  details: {
    connectionType: string;
    category: string;
    quality: string;
    rank: number;
    identity: string;
    active: boolean;
  };
}

export interface TrailsCraftInventoryItem extends TrailsInventoryItemBase {
  type: "craft";
  details: {
    entitlementId: string;
    baseId: string;
    school: string;
    affinityKind: string;
    rank: string;
    craftType: string;
    resource: string;
    cost: number;
    range: string;
    duration: string;
    modifierId: string;
    modifierChoice: string;
    form: string;
  };
}

export interface TrailsEquipmentInventoryItem extends TrailsInventoryItemBase {
  type: "equipment";
  details: {
    category: string;
    quality: string;
    quantity: number;
    price: number;
    equipped: boolean;
    attuned: boolean;
    hands: number;
    armor: number;
    acquisition: string;
    grantingSource: string;
  };
}

export interface TrailsQuartzInventoryItem extends TrailsInventoryItemBase {
  type: "quartz";
  details: {
    element: string;
    rank: number;
    socket: number;
    equipped: boolean;
    arts: string[];
    acquisition: string;
  };
}

export interface TrailsCoreInventoryItem extends TrailsInventoryItemBase {
  type: "core";
  details: {
    coreType: string;
    element: string;
    rank: number;
    socket: number;
    equipped: boolean;
    arts: string[];
    acquisition: string;
  };
}

export type TrailsInventoryItem =
  | TrailsTalentInventoryItem
  | TrailsConnectionInventoryItem
  | TrailsCraftInventoryItem
  | TrailsEquipmentInventoryItem
  | TrailsQuartzInventoryItem
  | TrailsCoreInventoryItem;

export interface TrailsActorInventoryResult {
  versions: TrailsContractVersions;
  actorId: string;
  items: TrailsInventoryItem[];
  boundary: string;
}

export interface TrailsCatalogSummary extends TrailsCatalogDescriptor {
  accessible: boolean;
  entryCount: number | null;
}

export interface TrailsCatalogListResult {
  versions: TrailsContractVersions;
  catalogs: TrailsCatalogSummary[];
}

export interface TrailsCatalogInput {
  packId: string;
}

export interface TrailsCatalogEntry {
  /** Portable identity within its catalog; a compendium UUID is not returned as identity. */
  catalogId: string;
  name: string;
  catalog: string;
  itemType: TrailsItemType | null;
  status: TrailsRuleStatus;
  source: TrailsSourceCitation;
  data: TrailsJsonObject;
}

export interface TrailsCatalogResult {
  versions: TrailsContractVersions;
  packId: string;
  label: string;
  entries: TrailsCatalogEntry[];
}

export type TrailsCreationLaneId = "identity" | "training" | "loadout" | "orbment";

export interface TrailsCreationLaneResult {
  id: TrailsCreationLaneId;
  status: TrailsRuleStatus;
  issues: TrailsIssue[];
  findings: TrailsJsonObject;
  boundary?: string | undefined;
}

export interface TrailsCreationReadinessResult {
  versions: TrailsContractVersions;
  actorId: string;
  readiness: TrailsReadinessSummary;
  lanes: TrailsCreationLaneResult[];
  unmapped: TrailsUnmappedValue[];
  boundary: string;
}

export interface TrailsConditionalDieInput {
  id: string;
  label: string;
  selected: boolean;
  dice: number;
  source: TrailsSourceCitation | null;
}

export interface TrailsActionRollInput {
  kind: "action" | "skill";
  abilityId: string;
  skillId: string;
  abilityDice: number;
  skillDice: number;
  otherDice: number;
  abilityChallenges: number;
  challenges: number;
  chances: number;
  charges: number;
  vs?: number | null | undefined;
  conditionalDice: TrailsConditionalDieInput[];
}

export interface TrailsActionDieResult {
  sides: 20;
  value: number;
  natural20: boolean;
  bursts: 0;
}

export interface TrailsBonusDieResult {
  count: number;
  sides: number;
  chains: number[][];
  values: number[];
  bursts: number;
  total: number;
}

export interface TrailsDieRankResult {
  baseSides: number;
  sides: number;
  challenges: number;
  charges: number;
  cancelled: number;
  remainingChallenges: number;
  remainingCharges: number;
}

export interface TrailsActionRollResult {
  versions: TrailsContractVersions;
  contractVersion: number;
  kind: "action" | "skill";
  abilityId: string;
  skillId: string;
  dice: {
    ability: number;
    skill: number;
    conditional: number;
    other: number;
    total: number;
    conditions: TrailsConditionalDieInput[];
  };
  modifiers: {
    abilityChallenges: number;
    challenges: number;
    charges: number;
    chances: number;
    rank: TrailsDieRankResult;
  };
  vs: {
    base: number | null;
    adjusted: number | null;
    success: boolean | null;
    tie: boolean;
    rule: "meet-or-exceed";
  };
  action: TrailsActionDieResult;
  bonus: TrailsBonusDieResult;
  total: number;
  source: TrailsSourceCitation;
  boundary: string;
}

export interface TrailsInitiativeParticipantInput {
  id: string;
  label?: string | undefined;
  bonusDice: number;
  challenges: number;
  charges: number;
  /** Must remain zero; Trails initiative cannot take Chances. */
  chances?: 0 | undefined;
  sources: TrailsSourceCitation[];
}

export interface TrailsInitiativeInput {
  participants: TrailsInitiativeParticipantInput[];
}

export interface TrailsInitiativeParticipantResult {
  id: string;
  label: string;
  inputIndex: number;
  action: TrailsActionDieResult;
  bonus: TrailsBonusDieResult;
  rank: TrailsDieRankResult;
  total: number;
  sources: TrailsSourceCitation[];
}

export interface TrailsInitiativeGroup {
  total: number;
  tied: boolean;
  requiresManualOrder: boolean;
  participants: TrailsInitiativeParticipantResult[];
}

export interface TrailsInitiativeResult {
  versions: TrailsContractVersions;
  contractVersion: number;
  source: TrailsSourceCitation;
  groups: TrailsInitiativeGroup[];
  complete: boolean;
  boundary: string;
}

export interface TrailsThreatContestInput {
  classification: "attack" | "assault";
  actionTotal: number;
  passiveDefense: number;
  reactionTotal?: number | null | undefined;
}

export interface TrailsThreatContestResult {
  versions: TrailsContractVersions;
  contractVersion: number;
  classification: TrailsThreatClassification;
  actionTotal: number;
  passiveDefense: number;
  reactionTotal: number | null;
  opposed: boolean;
  tie: boolean;
  hit: boolean;
  rule: "reaction-must-strictly-exceed; ties-favor-initiator" | "meet-or-exceed";
  boundary: string;
}

export type TrailsLifeState = "active" | "shock" | "dead";

export interface TrailsDamagePreviewInput {
  durability: number;
  health: number;
  /** Final damage after armor, resistance, weakness, and other mitigation. */
  damage: number;
  lifeState?: TrailsLifeState | undefined;
}

export interface TrailsDamageState {
  durability: number;
  health: number;
  lifeState: TrailsLifeState;
}

export interface TrailsDamagePreviewResult {
  versions: TrailsContractVersions;
  contractVersion: number;
  before: TrailsDamageState;
  after: TrailsDamageState;
  damage: number;
  durabilityDamage: number;
  healthDamage: number;
  wounded: boolean;
  shock: boolean;
  dead: boolean;
  transition: "manual-review" | null;
  issues: TrailsIssue[];
  source: TrailsSourceCitation;
  boundary: string;
}

export interface TrailsRecoveryResourceInput {
  value: number;
  max: number;
}

export type TrailsRecoveryResourceMap = Record<TrailsResourceId, TrailsRecoveryResourceInput>;
export type TrailsRecoveryEligibility = Record<TrailsResourceId, boolean>;

export interface TrailsRecoveryPreviewInput {
  kind: "break" | "sleep";
  resources: TrailsRecoveryResourceMap;
  stamina?: number | undefined;
  staminaBonusDice?: number | undefined;
  soulBonusDice?: number | undefined;
  staminaDice?: number[] | null | undefined;
  soulDice?: number[] | null | undefined;
  eligibility: TrailsRecoveryEligibility;
}

export interface TrailsRecoveryOperation {
  resource: TrailsResourceId;
  before: number;
  max: number;
  requested: number;
  recovered: number;
  after: number;
  eligible: boolean;
  reason: string;
}

export interface TrailsRecoveryClaim {
  id: string;
  cadence: "once-per-day";
  verified: false;
}

interface TrailsRecoveryResultBase {
  versions: TrailsContractVersions;
  source: TrailsSourceCitation;
}

export interface TrailsRecoveryPreviewFailure extends TrailsRecoveryResultBase {
  ok: false;
  issues: TrailsIssue[];
}

export interface TrailsRecoveryPreviewSuccess extends TrailsRecoveryResultBase {
  ok: true;
  kind: "break" | "sleep";
  inputs: {
    stamina: number;
    staminaBonusDice: number;
    soulBonusDice: number;
    staminaDice: number[] | null;
    soulDice: number[] | null;
    eligibility: TrailsRecoveryEligibility;
  };
  operations: TrailsRecoveryOperation[];
  claims: TrailsRecoveryClaim[];
  manualBoundary: string;
}

export type TrailsRecoveryPreviewResult =
  TrailsRecoveryPreviewFailure | TrailsRecoveryPreviewSuccess;

export interface TrailsExperienceProgressInput {
  totalExperience: number;
}

export interface TrailsExperienceProgressFailure {
  versions: TrailsContractVersions;
  ok: false;
  issues: TrailsIssue[];
}

export interface TrailsExperienceProgressSuccess {
  versions: TrailsContractVersions;
  ok: true;
  source: TrailsSourceCitation;
  totalExperience: number;
  level: number;
  currentThreshold: number;
  nextThreshold: number | null;
  earnedIntoLevel: number;
  requiredForNext: number | null;
  remaining: number | null;
  publishedTableExhausted: boolean;
}

export type TrailsExperienceProgressResult =
  TrailsExperienceProgressFailure | TrailsExperienceProgressSuccess;

export interface TrailsBuilderPreviewInput {
  raw: string;
}

export interface TrailsBuilderActorPreview {
  name: string;
  type: "character";
  schemaVersion: number;
  rulesVersion: string;
  concept: string;
  historyId: string;
  destinyId: string;
  elementalAffinityId: string;
  martialAffinityId: string;
  nativeLanguage: string;
  languages: string[];
  abilities: Record<string, number>;
}

export interface TrailsBuilderItemPreview {
  name: string;
  type: TrailsItemType;
  catalogId: string;
  status: TrailsRuleStatus;
  source: TrailsSourceCitation;
  fields: TrailsJsonObject;
}

export interface TrailsBuilderPreviewResult {
  versions: TrailsContractVersions;
  contractVersion: number;
  builderVersion: number;
  valid: boolean;
  actor: TrailsBuilderActorPreview | null;
  items: TrailsBuilderItemPreview[];
  issues: TrailsIssue[];
  unmapped: TrailsUnmappedValue[];
  boundary: string;
}
