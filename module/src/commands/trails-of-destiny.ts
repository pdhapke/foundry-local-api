// Trails of Destiny optional-system command handlers (integration plan Phase 3).
//
// This file is safe to import in every world: it deliberately performs no
// CONFIG.TRAILS or game lookups at module evaluation time. Registrations are
// static, while every Foundry/system capability is resolved inside a handler.

import {
  TRAILS_COMMANDS,
  type TrailsActionRollInput,
  type TrailsActionRollResult,
  type TrailsActorIdInput,
  type TrailsActorInventoryResult,
  type TrailsActorSheetResult,
  type TrailsBuilderActorPreview,
  type TrailsBuilderItemPreview,
  type TrailsBuilderPreviewInput,
  type TrailsBuilderPreviewResult,
  type TrailsCatalogEntry,
  type TrailsCatalogInput,
  type TrailsCatalogListResult,
  type TrailsCatalogResult,
  type TrailsConfigEntry,
  type TrailsConfigResult,
  type TrailsContractVersions,
  type TrailsCreationLaneId,
  type TrailsCreationLaneResult,
  type TrailsCreationReadinessResult,
  type TrailsDamagePreviewInput,
  type TrailsDamagePreviewResult,
  type TrailsExperienceProgressInput,
  type TrailsExperienceProgressResult,
  type TrailsIssue,
  type TrailsInitiativeInput,
  type TrailsInitiativeResult,
  type TrailsJsonObject,
  type TrailsJsonValue,
  type TrailsInventoryItem,
  type TrailsItemType,
  type TrailsItemOrigin,
  type TrailsReadinessSummary,
  type TrailsRecoveryPreviewInput,
  type TrailsRecoveryPreviewResult,
  type TrailsSourceCitation,
  type TrailsThreatClassification,
  type TrailsThreatContestInput,
  type TrailsThreatContestResult,
  type TrailsUnmappedValue,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";

const TRAILS_SYSTEM_ID = "trails-of-destiny";
const REQUIRED_TRAILS_VERSION = "0.1.0";

export const TRAILS_CATALOG_PACKS = Object.freeze([
  Object.freeze({ id: `${TRAILS_SYSTEM_ID}.character-options`, label: "Character Options" }),
  Object.freeze({ id: `${TRAILS_SYSTEM_ID}.social`, label: "Social Records" }),
  Object.freeze({ id: `${TRAILS_SYSTEM_ID}.crafts-arts`, label: "Crafts and Arts" }),
  Object.freeze({ id: `${TRAILS_SYSTEM_ID}.equipment-orbment`, label: "Equipment and Orbment" }),
] as const);

const TRAILS_CATALOG_PACK_IDS: ReadonlySet<string> = new Set(
  TRAILS_CATALOG_PACKS.map(({ id }) => id),
);

export type TrailsCapabilityNamespace = "creation" | "gameplay" | "builder";

export type TrailsCommandErrorCode =
  | "TRAILS_CAPABILITY_UNAVAILABLE"
  | "TRAILS_ACTOR_UNAVAILABLE"
  | "TRAILS_PACK_UNAVAILABLE"
  | "TRAILS_RESPONSE_UNSAFE"
  | "TRAILS_RUNTIME_ERROR";

/**
 * Error messages cross the bridge, while arbitrary thrown values must not.
 * The stable code makes unit assertions and future structured logging useful;
 * the dispatcher currently exposes only the intentionally-safe message.
 */
export class TrailsCommandError extends Error {
  readonly code: TrailsCommandErrorCode;

  constructor(code: TrailsCommandErrorCode, message: string) {
    super(message);
    this.name = "TrailsCommandError";
    this.code = code;
  }
}

interface TrailsRuntimeConfig {
  abilities?: Record<string, unknown> | undefined;
  itemTypes?: Record<string, unknown> | undefined;
  rulesVersion?: unknown;
  RULES_VERSION?: unknown;
  creation?: Record<string, unknown> | undefined;
  gameplay?: Record<string, unknown> | undefined;
  builder?: Record<string, unknown> | undefined;
}

interface TrailsRuntimeCatalogContext {
  catalogs?: Record<string, unknown> | undefined;
}

type LoadRuntimeCatalogContext = (options?: {
  packs?: Map<string, TrailsCatalogPack> | undefined;
}) => Promise<TrailsRuntimeCatalogContext>;

interface TrailsRuntimeGlobals {
  CONFIG?: ({ TRAILS?: TrailsRuntimeConfig | undefined } & Record<string, unknown>) | undefined;
  game?:
    | {
        user?: FoundryUser | undefined;
        system?: { version?: unknown } | undefined;
        i18n?: { localize?: ((key: string) => string) | undefined } | undefined;
        collections?: Map<string, FoundryWorldCollection> | undefined;
        packs?: Map<string, FoundryCompendiumCollection> | undefined;
      }
    | undefined;
}

interface PermissionTestable {
  /** Foundry's normal document permission check; OBSERVER is the read boundary. */
  testUserPermission?:
    ((user: FoundryUser, permission: string, options?: { exact?: boolean }) => boolean) | undefined;
  /** CompendiumCollection and Documents expose this derived visibility flag. */
  visible?: boolean | undefined;
}

export type TrailsActorDocument = FoundryActor & PermissionTestable;
export type TrailsCatalogPack = FoundryCompendiumCollection & PermissionTestable;

function runtimeGlobals(): TrailsRuntimeGlobals {
  return globalThis as unknown as TrailsRuntimeGlobals;
}

/**
 * Resolve and bind one public Trails runtime function at call time. No Trails
 * module is imported, and merely importing this command file touches no
 * Foundry global, which keeps non-Trails worlds safe.
 */
export function requireTrailsCapability<TArgs extends unknown[], TResult>(
  namespace: TrailsCapabilityNamespace,
  capability: string,
): (...args: TArgs) => TResult {
  const target = runtimeGlobals().CONFIG?.TRAILS?.[namespace];
  const candidate = target?.[capability];
  if (typeof candidate !== "function") {
    throw new TrailsCommandError(
      "TRAILS_CAPABILITY_UNAVAILABLE",
      `Trails capability "${namespace}.${capability}" is unavailable. Activate ${TRAILS_SYSTEM_ID} ${REQUIRED_TRAILS_VERSION} or newer and reload the world; the installed system may not provide this API.`,
    );
  }
  return candidate.bind(target) as (...args: TArgs) => TResult;
}

function canObserve(document: PermissionTestable, user: FoundryUser): boolean {
  if (user.isGM) return true;
  if (typeof document.testUserPermission === "function") {
    try {
      return document.testUserPermission(user, "OBSERVER");
    } catch {
      // A changed or broken permission API must fail closed, not fall through
      // to returning data from a document which happened to be found.
      return false;
    }
  }
  return document.visible === true;
}

/**
 * Find a world Actor while enforcing Foundry's normal OBSERVER visibility.
 * Missing and forbidden actors intentionally share one response so callers
 * cannot probe private actor ids.
 */
export function requireVisibleTrailsActor(id: string): TrailsActorDocument {
  const runtime = runtimeGlobals().game;
  const user = runtime?.user;
  const actor = runtime?.collections?.get("Actor")?.get(id) as TrailsActorDocument | undefined;
  if (!user || !actor || !canObserve(actor, user)) {
    throw new TrailsCommandError(
      "TRAILS_ACTOR_UNAVAILABLE",
      "Trails actor is unavailable or not visible to the current Foundry user. Confirm the actor exists and grant at least OBSERVER permission.",
    );
  }
  return actor;
}

/**
 * Resolve one of the four system-owned public catalogs and enforce current
 * pack visibility. Disallowed, absent, and forbidden ids are deliberately
 * indistinguishable to prevent pack-discovery side channels.
 */
export function requireAccessibleTrailsPack(packId: string): TrailsCatalogPack {
  const runtime = runtimeGlobals().game;
  const user = runtime?.user;
  const pack = runtime?.packs?.get(packId) as TrailsCatalogPack | undefined;
  if (!TRAILS_CATALOG_PACK_IDS.has(packId) || !user || !pack || !canObserve(pack, user)) {
    throw new TrailsCommandError(
      "TRAILS_PACK_UNAVAILABLE",
      "Trails catalog is unavailable or not visible to the current Foundry user. Use a catalog reported by trails_list_catalogs and verify compendium permissions.",
    );
  }
  return pack;
}

// Normalized so a casing or separator change cannot accidentally expose a
// known-sensitive field. This is a denylist defense behind the explicit DTO
// projection later handlers must still perform; it is not a substitute for
// those allowlisted public response shapes.
const SENSITIVE_TRAILS_KEYS = new Set([
  "sourcesnapshot",
  "rawsnapshot",
  "biography",
  "campaignnotes",
  "adjudications",
  "abilityrolls",
  "issuedselections",
  "builderevidence",
  "selectionevidence",
  "recordedselections",
  "rawdocument",
  "documentdump",
  "secret",
  "secrets",
]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function containsSecretMarkup(value: string): boolean {
  return (
    /class\s*=\s*["'][^"']*\bsecret\b/i.test(value) ||
    /data-visibility\s*=\s*["'](?:gm|owner)["']/i.test(value)
  );
}

/**
 * Clone JSON-shaped system data while recursively removing private Trails
 * evidence. Unsupported/cyclic values fail instead of being stringified into
 * surprising output. Later handlers must additionally project explicit DTOs
 * rather than return this object as a raw Foundry document dump.
 */
export function cloneAndRedactTrailsData<T>(value: T): T {
  const ancestors = new WeakSet<object>();

  const visit = (input: unknown, path: string): unknown => {
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string") return containsSecretMarkup(input) ? "[REDACTED]" : input;
    if (typeof input === "number") {
      if (Number.isFinite(input)) return input;
      throw unsafeResponse(path, "non-finite number");
    }
    if (Array.isArray(input)) {
      if (ancestors.has(input)) throw unsafeResponse(path, "cyclic array");
      ancestors.add(input);
      const result = input.map((entry, index) => visit(entry, `${path}[${index}]`));
      ancestors.delete(input);
      return result;
    }
    if (typeof input === "object") {
      if (ancestors.has(input)) throw unsafeResponse(path, "cyclic object");
      ancestors.add(input);
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(input)) {
        if (SENSITIVE_TRAILS_KEYS.has(normalizedKey(key))) continue;
        const entryType = typeof entry;
        if (entry === undefined || entryType === "function" || entryType === "symbol") continue;
        if (entryType === "bigint") throw unsafeResponse(`${path}.${key}`, "bigint");
        result[key] = visit(entry, `${path}.${key}`);
      }
      ancestors.delete(input);
      return result;
    }
    throw unsafeResponse(path, `unsupported ${typeof input}`);
  };

  return visit(value, "$ Trails response") as T;
}

function unsafeResponse(path: string, reason: string): TrailsCommandError {
  return new TrailsCommandError(
    "TRAILS_RESPONSE_UNSAFE",
    `Trails could not safely serialize response data at ${path} (${reason}). Update the Trails integration or omit that value.`,
  );
}

/**
 * Convert an unknown third-party runtime failure without forwarding its raw
 * message, which may contain document values. Our own pre-sanitized errors
 * pass through unchanged.
 */
export function toActionableTrailsError(error: unknown, action: string): TrailsCommandError {
  if (error instanceof TrailsCommandError) return error;
  return new TrailsCommandError(
    "TRAILS_RUNTIME_ERROR",
    `Trails could not ${action}. Verify that ${TRAILS_SYSTEM_ID} ${REQUIRED_TRAILS_VERSION} or newer is active, reload the world, and try again. Runtime error details were suppressed to protect world data.`,
  );
}

type UnknownRecord = Record<string, unknown>;

interface TrailsActorRuntimeDocument extends TrailsActorDocument {
  name?: unknown;
  type?: unknown;
  system: UnknownRecord;
  items: Map<string, FoundryDocument>;
}

interface TrailsItemRuntimeDocument extends FoundryDocument {
  name?: unknown;
  type?: unknown;
  system?: UnknownRecord | undefined;
}

interface TrailsCatalogRuntimeDocument extends FoundryDocument {
  flags?: UnknownRecord | undefined;
}

interface TrailsCatalogDocumentsPack extends TrailsCatalogPack {
  getDocuments(): Promise<TrailsCatalogRuntimeDocument[]>;
}

const ACTOR_SHEET_BOUNDARY =
  "Read-only prepared Actor summary; no derived field, resource, document, or readiness state was persisted.";
const ACTOR_INVENTORY_BOUNDARY =
  "Read-only owned Item snapshot; document, catalog, and owned-instance identities remain distinct and duplicate catalog IDs are retained.";
const CREATION_READINESS_BOUNDARY =
  "Creation readiness preview only; no Actor, owned Item, catalog, builder evidence, or other Foundry state was changed.";
const BUILDER_PREVIEW_BOUNDARY =
  "Builder preview only; no Actor or Item was created, no request was executed or reconciled, no identity was generated, and no Foundry document or catalog was changed.";

const READINESS_UNAVAILABLE_ISSUE: TrailsIssue = Object.freeze({
  code: "prepared-readiness-unavailable",
  message:
    "Prepared readiness evidence is not available on this Actor; use the creation-readiness operation for a live catalog-backed evaluation.",
  path: "system.readiness",
  severity: "review",
  lane: "actor-sheet",
});

const RESOURCE_IDS = ["durability", "health", "vigor", "mana", "energy"] as const;
const ISSUE_SEVERITIES = new Set(["error", "review", "manual", "reference"] as const);

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asNonnegativeInteger(value: unknown): number {
  const number = asNumber(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function ruleStatus(value: unknown): TrailsInventoryItem["status"] {
  return value === "implemented" ||
    value === "interpretation" ||
    value === "reference" ||
    value === "unresolved"
    ? value
    : "unresolved";
}

function itemOrigin(value: unknown): TrailsItemOrigin {
  const origin = asRecord(value);
  return {
    kind: asString(origin["kind"]),
    sourceCatalogId: asString(origin["sourceCatalogId"]),
    sourceInstanceId: asString(origin["sourceInstanceId"]),
    sourceUuid: asString(origin["sourceUuid"]),
    grantId: asString(origin["grantId"]),
    slotId: asString(origin["slotId"]),
  };
}

function liveTrailsConfig(): TrailsRuntimeConfig {
  const config = runtimeGlobals().CONFIG?.TRAILS;
  if (!config) {
    throw new TrailsCommandError(
      "TRAILS_CAPABILITY_UNAVAILABLE",
      `Trails configuration is unavailable. Activate ${TRAILS_SYSTEM_ID} ${REQUIRED_TRAILS_VERSION} or newer and reload the world.`,
    );
  }
  return config;
}

function localizedConfigEntries(value: unknown): TrailsConfigEntry[] {
  const localize = runtimeGlobals().game?.i18n?.localize;
  return Object.entries(asRecord(value)).map(([id, rawLabel]) => {
    const labelKey = asString(rawLabel) || id;
    let label = labelKey;
    if (localize) {
      try {
        label = localize(labelKey);
      } catch {
        // Localization is presentational. Preserve the live key if the
        // current localization engine cannot resolve it.
      }
    }
    return { id, label };
  });
}

function liveVersions(actorRulesVersion?: unknown): TrailsContractVersions {
  const config = liveTrailsConfig();
  return {
    packageVersion: asString(runtimeGlobals().game?.system?.version),
    rulesVersion:
      optionalString(config.RULES_VERSION) ??
      optionalString(config.rulesVersion) ??
      optionalString(actorRulesVersion),
    gameplayRulesVersion: optionalString(config.gameplay?.["GAMEPLAY_RULES_VERSION"]),
  };
}

function safeSourceCitation(value: unknown): TrailsSourceCitation | undefined {
  const source = asRecord(value);
  const result: TrailsSourceCitation = {};
  if (typeof source["chapter"] === "number") result.chapter = source["chapter"];
  if (typeof source["printedPage"] === "number") result.printedPage = source["printedPage"];
  if (Array.isArray(source["printedPages"])) {
    result.printedPages = source["printedPages"].filter(
      (entry): entry is number => typeof entry === "number" && Number.isFinite(entry),
    );
  }
  if (typeof source["pdfPage"] === "number") result.pdfPage = source["pdfPage"];
  if (typeof source["section"] === "string") result.section = source["section"];
  if (Array.isArray(source["sections"])) {
    result.sections = source["sections"].filter(
      (entry): entry is string => typeof entry === "string",
    );
  }
  if (typeof source["entry"] === "string") result.entry = source["entry"];
  if (typeof source["bookHash"] === "string") result.bookHash = source["bookHash"];
  return Object.keys(result).length > 0 ? result : undefined;
}

function configResult(): TrailsConfigResult {
  const config = liveTrailsConfig();
  const gameplay = config.gameplay ?? {};
  const capabilities = (namespace: Record<string, unknown> | undefined, name: string): boolean =>
    typeof namespace?.[name] === "function";

  const damageTypes = asArray(gameplay["DAMAGE_TYPES"]).map((entry) => {
    const record = asRecord(entry);
    return { id: asString(record["id"]), label: asString(record["label"]) };
  });
  const threatClassifications = Object.values(asRecord(gameplay["THREAT_CLASSIFICATIONS"])).flatMap(
    (entry): TrailsThreatClassification[] => {
      const record = asRecord(entry);
      const id = record["id"];
      const defense = record["defense"];
      const reaction = record["reaction"];
      const reactionResource = record["reactionResource"];
      if (
        (id !== "attack" && id !== "assault") ||
        (defense !== "guard" && defense !== "ward") ||
        (reaction !== "defense" && reaction !== "resistance") ||
        (reactionResource !== "vigor" && reactionResource !== "mana")
      ) {
        return [];
      }
      return [
        {
          id,
          defense,
          reaction,
          reactionResource,
          source: safeSourceCitation(record["source"]) ?? {},
        },
      ];
    },
  );

  return {
    versions: liveVersions(),
    abilities: localizedConfigEntries(config.abilities),
    itemTypes: localizedConfigEntries(config.itemTypes),
    damageTypes,
    dieRanks: asArray(gameplay["DIE_RANKS"]).filter(
      (entry): entry is number => typeof entry === "number" && Number.isFinite(entry),
    ),
    threatClassifications,
    catalogs: TRAILS_CATALOG_PACKS.map(({ id, label }) => ({ packId: id, label })),
    capabilities: {
      evaluateCreation: capabilities(config.creation, "evaluateCreation"),
      runtimeCatalogs:
        capabilities(config.creation, "loadRuntimeCatalogContext") ||
        capabilities(config.builder, "loadRuntimeCatalogContext"),
      resolveActionRoll: capabilities(config.gameplay, "resolveActionRoll"),
      previewInitiative: capabilities(config.gameplay, "previewInitiative"),
      previewThreatContest: capabilities(config.gameplay, "previewThreatContest"),
      previewPostMitigationDamage: capabilities(config.gameplay, "previewPostMitigationDamage"),
      buildRecoveryPlan: capabilities(config.gameplay, "buildRecoveryPlan"),
      experienceProgress: capabilities(config.gameplay, "experienceProgress"),
      parseBuilderV1:
        capabilities(config.creation, "parseBuilderV1") ||
        capabilities(config.builder, "parseBuilderV1"),
      validateBuilderV1:
        capabilities(config.creation, "validateBuilderV1") ||
        capabilities(config.builder, "validateBuilderV1"),
      previewBuilderV1:
        capabilities(config.creation, "previewBuilderV1") ||
        capabilities(config.builder, "previewBuilderV1"),
    },
  };
}

function safeIssue(value: unknown): TrailsIssue | null {
  const issue = asRecord(value);
  const severity = issue["severity"];
  if (!ISSUE_SEVERITIES.has(severity as "error" | "review" | "manual" | "reference")) {
    return null;
  }
  const result: TrailsIssue = {
    code: asString(issue["code"]) || "unspecified",
    message: asString(issue["message"]) || "Unspecified readiness issue.",
    severity: severity as TrailsIssue["severity"],
  };
  if (typeof issue["path"] === "string") result.path = issue["path"];
  if (typeof issue["lane"] === "string") result.lane = issue["lane"];
  const source = safeSourceCitation(issue["source"]);
  if (source) result.source = source;
  return result;
}

function isJsonValue(value: unknown): value is TrailsJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return (
    typeof value === "object" &&
    Object.values(value as UnknownRecord).every(
      (entry) => entry !== undefined && isJsonValue(entry),
    )
  );
}

function actorReadiness(system: UnknownRecord): TrailsReadinessSummary {
  const creation = asRecord(system["creation"]);
  const source = asRecord(system["readiness"] ?? creation["readiness"]);
  if (Object.keys(source).length === 0) {
    const issue = cloneAndRedactTrailsData(READINESS_UNAVAILABLE_ISSUE);
    return {
      ready: false,
      issues: [issue],
      blockingIssues: [issue],
      retained: [],
      counts: { error: 0, review: 1, manual: 0, reference: 0, retained: 0 },
    };
  }

  const redacted = asRecord(cloneAndRedactTrailsData(source));
  const issues = asArray(redacted["issues"])
    .map(safeIssue)
    .filter((issue) => issue !== null);
  const explicitBlocking = asArray(redacted["blockingIssues"])
    .map(safeIssue)
    .filter((issue) => issue !== null);
  const blockingIssues =
    redacted["blockingIssues"] === undefined
      ? issues.filter((issue) => issue.severity === "error" || issue.severity === "review")
      : explicitBlocking;
  const retained = asArray(redacted["retained"]).flatMap((entry) => {
    const record = asRecord(entry);
    const value = record["value"];
    return typeof record["path"] === "string" &&
      typeof record["reason"] === "string" &&
      isJsonValue(value)
      ? [{ path: record["path"], reason: record["reason"], value }]
      : [];
  });
  const suppliedCounts = asRecord(redacted["counts"]);
  const count = (severity: TrailsIssue["severity"]): number =>
    asNonnegativeInteger(suppliedCounts[severity]) ||
    issues.filter((issue) => issue.severity === severity).length;

  return {
    ready: typeof redacted["ready"] === "boolean" ? redacted["ready"] : blockingIssues.length === 0,
    issues,
    blockingIssues,
    retained,
    counts: {
      error: count("error"),
      review: count("review"),
      manual: count("manual"),
      reference: count("reference"),
      retained: asNonnegativeInteger(suppliedCounts["retained"]) || retained.length,
    },
  };
}

function actorSheetResult({ id }: TrailsActorIdInput): TrailsActorSheetResult {
  const actor = requireVisibleTrailsActor(id) as TrailsActorRuntimeDocument;
  if (actor.type !== "character" && actor.type !== "npc") {
    throw new TrailsCommandError(
      "TRAILS_RUNTIME_ERROR",
      "Trails actor sheet data is available only for character and npc Actors.",
    );
  }

  const system = asRecord(actor.system);
  const details = asRecord(system["details"]);
  const abilities = asRecord(system["abilities"]);
  const resources = asRecord(system["resources"]);
  const defenses = asRecord(system["defenses"]);
  const movement = asRecord(system["movement"]);
  const currency = asRecord(system["currency"]);
  const configAbilities = localizedConfigEntries(liveTrailsConfig().abilities);
  const abilityIds =
    configAbilities.length > 0
      ? configAbilities.map(({ id: abilityId }) => abilityId)
      : Object.keys(abilities);
  const abilityLabels = new Map(
    configAbilities.map(({ id: abilityId, label }) => [abilityId, label]),
  );
  const actorRulesVersion = asString(system["rulesVersion"]);

  return {
    versions: liveVersions(actorRulesVersion),
    id: actor.id,
    name: asString(actor.name),
    type: actor.type,
    schemaVersion: asNonnegativeInteger(system["schemaVersion"]),
    actorRulesVersion,
    level: asNonnegativeInteger(details["level"]),
    concept: asString(details["concept"]),
    historyId: asString(details["history"]),
    destinyId: asString(details["destiny"]),
    elementalAffinityId: asString(details["elementalAffinity"]),
    martialAffinityId: asString(details["martialAffinity"]),
    nativeLanguage: asString(details["nativeLanguage"]),
    languages: asArray(details["languages"]).filter(
      (language): language is string => typeof language === "string",
    ),
    abilities: abilityIds.map((abilityId) => {
      const ability = asRecord(abilities[abilityId]);
      return {
        id: abilityId,
        label: abilityLabels.get(abilityId) ?? abilityId,
        value: asNumber(ability["value"]),
        bonus: asNumber(ability["bonus"]),
        total: asNumber(ability["total"]),
        bonusDice: asNumber(ability["bonusDice"]),
      };
    }),
    resources: RESOURCE_IDS.map((resourceId) => {
      const resource = asRecord(resources[resourceId]);
      return {
        id: resourceId,
        value: asNumber(resource["value"]),
        max: asNumber(resource["max"]),
      };
    }),
    defenses: {
      guard: asNumber(defenses["guard"]),
      ward: asNumber(defenses["ward"]),
      armor: asNumber(defenses["armor"]),
    },
    actions: asNumber(system["actions"]),
    reputation: asNumber(system["reputation"]),
    movement: {
      combat: asNumber(movement["combat"]),
      overland: asNumber(movement["overland"]),
    },
    carryingCapacity: asNumber(system["carryingCapacity"]),
    currency: {
      mira: asNumber(currency["mira"]),
      equipmentAllowance: asNumber(currency["equipmentAllowance"]),
    },
    readiness: actorReadiness(system),
    boundary: ACTOR_SHEET_BOUNDARY,
  };
}

function inventoryItem(document: TrailsItemRuntimeDocument): TrailsInventoryItem | null {
  const type = document.type;
  if (
    type !== "talent" &&
    type !== "connection" &&
    type !== "craft" &&
    type !== "equipment" &&
    type !== "quartz" &&
    type !== "core"
  ) {
    return null;
  }
  const system = asRecord(document.system);
  const base = {
    _id: document.id,
    catalogId: asString(system["catalogId"]),
    instanceId: asString(system["instanceId"]),
    name: asString(document.name),
    schemaVersion: asNonnegativeInteger(system["schemaVersion"]),
    status: ruleStatus(system["status"]),
    provenance: asString(system["provenance"]),
    source: safeSourceCitation(system["source"]) ?? {},
    origin: itemOrigin(system["origin"]),
  };

  switch (type) {
    case "talent":
      return {
        ...base,
        type,
        details: {
          category: asString(system["category"]),
          rank: asNumber(system["rank"]),
          skillPointCost: asNumber(system["skillPointCost"]),
          choice: asString(system["choice"]),
          rolls: asArray(system["rolls"]).filter(
            (value): value is number => typeof value === "number" && Number.isFinite(value),
          ),
          active: asBoolean(system["active"]),
          purchaseOrder: asNumber(system["purchaseOrder"]),
        },
      };
    case "connection":
      return {
        ...base,
        type,
        details: {
          connectionType: asString(system["connectionType"]),
          category: asString(system["category"]),
          quality: asString(system["quality"]),
          rank: asNumber(system["rank"]),
          identity: asString(system["identity"]),
          active: asBoolean(system["active"]),
        },
      };
    case "craft":
      return {
        ...base,
        type,
        details: {
          entitlementId: asString(system["entitlementId"]),
          baseId: asString(system["baseId"]),
          school: asString(system["school"]),
          affinityKind: asString(system["affinityKind"]),
          rank: asString(system["rank"]),
          craftType: asString(system["craftType"]),
          resource: asString(system["resource"]),
          cost: asNumber(system["cost"]),
          range: asString(system["range"]),
          duration: asString(system["duration"]),
          modifierId: asString(system["modifierId"]),
          modifierChoice: asString(system["modifierChoice"]),
          form: asString(system["form"]),
        },
      };
    case "equipment":
      return {
        ...base,
        type,
        details: {
          category: asString(system["category"]),
          quality: asString(system["quality"]),
          quantity: asNumber(system["quantity"]),
          price: asNumber(system["price"]),
          equipped: asBoolean(system["equipped"]),
          attuned: asBoolean(system["attuned"]),
          hands: asNumber(system["hands"]),
          armor: asNumber(system["armor"]),
          acquisition: asString(system["acquisition"]),
          grantingSource: asString(system["grantingSource"]),
        },
      };
    case "quartz":
    case "core": {
      const common = {
        element: asString(system["element"]),
        rank: asNumber(system["rank"]),
        socket: asNumber(system["socket"]),
        equipped: asBoolean(system["equipped"]),
        arts: asArray(system["arts"]).filter((value): value is string => typeof value === "string"),
        acquisition: asString(system["acquisition"]),
      };
      return type === "quartz"
        ? { ...base, type, details: common }
        : {
            ...base,
            type,
            details: { coreType: asString(system["coreType"]), ...common },
          };
    }
  }
}

function actorInventoryResult({ id }: TrailsActorIdInput): TrailsActorInventoryResult {
  const actor = requireVisibleTrailsActor(id) as TrailsActorRuntimeDocument;
  const items = Array.from(actor.items?.values?.() ?? []).flatMap((document) => {
    const item = inventoryItem(document as TrailsItemRuntimeDocument);
    return item ? [item] : [];
  });
  return {
    versions: liveVersions(asRecord(actor.system)["rulesVersion"]),
    actorId: actor.id,
    items,
    boundary: ACTOR_INVENTORY_BOUNDARY,
  };
}

async function loadCatalogContext(
  packs: Map<string, TrailsCatalogPack>,
): Promise<TrailsRuntimeCatalogContext> {
  const config = liveTrailsConfig();
  const configured =
    config.creation?.["loadRuntimeCatalogContext"] ?? config.builder?.["loadRuntimeCatalogContext"];
  if (typeof configured === "function") {
    return (await configured.call(undefined, { packs })) as TrailsRuntimeCatalogContext;
  }

  // The verified Trails integration API is not currently mounted on
  // CONFIG.TRAILS. Load its public browser module lazily so non-Trails worlds
  // never resolve or import a Trails-owned file merely by loading this module.
  const modulePath = `/systems/${TRAILS_SYSTEM_ID}/scripts/features/sheets/integration.mjs`;
  const integration = (await import(modulePath)) as {
    loadRuntimeCatalogContext?: LoadRuntimeCatalogContext | undefined;
  };
  if (typeof integration.loadRuntimeCatalogContext !== "function") {
    throw new TrailsCommandError(
      "TRAILS_CAPABILITY_UNAVAILABLE",
      "Trails runtime catalog loading is unavailable. Update the Trails system and reload the world.",
    );
  }
  return integration.loadRuntimeCatalogContext({ packs });
}

function visibleCatalogPacks(): Map<string, TrailsCatalogPack> {
  const runtime = runtimeGlobals().game;
  const user = runtime?.user;
  const visiblePacks = new Map<string, TrailsCatalogPack>();
  if (!user) return visiblePacks;
  for (const { id: packId } of TRAILS_CATALOG_PACKS) {
    const pack = runtime?.packs?.get(packId) as TrailsCatalogPack | undefined;
    if (pack && canObserve(pack, user)) visiblePacks.set(packId, pack);
  }
  return visiblePacks;
}

async function catalogListResult(): Promise<TrailsCatalogListResult> {
  const runtime = runtimeGlobals().game;
  const user = runtime?.user;
  const catalogs = await Promise.all(
    TRAILS_CATALOG_PACKS.map(async ({ id, label }) => {
      const pack = runtime?.packs?.get(id) as TrailsCatalogPack | undefined;
      if (!user || !pack || !canObserve(pack, user)) {
        return { packId: id, label, accessible: false, entryCount: null };
      }
      const index = await pack.getIndex();
      return { packId: id, label, accessible: true, entryCount: index.size };
    }),
  );
  return { versions: liveVersions(), catalogs };
}

const CATALOG_ITEM_TYPES: Readonly<Record<string, TrailsCatalogEntry["itemType"]>> = Object.freeze({
  vantages: "talent",
  affinities: "talent",
  talents: "talent",
  skills: "talent",
  connections: "connection",
  mentors: "connection",
  "issued-packages": "connection",
  "scoped-rulings": "connection",
  baseCrafts: "craft",
  craftModifiers: "craft",
  arts: "craft",
  craftEntitlements: "craft",
  craftComposition: "craft",
  groups: "craft",
  coreBenefits: "core",
});

function catalogItemType(
  catalog: string,
  canonical: UnknownRecord,
): TrailsCatalogEntry["itemType"] {
  if (catalog === "items") {
    if (canonical["category"] === "Quartz") return "quartz";
    if (canonical["category"] === "Core") return "core";
    return "equipment";
  }
  return CATALOG_ITEM_TYPES[catalog] ?? "equipment";
}

function safeCatalogEntry(catalog: string, value: unknown): TrailsCatalogEntry | null {
  const canonical = asRecord(cloneAndRedactTrailsData(value));
  const catalogId = asString(canonical["catalogId"] ?? canonical["id"]);
  if (!catalogId) return null;
  const data = { ...canonical };
  for (const key of ["_id", "uuid", "catalogId", "id", "name", "status", "source"]) {
    delete data[key];
  }
  if (!isJsonValue(data)) throw unsafeResponse("$ Trails catalog entry", "non-JSON data");
  return {
    catalogId,
    name: asString(canonical["name"]) || catalogId,
    catalog,
    itemType: catalogItemType(catalog, canonical),
    status: ruleStatus(asRecord(canonical["automation"])["level"] ?? canonical["status"]),
    source: safeSourceCitation(canonical["source"]) ?? {},
    data,
  };
}

async function catalogResult({ packId }: TrailsCatalogInput): Promise<TrailsCatalogResult> {
  const pack = requireAccessibleTrailsPack(packId) as TrailsCatalogDocumentsPack;
  const context = await loadCatalogContext(new Map([[packId, pack]]));
  const catalogs = asRecord(context.catalogs);
  const entries = Object.entries(catalogs)
    .filter(([catalog]) => catalog !== "coreSkills")
    .flatMap(([catalog, values]) =>
      asArray(values).flatMap((value) => {
        const entry = safeCatalogEntry(catalog, value);
        return entry ? [entry] : [];
      }),
    )
    .sort((left, right) =>
      `${left.catalog}\0${left.catalogId}`.localeCompare(
        `${right.catalog}\0${right.catalogId}`,
        "en",
      ),
    );
  const descriptor = TRAILS_CATALOG_PACKS.find(({ id }) => id === packId);
  return {
    versions: liveVersions(),
    packId,
    label: descriptor?.label ?? "",
    entries,
  };
}

const CREATION_LANES = ["identity", "training", "loadout", "orbment"] as const;

function creationDocumentSnapshot(document: TrailsItemRuntimeDocument): TrailsJsonObject {
  const snapshot = cloneAndRedactTrailsData({
    _id: document.id,
    id: document.id,
    name: document.name,
    type: document.type,
    system: document.system ?? {},
  });
  if (!isJsonValue(snapshot) || Array.isArray(snapshot) || snapshot === null) {
    throw unsafeResponse("$ Trails creation Item snapshot", "non-object JSON data");
  }
  return snapshot as unknown as TrailsJsonObject;
}

function creationActorSnapshot(actor: TrailsActorRuntimeDocument): TrailsJsonObject {
  const snapshot = cloneAndRedactTrailsData({
    _id: actor.id,
    id: actor.id,
    name: actor.name,
    type: actor.type,
    system: actor.system,
  });
  if (!isJsonValue(snapshot) || Array.isArray(snapshot) || snapshot === null) {
    throw unsafeResponse("$ Trails creation Actor snapshot", "non-object JSON data");
  }
  return snapshot as unknown as TrailsJsonObject;
}

function creationLane(id: TrailsCreationLaneId, value: unknown): TrailsCreationLaneResult {
  const redacted = asRecord(cloneAndRedactTrailsData(value));
  const issues = asArray(redacted["issues"])
    .map(safeIssue)
    .filter((issue) => issue !== null);
  const status = ruleStatus(redacted["status"]);
  const boundary = typeof redacted["boundary"] === "string" ? redacted["boundary"] : undefined;
  const findings = { ...redacted };
  delete findings["issues"];
  delete findings["status"];
  delete findings["boundary"];
  if (!isJsonValue(findings)) {
    throw unsafeResponse(`$ Trails creation ${id} findings`, "non-JSON data");
  }
  return { id, status, issues, findings, ...(boundary === undefined ? {} : { boundary }) };
}

/**
 * Keep the system-owned preview evidence intact while adding the three
 * independently-owned version fields required by the bridge contract. The
 * preview kernels return plain JSON, but fail closed if a changed runtime
 * starts returning a document, cyclic graph, or another unsafe value.
 */
function gameplayPreviewResult<TResult>(value: unknown, path: string): TResult {
  const preview = cloneAndRedactTrailsData(value);
  if (
    preview === null ||
    Array.isArray(preview) ||
    typeof preview !== "object" ||
    !isJsonValue(preview)
  ) {
    throw unsafeResponse(path, "non-object JSON data");
  }
  return { ...preview, versions: liveVersions() } as TResult;
}

function actionRollResult(input: TrailsActionRollInput): TrailsActionRollResult {
  const resolveActionRoll = requireTrailsCapability<[TrailsActionRollInput], unknown>(
    "gameplay",
    "resolveActionRoll",
  );
  // Deliberately do not pass the runtime's optional { rollDie } parameter.
  // Random evidence belongs to the active Trails runtime, never the caller.
  return gameplayPreviewResult<TrailsActionRollResult>(
    resolveActionRoll(input),
    "$ Trails action roll",
  );
}

function initiativeResult(input: TrailsInitiativeInput): TrailsInitiativeResult {
  const previewInitiative = requireTrailsCapability<
    [TrailsInitiativeInput["participants"]],
    unknown
  >("gameplay", "previewInitiative");
  // As above, omit the optional runtime RNG injection parameter. The Trails
  // kernel receives only participant inputs and owns every generated die.
  return gameplayPreviewResult<TrailsInitiativeResult>(
    previewInitiative(input.participants),
    "$ Trails initiative preview",
  );
}

function threatContestResult(input: TrailsThreatContestInput): TrailsThreatContestResult {
  const previewThreatContest = requireTrailsCapability<[TrailsThreatContestInput], unknown>(
    "gameplay",
    "previewThreatContest",
  );
  return gameplayPreviewResult<TrailsThreatContestResult>(
    previewThreatContest(input),
    "$ Trails threat contest preview",
  );
}

function damagePreviewResult(input: TrailsDamagePreviewInput): TrailsDamagePreviewResult {
  const previewPostMitigationDamage = requireTrailsCapability<[TrailsDamagePreviewInput], unknown>(
    "gameplay",
    "previewPostMitigationDamage",
  );
  // The runtime contract receives final damage. Armor, resistance, weakness,
  // and every other mitigation decision remain outside this preview.
  const preview = gameplayPreviewResult<TrailsDamagePreviewResult>(
    previewPostMitigationDamage(input),
    "$ Trails post-mitigation damage preview",
  );
  // The live kernel emits this discriminator only for the held legacy-state
  // branch. Canonicalize its absence so every bridge response satisfies the
  // shared DTO without changing the kernel's damage calculation.
  return { ...preview, transition: preview.transition ?? null };
}

function recoveryPreviewResult(input: TrailsRecoveryPreviewInput): TrailsRecoveryPreviewResult {
  const buildRecoveryPlan = requireTrailsCapability<[TrailsRecoveryPreviewInput], unknown>(
    "gameplay",
    "buildRecoveryPlan",
  );
  // Eligibility remains caller-owned evidence for all five resources, and
  // recorded dice remain caller-supplied evidence. The transport schema
  // bounds both; this handler never rolls replacements or applies operations.
  return gameplayPreviewResult<TrailsRecoveryPreviewResult>(
    buildRecoveryPlan(input),
    "$ Trails recovery preview",
  );
}

function experienceProgressResult(
  input: TrailsExperienceProgressInput,
): TrailsExperienceProgressResult {
  const experienceProgress = requireTrailsCapability<[number], unknown>(
    "gameplay",
    "experienceProgress",
  );
  // The live kernel owns the published table and its domain failure result.
  // Pass the total as a scalar and do not infer thresholds past the table.
  return gameplayPreviewResult<TrailsExperienceProgressResult>(
    experienceProgress(input.totalExperience),
    "$ Trails experience progress",
  );
}

async function creationReadinessResult({
  id,
}: TrailsActorIdInput): Promise<TrailsCreationReadinessResult> {
  const actor = requireVisibleTrailsActor(id) as TrailsActorRuntimeDocument;
  const evaluateCreation = requireTrailsCapability<
    [
      {
        actor: TrailsJsonObject;
        items: TrailsJsonObject[];
        catalogs: TrailsJsonObject;
      },
    ],
    unknown
  >("creation", "evaluateCreation");
  const context = await loadCatalogContext(visibleCatalogPacks());
  const catalogs = asRecord(cloneAndRedactTrailsData(context.catalogs ?? {}));
  if (!isJsonValue(catalogs)) {
    throw unsafeResponse("$ Trails creation catalogs", "non-JSON data");
  }
  const items = Array.from(actor.items?.values?.() ?? []).map((document) =>
    creationDocumentSnapshot(document as TrailsItemRuntimeDocument),
  );
  const evaluated = asRecord(
    cloneAndRedactTrailsData(
      evaluateCreation({ actor: creationActorSnapshot(actor), items, catalogs }),
    ),
  );
  const readiness = actorReadiness({ readiness: evaluated["readiness"] });
  const retained = asArray(asRecord(evaluated["readiness"])["retained"]);
  const explicitUnmapped = asArray(evaluated["unmapped"]);
  const unmapped = (explicitUnmapped.length > 0 ? explicitUnmapped : retained).flatMap((entry) => {
    const record = asRecord(entry);
    return typeof record["path"] === "string" &&
      typeof record["reason"] === "string" &&
      isJsonValue(record["value"])
      ? [{ path: record["path"], reason: record["reason"], value: record["value"] }]
      : [];
  });

  return {
    versions: liveVersions(asRecord(actor.system)["rulesVersion"]),
    actorId: actor.id,
    readiness,
    lanes: CREATION_LANES.map((lane) => creationLane(lane, evaluated[lane])),
    unmapped,
    boundary: CREATION_READINESS_BOUNDARY,
  };
}

const BUILDER_ITEM_TYPES = new Set<TrailsItemType>([
  "talent",
  "connection",
  "craft",
  "equipment",
  "quartz",
  "core",
]);

function builderActorPreview(value: unknown): TrailsBuilderActorPreview | null {
  const actor = asRecord(cloneAndRedactTrailsData(value));
  if (Object.keys(actor).length === 0 || actor["type"] !== "character") return null;
  const system = asRecord(actor["system"]);
  const details = asRecord(system["details"]);
  const abilities = Object.fromEntries(
    Object.entries(asRecord(system["abilities"])).map(([id, ability]) => [
      id,
      asNumber(asRecord(ability)["value"]),
    ]),
  );
  return {
    name: asString(actor["name"]),
    type: "character",
    schemaVersion: asNonnegativeInteger(system["schemaVersion"]),
    rulesVersion: asString(system["rulesVersion"]),
    concept: asString(details["concept"]),
    historyId: asString(details["history"]),
    destinyId: asString(details["destiny"]),
    elementalAffinityId: asString(details["elementalAffinity"]),
    martialAffinityId: asString(details["martialAffinity"]),
    nativeLanguage: asString(details["nativeLanguage"]),
    languages: asArray(details["languages"]).filter(
      (language): language is string => typeof language === "string",
    ),
    abilities,
  };
}

function builderItemPreview(value: unknown): TrailsBuilderItemPreview | null {
  const item = asRecord(cloneAndRedactTrailsData(value));
  const type = item["type"];
  if (typeof type !== "string" || !BUILDER_ITEM_TYPES.has(type as TrailsItemType)) return null;
  const system = asRecord(item["system"]);
  const fields = { ...system };
  for (const key of ["schemaVersion", "catalogId", "status", "source", "origin", "instanceId"]) {
    delete fields[key];
  }
  if (!isJsonValue(fields)) {
    throw unsafeResponse("$ Trails builder Item fields", "non-JSON data");
  }
  return {
    name: asString(item["name"]),
    type: type as TrailsItemType,
    catalogId: asString(system["catalogId"]),
    status: ruleStatus(system["status"]),
    source: safeSourceCitation(system["source"]) ?? {},
    fields: fields as TrailsJsonObject,
  };
}

function builderUnmapped(value: unknown): TrailsUnmappedValue | null {
  const entry = asRecord(cloneAndRedactTrailsData(value));
  return typeof entry["path"] === "string" &&
    typeof entry["reason"] === "string" &&
    isJsonValue(entry["value"])
    ? { path: entry["path"], reason: entry["reason"], value: entry["value"] }
    : null;
}

function normalizeBuilderPreview(
  value: unknown,
  validationIssues: unknown[] = [],
): TrailsBuilderPreviewResult {
  const preview = asRecord(cloneAndRedactTrailsData(value));
  const issues = [...validationIssues, ...asArray(preview["issues"])]
    .map(safeIssue)
    .filter((issue) => issue !== null);
  const actor = builderActorPreview(preview["actor"]);
  const items = asArray(preview["items"])
    .map(builderItemPreview)
    .filter((item) => item !== null);
  const unmapped = asArray(preview["unmapped"])
    .map(builderUnmapped)
    .filter((entry) => entry !== null);
  return {
    versions: liveVersions(),
    contractVersion: asNonnegativeInteger(preview["contractVersion"]),
    builderVersion: asNonnegativeInteger(preview["builderVersion"]),
    valid: actor !== null && !issues.some((issue) => issue.severity === "error"),
    actor,
    items,
    issues,
    unmapped,
    boundary: BUILDER_PREVIEW_BOUNDARY,
  };
}

async function builderPreviewResult({
  raw,
}: TrailsBuilderPreviewInput): Promise<TrailsBuilderPreviewResult> {
  const parseBuilderV1 = requireTrailsCapability<[string], unknown>("creation", "parseBuilderV1");
  const validateBuilderV1 = requireTrailsCapability<[unknown], unknown>(
    "creation",
    "validateBuilderV1",
  );
  const previewBuilderV1 = requireTrailsCapability<[unknown, UnknownRecord], unknown>(
    "creation",
    "previewBuilderV1",
  );
  const context = await loadCatalogContext(visibleCatalogPacks());
  const catalogs = asRecord(context.catalogs);

  let draft: unknown;
  try {
    draft = parseBuilderV1(raw);
  } catch {
    // The live preview kernel converts malformed JSON, unsupported drafts,
    // and byte-limit failures into stable public issues. It receives the raw
    // text here because there is no parsed draft that can be validated.
    return normalizeBuilderPreview(previewBuilderV1(raw, catalogs));
  }

  const validation = validateBuilderV1(draft);
  const validationIssues = Array.isArray(validation) ? validation : [];
  return normalizeBuilderPreview(previewBuilderV1(draft, catalogs), validationIssues);
}

registerCommand(TRAILS_COMMANDS.CONFIG, (): TrailsConfigResult => {
  try {
    return configResult();
  } catch (error) {
    throw toActionableTrailsError(error, "read configuration");
  }
});

registerCommand(
  TRAILS_COMMANDS.ACTOR_SHEET,
  (input: TrailsActorIdInput): TrailsActorSheetResult => {
    try {
      return actorSheetResult(input);
    } catch (error) {
      throw toActionableTrailsError(error, "read the actor sheet");
    }
  },
);

registerCommand(
  TRAILS_COMMANDS.ACTOR_INVENTORY,
  (input: TrailsActorIdInput): TrailsActorInventoryResult => {
    try {
      return actorInventoryResult(input);
    } catch (error) {
      throw toActionableTrailsError(error, "read actor inventory");
    }
  },
);

registerCommand(TRAILS_COMMANDS.LIST_CATALOGS, async (): Promise<TrailsCatalogListResult> => {
  try {
    return await catalogListResult();
  } catch (error) {
    throw toActionableTrailsError(error, "list catalogs");
  }
});

registerCommand(
  TRAILS_COMMANDS.GET_CATALOG,
  async (input: TrailsCatalogInput): Promise<TrailsCatalogResult> => {
    try {
      return await catalogResult(input);
    } catch (error) {
      throw toActionableTrailsError(error, "read a catalog");
    }
  },
);

registerCommand(
  TRAILS_COMMANDS.EVALUATE_CREATION,
  async (input: TrailsActorIdInput): Promise<TrailsCreationReadinessResult> => {
    try {
      return await creationReadinessResult(input);
    } catch (error) {
      throw toActionableTrailsError(error, "evaluate creation readiness");
    }
  },
);

registerCommand(
  TRAILS_COMMANDS.ROLL_ACTION,
  (input: TrailsActionRollInput): TrailsActionRollResult => {
    try {
      return actionRollResult(input);
    } catch (error) {
      throw toActionableTrailsError(error, "resolve an action roll");
    }
  },
);

registerCommand(
  TRAILS_COMMANDS.PREVIEW_INITIATIVE,
  (input: TrailsInitiativeInput): TrailsInitiativeResult => {
    try {
      return initiativeResult(input);
    } catch (error) {
      throw toActionableTrailsError(error, "preview initiative");
    }
  },
);

registerCommand(
  TRAILS_COMMANDS.PREVIEW_THREAT_CONTEST,
  (input: TrailsThreatContestInput): TrailsThreatContestResult => {
    try {
      return threatContestResult(input);
    } catch (error) {
      throw toActionableTrailsError(error, "preview a threat contest");
    }
  },
);

registerCommand(
  TRAILS_COMMANDS.PREVIEW_DAMAGE,
  (input: TrailsDamagePreviewInput): TrailsDamagePreviewResult => {
    try {
      return damagePreviewResult(input);
    } catch (error) {
      throw toActionableTrailsError(error, "preview post-mitigation damage");
    }
  },
);

registerCommand(
  TRAILS_COMMANDS.PREVIEW_RECOVERY,
  (input: TrailsRecoveryPreviewInput): TrailsRecoveryPreviewResult => {
    try {
      return recoveryPreviewResult(input);
    } catch (error) {
      throw toActionableTrailsError(error, "preview recovery");
    }
  },
);

registerCommand(
  TRAILS_COMMANDS.EXPERIENCE_PROGRESS,
  (input: TrailsExperienceProgressInput): TrailsExperienceProgressResult => {
    try {
      return experienceProgressResult(input);
    } catch (error) {
      throw toActionableTrailsError(error, "calculate experience progress");
    }
  },
);

registerCommand(
  TRAILS_COMMANDS.PREVIEW_BUILDER,
  async (input: TrailsBuilderPreviewInput): Promise<TrailsBuilderPreviewResult> => {
    try {
      return await builderPreviewResult(input);
    } catch (error) {
      throw toActionableTrailsError(error, "preview builder JSON");
    }
  },
);
