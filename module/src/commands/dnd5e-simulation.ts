import {
  DND5E_SIMULATION_COMMANDS,
  ProtocolError,
  rollFormula,
  type Dnd5eSimulationAction,
  type Dnd5eSimulationInput,
  type Dnd5eSimulationResult,
  type ProjectedDiff,
} from "@foundry-local-api/shared";
import { registerCommand } from "../command-registry.js";

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as object)
      .sort()
      .map((key) => `${key}:${stable((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stable(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

type PermissionDocument = FoundryDocument & {
  testUserPermission?: (user: FoundryUser, permission: string) => boolean;
};

function assertPermission(
  document: FoundryDocument,
  permission: "OBSERVER" | "OWNER",
  fieldPath: string,
): void {
  if (game.user.isGM) return;
  const test = (document as PermissionDocument).testUserPermission;
  let allowed = false;
  try {
    allowed = typeof test === "function" && test.call(document, game.user, permission) === true;
  } catch {
    allowed = false;
  }
  if (!allowed)
    throw new ProtocolError({
      code: "PERMISSION_DENIED",
      message: `The executing user lacks ${permission} permission for the simulation document.`,
      retryable: false,
      fieldPath,
    });
}

function genuineRevision(source: Record<string, unknown>, fieldPath: string): string {
  const stats = source["_stats"];
  const value =
    stats && typeof stats === "object"
      ? (stats as Record<string, unknown>)["modifiedTime"]
      : undefined;
  if ((typeof value !== "number" && typeof value !== "string") || String(value).length === 0)
    throw new ProtocolError({
      code: "INCOMPLETE_RESULT",
      message: "A genuine Foundry document revision is required for simulation.",
      retryable: false,
      fieldPath,
    });
  return String(value);
}

function documentCollectionSnapshot(name: string): Array<{ id: string; source: unknown }> {
  const collection = game.collections.get(name);
  if (!collection) return [];
  return [...collection.values()]
    .filter((value): value is FoundryDocument =>
      Boolean(
        value &&
        typeof value === "object" &&
        typeof (value as FoundryDocument).toObject === "function",
      ),
    )
    .map((document) => ({ id: document.id, source: document.toObject() }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function embeddedSnapshot(
  documents: Iterable<FoundryDocument>,
): Array<{ id: string; source: Record<string, unknown> }> {
  return [...documents]
    .map((document) => ({ id: document.id, source: document.toObject() }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

/** Captures all mutable families whose dnd5e workflows can touch as side effects. */
interface PersistenceSnapshot {
  Actor: unknown;
  Item: unknown;
  ActiveEffect: unknown;
  Token: unknown;
  Combat: unknown;
  ChatMessage: unknown;
  Resource: unknown;
}

function resourceSnapshot(actors: Array<{ id: string; source: Record<string, unknown> }>): unknown {
  return actors.map(({ id, source }) => ({
    id,
    hp: get(source, "system.attributes.hp"),
    hd: get(source, "system.attributes.hd"),
    resources: get(source, "system.resources"),
    spells: get(source, "system.spells"),
  }));
}

function persistenceSnapshot(): PersistenceSnapshot {
  const actors = [
    ...((game.collections.get("Actor") as Map<string, FoundryActor> | undefined)?.values() ?? []),
  ]
    .map((actor) => ({
      id: actor.id,
      source: actor.toObject(),
      items: embeddedSnapshot(actor.items.values()),
      effects: embeddedSnapshot(actor.effects.values()),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const sceneTokens: Array<{ sceneId: string; tokens: unknown }> = [];
  for (const scene of game.collections.get("Scene")?.values() ?? []) {
    const candidate = scene as FoundryDocument & {
      getEmbeddedCollection?: (type: string) => Map<string, FoundryDocument>;
    };
    if (typeof candidate.getEmbeddedCollection === "function") {
      sceneTokens.push({
        sceneId: candidate.id,
        tokens: embeddedSnapshot(candidate.getEmbeddedCollection("Token").values()),
      });
    }
  }
  sceneTokens.sort((left, right) => left.sceneId.localeCompare(right.sceneId));
  const actorSources = actors.map(({ id, source }) => ({ id, source }));
  return {
    Actor: actorSources,
    Item: {
      embedded: actors.map(({ id, items }) => ({ actorId: id, items })),
      world: documentCollectionSnapshot("Item"),
    },
    ActiveEffect: {
      embedded: actors.map(({ id, effects }) => ({ actorId: id, effects })),
      world: documentCollectionSnapshot("ActiveEffect"),
    },
    Token: { world: documentCollectionSnapshot("Token"), scenes: sceneTokens },
    Combat: documentCollectionSnapshot("Combat"),
    ChatMessage: documentCollectionSnapshot("ChatMessage"),
    Resource: resourceSnapshot(actorSources),
  };
}

function get(root: Record<string, unknown>, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (value, key) =>
        value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined,
      root,
    );
}

function actorById(id: string, fieldPath: string): FoundryActor {
  const actor = (game.collections.get("Actor") as Map<string, FoundryActor> | undefined)?.get(id);
  if (!actor)
    throw new ProtocolError({
      code: "NOT_FOUND",
      message: `Actor "${id}" not found.`,
      retryable: false,
      fieldPath,
    });
  return actor;
}

function itemById(actor: FoundryActor, id: string | undefined): FoundryDocument | undefined {
  if (!id) return undefined;
  const item = actor.items.get(id);
  if (!item)
    throw new ProtocolError({
      code: "NOT_FOUND",
      message: `Item "${id}" was not found on Actor "${actor.id}".`,
      retryable: false,
      fieldPath: "action.itemId",
    });
  return item;
}

interface ItemActivity {
  id: string;
  source: Record<string, unknown>;
}

function itemActivities(system: Record<string, unknown>): ItemActivity[] {
  const activities = system["activities"];
  if (!activities || typeof activities !== "object") return [];
  return Object.entries(activities as Record<string, unknown>)
    .filter((entry): entry is [string, Record<string, unknown>] =>
      Boolean(entry[1] && typeof entry[1] === "object"),
    )
    .map(([key, source]) => ({
      id: typeof source["_id"] === "string" ? source["_id"] : key,
      source,
    }));
}

function compatibleActivity(
  system: Record<string, unknown>,
  purpose: "attack" | "damage",
  activityId?: string,
): ItemActivity | undefined {
  const activities = itemActivities(system);
  if (activities.length === 0) return undefined;
  const compatible = activities.filter(({ source: activity }) => {
    const type = activity["type"];
    if (purpose === "attack")
      return type === "attack" || (type === undefined && typeof activity["attack"] === "object");
    return (
      (type === "attack" || type === "damage" || type === undefined) &&
      typeof activity["damage"] === "object"
    );
  });
  if (activityId) {
    const selected = compatible.find((activity) => activity.id === activityId);
    if (!selected)
      throw new ProtocolError({
        code: "NOT_FOUND",
        message: `The Item has no supported ${purpose} activity "${activityId}".`,
        retryable: false,
        fieldPath: "action.activityId",
      });
    return selected;
  }
  if (compatible.length !== 1)
    throw new ProtocolError({
      code: "UNSUPPORTED_TYPE",
      message:
        compatible.length === 0
          ? `The Item has no supported ${purpose} activity.`
          : `The Item has multiple ${purpose} activities; activityId is required.`,
      retryable: false,
      fieldPath: "action.itemId",
    });
  return compatible[0];
}

function itemAttackBonus(
  item: FoundryDocument | undefined,
  activityId?: string,
): { value?: number; activityId?: string } {
  if (!item) return {};
  const source = item.toObject();
  const system = (source["system"] ?? {}) as Record<string, unknown>;
  const activity = compatibleActivity(system, "attack", activityId);
  const candidates = [
    system["attackBonus"],
    activity?.source["attackBonus"],
    activity && typeof activity.source["attack"] === "object"
      ? (activity.source["attack"] as Record<string, unknown>)["bonus"]
      : undefined,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (candidate !== undefined && Number.isFinite(value))
      return { value, ...(activity ? { activityId: activity.id } : {}) };
  }
  return { ...(activity ? { activityId: activity.id } : {}) };
}

function damagePart(value: unknown): { formula: string; damageType?: string } | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (value.length !== 1)
    throw new ProtocolError({
      code: "UNSUPPORTED_TYPE",
      message:
        "The Item has multiple damage parts, but the bounded result cannot safely project their independent types and rules.",
      retryable: false,
      fieldPath: "action.itemId",
    });
  const first = value[0];
  if (Array.isArray(first) && typeof first[0] === "string")
    return {
      formula: first[0],
      ...(typeof first[1] === "string" ? { damageType: first[1] } : {}),
    };
  if (first && typeof first === "object") {
    const part = first as Record<string, unknown>;
    if (
      Array.isArray(part["types"]) &&
      (part["types"].length !== 1 || typeof part["types"][0] !== "string")
    )
      throw new ProtocolError({
        code: "UNSUPPORTED_TYPE",
        message: "The Item damage part has an ambiguous or unsupported damage type set.",
        retryable: false,
        fieldPath: "action.itemId",
      });
    if (typeof part["formula"] === "string")
      return {
        formula: part["formula"],
        ...(typeof part["types"] === "string"
          ? { damageType: part["types"] }
          : Array.isArray(part["types"]) &&
              part["types"].length === 1 &&
              typeof part["types"][0] === "string"
            ? { damageType: part["types"][0] }
            : {}),
      };
    const number = Number(part["number"]);
    const denomination = Number(part["denomination"]);
    if (
      Number.isInteger(number) &&
      number > 0 &&
      Number.isInteger(denomination) &&
      denomination >= 2
    ) {
      const bonus =
        typeof part["bonus"] === "string" && part["bonus"].trim().length > 0
          ? part["bonus"].trim()
          : "";
      const formula = `${number}d${denomination}${bonus ? (bonus.startsWith("-") ? bonus : `+${bonus}`) : ""}`;
      const types = part["types"];
      return {
        formula,
        ...(typeof types === "string"
          ? { damageType: types }
          : Array.isArray(types) && types.length === 1 && typeof types[0] === "string"
            ? { damageType: types[0] }
            : {}),
      };
    }
  }
  return undefined;
}

function itemDamage(
  item: FoundryDocument | undefined,
  activityId?: string,
): { formula: string; damageType?: string; activityId?: string } | undefined {
  if (!item) return undefined;
  const source = item.toObject();
  const system = (source["system"] ?? {}) as Record<string, unknown>;
  const activities = itemActivities(system);
  if (activities.length > 0) {
    const activity = compatibleActivity(system, "damage", activityId)!;
    const damage = activity.source["damage"];
    const part =
      damage && typeof damage === "object"
        ? damagePart((damage as Record<string, unknown>)["parts"])
        : undefined;
    return part ? { ...part, activityId: activity.id } : undefined;
  }
  const direct = system["damage"];
  const directParts =
    direct && typeof direct === "object"
      ? damagePart((direct as Record<string, unknown>)["parts"])
      : undefined;
  if (directParts) return directParts;
  return undefined;
}

function resolveFormula(
  formula: string,
  actorSource: Record<string, unknown>,
  itemSource: Record<string, unknown> | undefined,
): string {
  const itemSystem = (itemSource?.["system"] ?? {}) as Record<string, unknown>;
  const ability = typeof itemSystem["ability"] === "string" ? itemSystem["ability"] : undefined;
  const modifier = ability
    ? Number(get(actorSource, `system.abilities.${ability}.mod`))
    : Number.NaN;
  const proficiency = Number(get(actorSource, "system.attributes.prof"));
  let resolved = formula;
  if (resolved.includes("@mod")) {
    if (!Number.isFinite(modifier))
      throw new ProtocolError({
        code: "UNSUPPORTED_TYPE",
        message:
          "The Item formula uses @mod but its bounded Actor ability modifier cannot be resolved.",
        retryable: false,
        fieldPath: "action.itemId",
      });
    resolved = resolved.replaceAll("@mod", String(modifier));
  }
  if (resolved.includes("@prof")) {
    if (!Number.isFinite(proficiency))
      throw new ProtocolError({
        code: "UNSUPPORTED_TYPE",
        message: "The Item formula uses @prof but Actor proficiency cannot be resolved.",
        retryable: false,
        fieldPath: "action.itemId",
      });
    resolved = resolved.replaceAll("@prof", String(proficiency));
  }
  if (resolved.includes("@"))
    throw new ProtocolError({
      code: "UNSUPPORTED_TYPE",
      message: "The Item formula contains an unsupported dnd5e data substitution.",
      retryable: false,
      fieldPath: "action.itemId",
    });
  return resolved;
}

function resourcePathAllowed(path: string): boolean {
  return /^system\.(resources\.(primary|secondary|tertiary)\.value|attributes\.(hp|hd)\.value|spells\.(spell[1-9]|pact)\.value)$/.test(
    path,
  );
}

function simulateRoll(formula: string, seed: number, supplied?: number[]) {
  try {
    return rollFormula(formula, seed, supplied);
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError({
      code: "INVALID_PAYLOAD",
      message: error instanceof Error ? error.message : "Unsupported bounded dice formula.",
      retryable: false,
      fieldPath: "action",
    });
  }
}

function effectCount(...actors: Array<FoundryActor | undefined>): number {
  return actors.reduce((total, actor, index) => {
    if (!actor || actors.indexOf(actor) !== index) return total;
    return total + (actor.effects?.size ?? 0);
  }, 0);
}

function damageTraits(source: Record<string, unknown>, trait: "di" | "dr" | "dv"): string[] {
  const value = get(source, `system.traits.${trait}.value`);
  const custom = get(source, `system.traits.${trait}.custom`);
  if (typeof custom === "string" && custom.trim().length > 0)
    throw new ProtocolError({
      code: "UNSUPPORTED_TYPE",
      message: "Custom dnd5e damage traits cannot be projected deterministically.",
      retryable: false,
      fieldPath: "action.damageType",
    });
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    throw new ProtocolError({
      code: "UNSUPPORTED_TYPE",
      message: "The dnd5e damage trait representation is unsupported.",
      retryable: false,
      fieldPath: "action.damageType",
    });
  return value;
}

function applyDamageRules(
  amount: number,
  damageType: string | undefined,
  targetSource: Record<string, unknown>,
): number {
  if (!damageType) return amount;
  const immune = damageTraits(targetSource, "di").includes(damageType);
  const resistant = damageTraits(targetSource, "dr").includes(damageType);
  const vulnerable = damageTraits(targetSource, "dv").includes(damageType);
  if (immune) return 0;
  let applied = amount;
  if (resistant) applied = Math.floor(applied / 2);
  if (vulnerable) applied *= 2;
  return applied;
}

function criticalDamageFormula(formula: string): string {
  const match = /^(\d{1,2})d(\d{1,4})([+-]\d+)?$/.exec(formula.replace(/\s/g, ""));
  if (!match)
    throw new ProtocolError({
      code: "UNSUPPORTED_TYPE",
      message: "Critical damage requires a bounded simple dice formula.",
      retryable: false,
      fieldPath: "action.itemId",
    });
  return `${Number(match[1]) * 2}d${match[2]}${match[3] ?? ""}`;
}

type RevisionKind = Dnd5eSimulationInput["expectedRevisions"][number]["kind"];
type SimulationStep = Dnd5eSimulationResult["steps"][number];

interface ReferencedDocument {
  kind: RevisionKind;
  id: string;
  document: FoundryDocument;
  source: Record<string, unknown>;
  fieldPath: string;
}

interface VirtualState {
  actors: Map<string, Record<string, unknown>>;
  effects: Map<string, { disabled: boolean }>;
  combat: Record<string, unknown> | null;
}

interface StepProjection {
  rolls: number[];
  total?: number;
  success?: boolean;
  diffs: ProjectedDiff[];
  warnings: string[];
  context: Dnd5eSimulationResult["resolvedContext"];
}

function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    const child = cursor[part];
    if (!child || typeof child !== "object" || Array.isArray(child)) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts.at(-1)!] = value;
}

function requiredExpectedRevision(
  input: Dnd5eSimulationInput,
  referenced: ReferencedDocument,
): void {
  const matches = input.expectedRevisions.filter(
    (entry) => entry.kind === referenced.kind && entry.id === referenced.id,
  );
  if (matches.length !== 1) {
    throw new ProtocolError({
      code: "INVALID_PAYLOAD",
      message: `Exactly one expected revision is required for ${referenced.kind} "${referenced.id}".`,
      retryable: false,
      fieldPath: "expectedRevisions",
    });
  }
  const actual = genuineRevision(referenced.source, referenced.fieldPath);
  if (matches[0]!.revision !== actual) {
    throw new ProtocolError({
      code: "STALE_REVISION",
      message: `The referenced ${referenced.kind} changed before simulation.`,
      retryable: true,
      fieldPath: "expectedRevisions",
      details: { kind: referenced.kind, id: referenced.id, expected: matches[0]!.revision, actual },
    });
  }
}

function sceneToken(sceneId: string, tokenId: string): FoundryDocument {
  const scene = game.collections.get("Scene")?.get(sceneId) as
    | (FoundryDocument & { getEmbeddedCollection?: (type: string) => Map<string, FoundryDocument> })
    | undefined;
  const token = scene?.getEmbeddedCollection?.("Token").get(tokenId);
  if (!scene || !token)
    throw new ProtocolError({
      code: "NOT_FOUND",
      message: `Token "${tokenId}" was not found on Scene "${sceneId}".`,
      retryable: false,
      fieldPath: "tokenId",
    });
  return token;
}

function actionList(input: Dnd5eSimulationInput): Dnd5eSimulationAction[] {
  if (input.noPersist !== true)
    throw new ProtocolError({
      code: "INVALID_PAYLOAD",
      message: "Simulation requires the explicit noPersist:true safety boundary.",
      retryable: false,
      fieldPath: "noPersist",
    });
  const hasAction = input.action !== undefined;
  const hasActions = input.actions !== undefined;
  if (hasAction === hasActions || (input.actions?.length ?? 1) < 1)
    throw new ProtocolError({
      code: "INVALID_PAYLOAD",
      message: "Provide exactly one action or one non-empty actions sequence.",
      retryable: false,
      fieldPath: hasAction ? "actions" : "action",
    });
  return hasAction ? [input.action!] : [...input.actions!];
}

function errorCode(error: unknown): string {
  return error instanceof ProtocolError ? error.code : "HANDLER_ERROR";
}

export async function simulateDnd5eAction(
  input: Dnd5eSimulationInput,
): Promise<Dnd5eSimulationResult> {
  if (game.system.id !== "dnd5e" || game.system.version !== input.expectedSystemVersion)
    throw new ProtocolError({
      code: "UNSUPPORTED_VERSION",
      message: "Deterministic simulation requires the exact active dnd5e version.",
      retryable: false,
      fieldPath: "expectedSystemVersion",
      details: { actual: game.system.version },
    });
  if (game.user.id !== input.effectiveUserId)
    throw new ProtocolError({
      code: "PERMISSION_DENIED",
      message: "The executing client does not match the assumed simulation user.",
      retryable: false,
      fieldPath: "effectiveUserId",
    });

  const actions = actionList(input);
  const actor = actorById(input.actorId, "actorId");
  assertPermission(actor, "OWNER", "actorId");
  const actorBefore = actor.toObject();

  const targetIds = new Set<string>();
  if (input.targetActorId) targetIds.add(input.targetActorId);
  for (const action of actions)
    if (action.kind === "effect" && action.targetActorId) targetIds.add(action.targetActorId);
  const targets = new Map<string, FoundryActor>();
  for (const id of targetIds) {
    const target = actorById(id, "targetActorId");
    if (target !== actor) assertPermission(target, "OBSERVER", "targetActorId");
    targets.set(id, target);
  }

  const items = new Map<string, FoundryDocument>();
  for (const action of actions) {
    const itemId = "itemId" in action ? action.itemId : undefined;
    if (itemId && !items.has(itemId)) {
      const item = itemById(actor, itemId)!;
      assertPermission(item, "OBSERVER", "action.itemId");
      items.set(itemId, item);
    }
  }

  let token: FoundryDocument | undefined;
  if (input.tokenId || input.sceneId) {
    if (!input.tokenId || !input.sceneId)
      throw new ProtocolError({
        code: "INVALID_PAYLOAD",
        message: "sceneId and tokenId must be supplied together.",
        retryable: false,
        fieldPath: input.sceneId ? "tokenId" : "sceneId",
      });
    token = sceneToken(input.sceneId, input.tokenId);
    assertPermission(token, "OBSERVER", "tokenId");
    const tokenActorId = token.toObject()["actorId"];
    if (typeof tokenActorId === "string" && tokenActorId !== actor.id)
      throw new ProtocolError({
        code: "INVALID_PAYLOAD",
        message: "The referenced Token is not bound to the simulated Actor.",
        retryable: false,
        fieldPath: "tokenId",
      });
  }

  let combat: FoundryDocument | undefined;
  if (actions.some((action) => action.kind === "combat")) {
    if (!input.combatId)
      throw new ProtocolError({
        code: "INVALID_PAYLOAD",
        message: "combatId is required for combat transitions.",
        retryable: false,
        fieldPath: "combatId",
      });
  }
  if (input.combatId) {
    combat = game.collections.get("Combat")?.get(input.combatId) as FoundryDocument | undefined;
    if (!combat)
      throw new ProtocolError({
        code: "NOT_FOUND",
        message: `Combat "${input.combatId}" not found.`,
        retryable: false,
        fieldPath: "combatId",
      });
    assertPermission(combat, "OBSERVER", "combatId");
  }

  const referenced: ReferencedDocument[] = [
    { kind: "actor", id: actor.id, document: actor, source: actorBefore, fieldPath: "actorId" },
    ...[...targets.values()]
      .filter((target) => target !== actor)
      .map((target) => ({
        kind: "target" as const,
        id: target.id,
        document: target,
        source: target.toObject(),
        fieldPath: "targetActorId",
      })),
    ...[...items.values()].map((item) => ({
      kind: "item" as const,
      id: item.id,
      document: item,
      source: item.toObject(),
      fieldPath: "action.itemId",
    })),
    ...(token
      ? [
          {
            kind: "token" as const,
            id: token.id,
            document: token,
            source: token.toObject(),
            fieldPath: "tokenId",
          },
        ]
      : []),
    ...(combat
      ? [
          {
            kind: "combat" as const,
            id: combat.id,
            document: combat,
            source: combat.toObject(),
            fieldPath: "combatId",
          },
        ]
      : []),
  ];
  for (const document of referenced) requiredExpectedRevision(input, document);
  const referencedKeys = new Set(referenced.map((entry) => `${entry.kind}:${entry.id}`));
  const unexpectedRevision = input.expectedRevisions.find(
    (entry) => !referencedKeys.has(`${entry.kind}:${entry.id}`),
  );
  if (unexpectedRevision)
    throw new ProtocolError({
      code: "INVALID_PAYLOAD",
      message: `Expected revision ${unexpectedRevision.kind} "${unexpectedRevision.id}" is not referenced by this simulation.`,
      retryable: false,
      fieldPath: "expectedRevisions",
    });

  const persistenceBefore = persistenceSnapshot();
  const beforeCounts = {
    chat: game.collections.get("ChatMessage")?.size ?? 0,
    combat: game.collections.get("Combat")?.size ?? 0,
    effects: effectCount(actor, ...targets.values()),
  };
  const seed = input.seed ?? 1;
  let state: VirtualState = {
    actors: new Map([[actor.id, structuredClone(actorBefore)]]),
    effects: new Map(),
    combat: combat ? structuredClone(combat.toObject()) : null,
  };
  for (const target of targets.values())
    state.actors.set(target.id, structuredClone(target.toObject()));
  for (const owner of [actor, ...targets.values()])
    for (const effect of owner.effects.values())
      state.effects.set(`${owner.id}:${effect.id}`, {
        disabled: effect.toObject()["disabled"] === true,
      });

  const projectStep = (
    action: Dnd5eSimulationAction,
    index: number,
    draft: VirtualState,
    rollCursor: { offset: number; consumed: number[] },
  ): StepProjection => {
    const stepSeed = (seed + index * 1_000) >>> 0;
    const warnings: string[] = [];
    const diffs: ProjectedDiff[] = [];
    const rolls: number[] = [];
    const context: StepProjection["context"] = {};
    let total: number | undefined;
    let success: boolean | undefined;
    const roll = (formula: string, rollSeed: number) => {
      const result = simulateRoll(formula, rollSeed, input.suppliedRolls?.slice(rollCursor.offset));
      rollCursor.offset += result.rolls.length;
      rollCursor.consumed.push(...result.rolls);
      return result;
    };
    const actorSource = draft.actors.get(actor.id)!;
    const targetId =
      action.kind === "effect"
        ? (action.targetActorId ?? input.targetActorId)
        : input.targetActorId;
    const target = targetId ? targets.get(targetId) : undefined;
    const targetSource = target ? draft.actors.get(target.id)! : undefined;
    const item = "itemId" in action && action.itemId ? items.get(action.itemId) : undefined;
    const itemSource = item?.toObject();
    if (item) context.itemId = item.id;
    if (target) context.targetActorId = target.id;
    const d20 = () => {
      const rolled = roll("1d20", stepSeed);
      rolls.push(...rolled.rolls);
      return rolled.total;
    };
    const actorValue = (owner: FoundryActor, path: string) =>
      get(draft.actors.get(owner.id)!, path);
    const changeActor = (owner: FoundryActor, path: string, after: unknown) => {
      const source = draft.actors.get(owner.id)!;
      const before = get(source, path);
      diffs.push({ path: `actors.${owner.id}.${path}`, before, after });
      setPath(source, path, after);
    };

    if (action.kind === "attack") {
      const attack = itemAttackBonus(item, action.activityId);
      const modifier = attack.value ?? action.modifier;
      if (attack.activityId) context.activityId = attack.activityId;
      const targetAC = targetSource
        ? Number(get(targetSource, "system.attributes.ac.value"))
        : action.targetAC;
      if (!Number.isFinite(modifier) || !Number.isFinite(targetAC))
        throw new ProtocolError({
          code: "INVALID_PAYLOAD",
          message: "Attack requires a resolvable activity bonus and target AC.",
          retryable: false,
          fieldPath: `actions.${index}`,
        });
      if (!item)
        warnings.push("Attack uses a caller-supplied modifier instead of an Item activity.");
      else
        warnings.push(
          "Item activity consumption, ammunition, and spell-slot costs are not projected.",
        );
      if (!target) warnings.push("Attack has no target Actor, so damage cannot be projected.");
      context.modifier = modifier!;
      context.targetAC = targetAC!;
      total = d20() + modifier!;
      const natural = rolls[0]!;
      success = natural === 20 || (natural !== 1 && total >= targetAC!);
      const resolvedDamage = itemDamage(item, action.activityId);
      const rawDamage = resolvedDamage?.formula ?? action.damage;
      if (rawDamage) {
        const formula = resolveFormula(rawDamage, actorSource, itemSource);
        context.damageFormula = formula;
        if (resolvedDamage?.damageType) context.damageType = resolvedDamage.damageType;
        if (success && target && targetSource) {
          const damage = roll(
            natural === 20 ? criticalDamageFormula(formula) : formula,
            stepSeed + 1,
          );
          rolls.push(...damage.rolls);
          const hp = Number(actorValue(target, "system.attributes.hp.value") ?? 0);
          const applied = applyDamageRules(damage.total, resolvedDamage?.damageType, targetSource);
          changeActor(target, "system.attributes.hp.value", Math.max(0, hp - applied));
        }
      } else warnings.push("The attack activity has no bounded damage formula.");
    } else if (action.kind === "save") {
      const ability = action.ability
        ? Number(get(actorSource, `system.abilities.${action.ability}.save`))
        : undefined;
      const skill = action.skill
        ? Number(get(actorSource, `system.skills.${action.skill}.total`))
        : undefined;
      const modifier = Number.isFinite(skill)
        ? skill
        : Number.isFinite(ability)
          ? ability
          : action.modifier;
      if (!Number.isFinite(modifier))
        throw new ProtocolError({
          code: "INVALID_PAYLOAD",
          message: "Save requires a resolvable ability, skill, or modifier.",
          retryable: false,
          fieldPath: `actions.${index}`,
        });
      if (!action.ability && !action.skill)
        warnings.push("Save uses a caller-supplied modifier instead of Actor data.");
      context.modifier = modifier!;
      total = d20() + modifier!;
      success = total >= action.dc;
      warnings.push(
        "Save/check projection omits advantage, disadvantage, situational bonuses, roll modes, effects, and dnd5e workflow hooks.",
      );
    } else if (action.kind === "damage") {
      const recipient = target ?? actor;
      const recipientSource = draft.actors.get(recipient.id)!;
      const resolved = itemDamage(item, action.activityId);
      if (resolved?.activityId) context.activityId = resolved.activityId;
      const raw = resolved?.formula ?? action.formula;
      const formula = raw ? resolveFormula(raw, actorSource, itemSource) : undefined;
      let amount = action.amount;
      if (formula) {
        const rolled = roll(formula, stepSeed);
        rolls.push(...rolled.rolls);
        total = rolled.total;
        amount = rolled.total;
        context.damageFormula = formula;
      }
      if (amount === undefined)
        throw new ProtocolError({
          code: "INVALID_PAYLOAD",
          message: "Damage requires an Item activity, amount, or formula.",
          retryable: false,
          fieldPath: `actions.${index}`,
        });
      const damageType = resolved?.damageType ?? action.damageType;
      if (damageType) context.damageType = damageType;
      if (!item) warnings.push("Damage uses caller-supplied values instead of an Item activity.");
      const applied = applyDamageRules(amount, damageType, recipientSource);
      const hp = Number(actorValue(recipient, "system.attributes.hp.value") ?? 0);
      changeActor(recipient, "system.attributes.hp.value", Math.max(0, hp - applied));
      warnings.push(
        "Damage projection omits temporary HP, healing, rounding variants, effects, and dnd5e workflow hooks.",
      );
    } else if (action.kind === "effect") {
      const recipient = target ?? actor;
      const key = `${recipient.id}:${action.effectId}`;
      const effect = draft.effects.get(key);
      if (!effect)
        throw new ProtocolError({
          code: "NOT_FOUND",
          message: `ActiveEffect "${action.effectId}" was not found on Actor "${recipient.id}".`,
          retryable: false,
          fieldPath: `actions.${index}.effectId`,
        });
      diffs.push({
        path: `actors.${recipient.id}.effects.${action.effectId}.disabled`,
        before: effect.disabled,
        after: !action.active,
      });
      draft.effects.set(key, { disabled: !action.active });
      warnings.push(
        "Effect changes, durations, statuses, and system automation are represented only as activation intent.",
      );
    } else if (action.kind === "resource") {
      if (!resourcePathAllowed(action.path))
        throw new ProtocolError({
          code: "INVALID_PAYLOAD",
          message: "Resource path is outside the bounded dnd5e allowlist.",
          retryable: false,
          fieldPath: `actions.${index}.path`,
        });
      const current = Number(get(actorSource, action.path));
      if (!Number.isFinite(current))
        throw new ProtocolError({
          code: "INVALID_PAYLOAD",
          message: "Resource path does not resolve to a numeric value.",
          retryable: false,
          fieldPath: `actions.${index}.path`,
        });
      const next = Math.min(
        action.max ?? Infinity,
        Math.max(action.min ?? -Infinity, current + action.delta),
      );
      changeActor(actor, action.path, next);
      warnings.push(
        "Resource projection updates one numeric path only; item uses, ammunition, spell preparation, and linked consumption remain unmodeled.",
      );
    } else if (action.kind === "rest") {
      const hp = Number(get(actorSource, "system.attributes.hp.value") ?? 0);
      const max = Number(get(actorSource, "system.attributes.hp.max") ?? hp);
      if (action.restType === "long") changeActor(actor, "system.attributes.hp.value", max);
      else
        warnings.push(
          "Short-rest hit-die spending and feature choices are not projected without explicit choices.",
        );
      if (action.restType === "long")
        warnings.push("Long-rest Item recharge and class-specific recovery remain partial.");
    } else {
      if (!draft.combat || !combat)
        throw new ProtocolError({
          code: "INVALID_PAYLOAD",
          message: "Combat transition requires a referenced Combat.",
          retryable: false,
          fieldPath: "combatId",
        });
      const before = {
        active: draft.combat["active"] === true,
        round: Number(draft.combat["round"] ?? 0),
        turn: Number(draft.combat["turn"] ?? 0),
      };
      const after = { ...before };
      if (action.transition === "start") {
        after.active = true;
        after.round = Math.max(1, after.round);
        after.turn = 0;
      } else if (action.transition === "next-turn") {
        if (!after.active)
          throw new ProtocolError({
            code: "INVALID_PAYLOAD",
            message: "Cannot advance the turn of an inactive Combat.",
            retryable: false,
            fieldPath: `actions.${index}`,
          });
        const combatants = Array.isArray(draft.combat["combatants"])
          ? draft.combat["combatants"].length
          : 0;
        if (combatants > 0 && after.turn + 1 >= combatants) {
          after.turn = 0;
          after.round += 1;
        } else after.turn += 1;
      } else if (action.transition === "next-round") {
        if (!after.active)
          throw new ProtocolError({
            code: "INVALID_PAYLOAD",
            message: "Cannot advance the round of an inactive Combat.",
            retryable: false,
            fieldPath: `actions.${index}`,
          });
        after.round += 1;
        after.turn = 0;
      } else after.active = false;
      for (const key of ["active", "round", "turn"] as const)
        if (before[key] !== after[key]) {
          diffs.push({
            path: `combats.${combat.id}.${key}`,
            before: before[key],
            after: after[key],
          });
          draft.combat[key] = after[key];
        }
      warnings.push(
        "Combatant initiative, hooks, start/end side effects, and system automation are not projected.",
      );
    }
    return {
      rolls,
      ...(total === undefined ? {} : { total }),
      ...(success === undefined ? {} : { success }),
      diffs,
      warnings,
      context,
    };
  };

  const steps: SimulationStep[] = [];
  const allDiffs: ProjectedDiff[] = [];
  const allRolls: number[] = [];
  const allWarnings: string[] = [];
  let stoppedAtStep: number | null = null;
  let lastProjection: StepProjection | undefined;
  let suppliedRollOffset = 0;
  for (const [index, action] of actions.entries()) {
    const draft = structuredClone(state);
    const rollCursor = { offset: suppliedRollOffset, consumed: [] as number[] };
    try {
      const projected = projectStep(action, index, draft, rollCursor);
      state = draft;
      suppliedRollOffset = rollCursor.offset;
      lastProjection = projected;
      allDiffs.push(...projected.diffs);
      allRolls.push(...projected.rolls);
      allWarnings.push(...projected.warnings);
      steps.push({
        index,
        actionKind: action.kind,
        status: "projected",
        completeness: "partial",
        rolls: projected.rolls,
        ...(projected.total === undefined ? {} : { total: projected.total }),
        ...(projected.success === undefined ? {} : { success: projected.success }),
        projectedDiffs: projected.diffs,
        warnings: projected.warnings,
      });
    } catch (error) {
      steps.push({
        index,
        actionKind: action.kind,
        status: "failed",
        completeness: "unsupported",
        rolls: rollCursor.consumed,
        projectedDiffs: [],
        warnings: [],
        errorCode: errorCode(error),
      });
      allRolls.push(...rollCursor.consumed);
      suppliedRollOffset = rollCursor.offset;
      if (!input.continueOnError) {
        stoppedAtStep = index;
        break;
      }
    }
  }

  const persistenceAfter = persistenceSnapshot();
  const afterCounts = {
    chat: game.collections.get("ChatMessage")?.size ?? 0,
    combat: game.collections.get("Combat")?.size ?? 0,
    effects: effectCount(actor, ...targets.values()),
  };
  const documentRevisions: Dnd5eSimulationResult["documentRevisions"] = referenced.map((entry) => ({
    kind: entry.kind,
    id: entry.id,
    before: genuineRevision(entry.source, entry.fieldPath),
    after: genuineRevision(entry.document.toObject(), entry.fieldPath),
  }));
  const beforeRevision = await digest(persistenceBefore);
  const afterRevision = await digest(persistenceAfter);
  const proofFamilies = Object.keys(persistenceBefore) as Array<keyof PersistenceSnapshot>;
  const persistenceProofs = await Promise.all(
    proofFamilies.map(async (family) => {
      const before = await digest(persistenceBefore[family]);
      const after = await digest(persistenceAfter[family]);
      return { family, before, after, unchanged: before === after };
    }),
  );
  if (
    beforeRevision !== afterRevision ||
    persistenceProofs.some((proof) => !proof.unchanged) ||
    documentRevisions.some((entry) => entry.before !== entry.after) ||
    stable(beforeCounts) !== stable(afterCounts)
  )
    throw new ProtocolError({
      code: "INCOMPLETE_RESULT",
      message: "Simulation detected a persistence change in its protected document families.",
      retryable: false,
    });
  return {
    effectiveUserId: input.effectiveUserId,
    actorId: input.actorId,
    actionKind: actions.length === 1 ? actions[0]!.kind : "sequence",
    seed,
    rolls: allRolls,
    ...(lastProjection?.total === undefined ? {} : { total: lastProjection.total }),
    ...(lastProjection?.success === undefined ? {} : { success: lastProjection.success }),
    projectedDiffs: allDiffs,
    completeness: steps.some((step) => step.status === "projected") ? "partial" : "unsupported",
    warnings: allWarnings,
    resolvedContext: lastProjection?.context ?? {},
    documentRevisions,
    beforeRevision,
    afterRevision,
    persistenceProofs,
    beforeCounts,
    afterCounts,
    persisted: false,
    deterministic: true,
    canonical: false,
    simulationOnly: true,
    steps,
    completedSteps: steps.filter((step) => step.status === "projected").length,
    stoppedAtStep,
  };
}

registerCommand(DND5E_SIMULATION_COMMANDS.SIMULATE, simulateDnd5eAction);
