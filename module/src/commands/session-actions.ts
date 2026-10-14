import {
  SESSION_ACTION_COMMANDS,
  type SessionActionInput,
  type SessionActionApplyInput,
  type SessionActionState,
  type SessionActionReceipt,
  type CommandTiming,
} from "@foundry-local-api/shared";
import { registerCommand, registerTimedCommand } from "../command-registry.js";
import { inWorldMutationLane, UncertainWorldMutationError } from "../world-mutation-lane.js";
import { moveTokenVerified, preflightTokenTravel } from "./movement-policy.js";
type Doc = FoundryDocument & {
  getEmbeddedCollection(name: string): Map<string, Doc>;
  actor?: Doc;
  combatants?: Map<string, Doc>;
  turns?: Doc[];
  nextTurn?: () => Promise<unknown>;
  statuses?: Set<string>;
  effects?: Map<string, Doc>;
  deleteEmbeddedDocuments?: (
    name: string,
    ids: string[],
    options: Record<string, unknown>,
  ) => Promise<unknown>;
  toggleStatusEffect?: (id: string, options: Record<string, unknown>) => Promise<unknown>;
  sounds?: Map<string, Doc>;
  move?: (
    destination: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => Promise<boolean>;
  object?:
    | {
        constrainMovementPath?: (
          path: Record<string, unknown>[],
          options: Record<string, unknown>,
        ) => unknown;
      }
    | undefined;
  sound?: { currentTime: number };
};
function record(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}
function fail(message: string): never {
  throw new Error(message);
}
function validateLightPatch(
  action: Extract<SessionActionInput["action"], { kind: "token.light" }>,
): void {
  const light = action.light;
  if (
    Object.keys(action).some((key) => !["kind", "sceneId", "targetId", "light"].includes(key)) ||
    !light ||
    typeof light !== "object" ||
    Array.isArray(light) ||
    Object.getPrototypeOf(light) !== Object.prototype ||
    Object.keys(light).some((key) => !["bright", "dim", "color", "alpha"].includes(key)) ||
    Object.values(light).every((value) => value === undefined) ||
    [light.bright, light.dim].some(
      (value) =>
        value !== undefined &&
        (!Number.isFinite(value) ||
          value < 0 ||
          value > 10000 ||
          value !== Number(value.toFixed(2))),
    ) ||
    (light.color !== undefined &&
      light.color !== null &&
      (typeof light.color !== "string" || !/^#[0-9a-f]{6}$/i.test(light.color))) ||
    (light.alpha !== undefined &&
      (!Number.isFinite(light.alpha) || light.alpha < 0 || light.alpha > 1))
  )
    fail("Invalid token light patch");
}
function boundedLightState(light: unknown): void {
  if (new TextEncoder().encode(JSON.stringify({ light })).byteLength > 8192)
    fail("Token light state exceeds bounded 8k UTF8 budget");
}
function normalizedLight(doc: Doc, patch: Record<string, unknown>): Record<string, unknown> {
  const current = doc.toObject()["light"];
  boundedLightState(current);
  const field = (
    CONFIG["Token"]?.documentClass as unknown as {
      schema?: {
        fields?: {
          light?: {
            clean(value: unknown, options: Record<string, unknown>): unknown;
            validate(value: unknown, options: Record<string, unknown>): unknown;
          };
        };
      };
    }
  )?.schema?.fields?.light;
  if (
    !current ||
    typeof current !== "object" ||
    Array.isArray(current) ||
    !field?.clean ||
    !field.validate
  )
    fail("Native Token light validation unavailable");
  const merged = {
    ...structuredClone(current),
    ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
  };
  const bright = merged["bright"],
    dim = merged["dim"];
  if (
    typeof bright !== "number" ||
    typeof dim !== "number" ||
    !Number.isFinite(bright) ||
    !Number.isFinite(dim) ||
    bright < 0 ||
    bright > 10000 ||
    dim < 0 ||
    dim > 10000
  )
    fail("Token light patch conflicts with current radii; read the placed token light first");
  boundedLightState(merged);
  const cleaned = field.clean(merged, { partial: false });
  if (
    !cleaned ||
    typeof cleaned !== "object" ||
    Array.isArray(cleaned) ||
    field.validate(cleaned, { source: cleaned, partial: false, strict: false, fallback: false })
  )
    fail("Native Token light validation rejected patch");
  boundedLightState(cleaned);
  return structuredClone(cleaned as Record<string, unknown>);
}
function lightEqual(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, canonical(v)]),
          )
        : value;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
function authorize(input: SessionActionInput): void {
  const a = input.action;
  if (
    !a ||
    ![
      "actor.hp",
      "actor.condition",
      "playlist.sound",
      "door.state",
      "token.position",
      "token.light",
      "combat.next",
      "combat.initiative",
      "chat.post",
    ].includes(a.kind)
  )
    fail("Unsupported action");
  if (a.kind !== "chat.post" && a.kind !== "playlist.sound" && (!a.sceneId || !a.targetId))
    fail("Scene and target required");
  if (
    (a.kind === "actor.hp" || a.kind === "door.state" || a.kind === "combat.initiative") &&
    !Number.isFinite(a.value)
  )
    fail("Finite value required");
  if (a.kind === "actor.hp" && (!Number.isInteger(a.value) || a.value < 0 || a.value > 100000))
    fail("Invalid HP");
  if (a.kind === "door.state" && ![0, 1, 2].includes(a.value)) fail("Invalid door state");
  if (
    a.kind === "actor.condition" &&
    (typeof a.active !== "boolean" || typeof a.conditionId !== "string")
  )
    fail("Invalid condition state");
  if (
    a.kind === "playlist.sound" &&
    (!["playing", "paused", "stopped"].includes(a.state) || !a.targetId || !a.soundId)
  )
    fail("Invalid sound state");
  if (a.kind === "combat.initiative" && (a.value < -10000 || a.value > 10000 || !a.combatantId))
    fail("Invalid initiative");
  if (
    a.kind === "token.position" &&
    (!Number.isFinite(a.x) || !Number.isFinite(a.y) || a.x < 0 || a.y < 0)
  )
    fail("Invalid coordinates");
  if (a.kind === "token.position" && a.mode !== undefined && !["walk", "teleport"].includes(a.mode))
    fail("Invalid movement mode");
  if (a.kind === "token.light") validateLightPatch(a);
  if (
    input.worldId !== game.world.id ||
    !game.user.isGM ||
    !game.user.active ||
    game.user.id !== input.requestingUserId
  )
    fail("Live GM/world authorization required");
  const user = game.users.get(input.requestingUserId);
  if (!user?.isGM || !user.active) fail("Requesting GM is no longer authorized");
}
function sceneFor(input: SessionActionInput): Doc {
  if (input.action.kind === "chat.post" || input.action.kind === "playlist.sound")
    fail("Action has no scene");
  const scene = game.collections.get("Scene")?.get(input.action.sceneId) as Doc | undefined;
  if (!scene || scene.toObject()["active"] !== true) fail("Action requires the active scene");
  return scene;
}
function resolve(input: SessionActionInput): {
  doc: Doc;
  state: Record<string, unknown>;
  scene?: Doc;
} {
  const a = input.action;
  if (a.kind === "playlist.sound") {
    const doc = game.collections.get("Playlist")?.get(a.targetId) as Doc | undefined;
    const sound = doc?.sounds?.get(a.soundId);
    if (!doc || !sound) fail("Playlist sound missing");
    const data = sound.toObject();
    return {
      doc: sound,
      state: { playing: data["playing"], pausedTime: data["pausedTime"] ?? null },
    };
  }
  const scene = sceneFor(input);
  let doc: Doc | undefined;
  if (a.kind === "actor.hp" || a.kind === "actor.condition") {
    if (a.kind === "actor.hp" && game.system.id !== "dnd5e") fail("HP setter supports dnd5e only");
    const tokens = scene.getEmbeddedCollection("Token");
    for (const token of tokens.values())
      if (token.actor?.id === a.targetId) {
        if (doc && doc !== token.actor)
          fail("Ambiguous actor: select an unambiguous current-scene actor");
        doc = token.actor;
      }
    if (!doc) fail("Actor must be represented by a current-scene token");
    if (a.kind === "actor.condition") {
      const effects = (
        CONFIG as unknown as { statusEffects?: { id: string }[] | Record<string, unknown> }
      ).statusEffects;
      const known = Array.isArray(effects)
        ? effects.some((effect) => effect.id === a.conditionId)
        : !!effects && Object.hasOwn(effects, a.conditionId);
      if (!known || !doc.statuses) fail("Trusted condition/API unavailable");
      return { doc, scene, state: { active: doc.statuses.has(a.conditionId) } };
    }
    const hp = record(record(record(doc.toObject()["system"])["attributes"])["hp"]);
    const max = hp["max"];
    if (typeof max !== "number" || a.value > max) fail("HP exceeds actor maximum");
    return { doc, scene, state: { value: hp["value"], max } };
  }
  if (a.kind === "door.state" || a.kind === "token.position" || a.kind === "token.light") {
    doc = scene.getEmbeddedCollection(a.kind === "door.state" ? "Wall" : "Token").get(a.targetId);
    if (!doc) fail("Scene target missing");
    const data = doc.toObject();
    if (a.kind === "token.light") {
      boundedLightState(data["light"]);
      normalizedLight(doc, a.light);
      return { doc, scene, state: { light: structuredClone(data["light"]) } };
    }
    if (a.kind === "door.state") {
      if (!data["door"]) fail("Wall is not a door");
      return { doc, scene, state: { ds: data["ds"] } };
    }
    const sd = scene.toObject();
    const width = Number(sd["width"]),
      height = Number(sd["height"]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || a.x > width || a.y > height)
      fail("Token destination outside scene bounds");
    preflightTokenTravel(doc, a);
    return { doc, scene, state: { x: data["x"], y: data["y"] } };
  }
  if (a.kind === "combat.next" || a.kind === "combat.initiative") {
    doc = game.collections.get("Combat")?.get(a.targetId) as Doc | undefined;
    if (!doc) fail("Combat missing");
    const data = doc.toObject();
    if (data["active"] !== true || data["scene"] !== a.sceneId || Number(data["round"]) < 1)
      fail("Requires started active combat on current scene");
    const state: Record<string, unknown> = { round: data["round"], turn: data["turn"] };
    if (a.kind === "combat.next") state["turnCount"] = doc.turns?.length ?? 0;
    if (a.kind === "combat.initiative") {
      const c = doc.combatants?.get(a.combatantId);
      if (!c) fail("Combatant missing");
      state["initiative"] = c.toObject()["initiative"];
    }
    return { doc, scene, state };
  }
  return fail("Unsupported action");
}
export function readSessionAction(input: SessionActionInput): SessionActionState {
  authorize(input);
  if (input.action.kind === "chat.post") {
    if (
      input.action.text.length < 1 ||
      input.action.text.length > 4000 ||
      /[<>]/.test(input.action.text)
    )
      fail("Plain bounded text required");
    if (input.action.messageId) {
      const message = game.collections.get("ChatMessage")?.get(input.action.messageId);
      if (!message) fail("Message missing");
      return {
        worldId: game.world.id,
        action: input.action,
        state: { messageId: message.id, content: message.toObject()["content"] },
      };
    }
    return {
      worldId: game.world.id,
      action: input.action,
      state: { messageCount: game.collections.get("ChatMessage")?.size ?? 0 },
    };
  }
  return { worldId: game.world.id, action: input.action, state: resolve(input).state };
}
function equal(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
}
export async function applySessionAction(
  input: SessionActionApplyInput,
  timing?: CommandTiming,
  mutationStarting?: () => void,
): Promise<SessionActionReceipt> {
  const beforeStarted = performance.now();
  const before = readSessionAction(input);
  timing?.record("preflight-read", performance.now() - beforeStarted);
  if (
    !(input.action.kind === "token.light"
      ? lightEqual(before.state, input.expectedState)
      : equal(before.state, input.expectedState))
  )
    fail("Stale session state; re-read before proposing another action");
  if (!input.correlationId || !input.idempotencyKey) fail("Durable action identifiers required");
  const options = {
    correlationId: input.correlationId,
    foundryLocalApi: { authorizedGmMovement: true },
    foundryLocalApiOrigin: {
      source: "foundry-local-api.session-action",
      phase: "apply",
      correlationId: input.correlationId,
    },
  };
  const a = input.action;
  let state: Record<string, unknown>;
  if (a.kind === "chat.post") {
    if (a.messageId) fail("messageId is read-only");
    const klass = CONFIG["ChatMessage"]?.documentClass;
    if (!klass) fail("Chat class unavailable");
    mutationStarting?.();
    const message = await klass.create({ content: a.text, user: input.requestingUserId }, options);
    if (!message) fail("Chat create result uncertain");
    const data = message.toObject();
    if (data["content"] !== a.text) fail("Chat read-back mismatch");
    state = { messageId: message.id, content: data["content"] };
  } else {
    const { doc } = resolve(input);
    let nextCombatState: Record<string, unknown> | undefined;
    let nextLight: Record<string, unknown> | undefined;
    if (a.kind === "actor.condition") {
      // Foundry v14's toggleStatusEffect drops arbitrary options. Follow its
      // configured-effect path while forwarding actual executor provenance.
      const configured = (
        CONFIG as unknown as {
          statusEffects:
            { id: string; _id?: string }[] | Record<string, { id?: string; _id?: string }>;
        }
      ).statusEffects;
      const status = Array.isArray(configured)
        ? configured.find((effect) => effect.id === a.conditionId)
        : configured[a.conditionId];
      if (!status || !doc.effects) fail("Configured actor effects unavailable");
      const existing = [...doc.effects.values()].filter((effect) =>
        status._id
          ? effect.id === status._id
          : effect.statuses?.size === 1 && effect.statuses.has(a.conditionId),
      );
      if (!a.active && existing.length) {
        if (!doc.deleteEmbeddedDocuments) fail("Condition deletion API unavailable");
        mutationStarting?.();
        await doc.deleteEmbeddedDocuments(
          "ActiveEffect",
          existing.map((effect) => effect.id),
          options,
        );
      } else if (a.active && !existing.length) {
        const effectClass = CONFIG["ActiveEffect"]?.documentClass as unknown as
          | {
              fromStatusEffect?: (id: string, options: { parent: Doc }) => Promise<Doc>;
              create: (
                data: Record<string, unknown>,
                options: Record<string, unknown>,
              ) => Promise<unknown>;
            }
          | undefined;
        if (!effectClass?.fromStatusEffect) fail("Trusted status factory unavailable");
        const effect = await effectClass.fromStatusEffect(a.conditionId, { parent: doc });
        if (!equal(readSessionAction(input).state, input.expectedState))
          fail("Condition state changed before dispatch");
        mutationStarting?.();
        await effectClass.create(effect.toObject(), { ...options, parent: doc, keepId: true });
      }
    } else if (a.kind === "playlist.sound") {
      mutationStarting?.();
      await doc.update(
        {
          playing: a.state === "playing",
          ...(a.state === "playing"
            ? {}
            : { pausedTime: a.state === "stopped" ? null : (doc.sound?.currentTime ?? 0) }),
        },
        options,
      );
    } else if (a.kind === "actor.hp") {
      mutationStarting?.();
      await doc.update({ "system.attributes.hp.value": a.value }, options);
    } else if (a.kind === "door.state") {
      mutationStarting?.();
      await doc.update({ ds: a.value }, options);
    } else if (a.kind === "token.position") {
      mutationStarting?.();
      await moveTokenVerified(doc, a, options);
    } else if (a.kind === "token.light") {
      nextLight = normalizedLight(doc, a.light);
      mutationStarting?.();
      const acknowledged = await doc.update({ light: structuredClone(nextLight) }, options);
      if (acknowledged !== doc)
        fail("Native token light update acknowledgement unavailable; result uncertain");
    } else if (a.kind === "combat.initiative") {
      mutationStarting?.();
      await doc.combatants!.get(a.combatantId)!.update({ initiative: a.value }, options);
    } else {
      if (!Array.isArray(doc.turns) || doc.turns.length === 0) fail("Combat turn list unavailable");
      const lifecycle = globalThis as typeof globalThis & {
        Hooks?: {
          on: (event: string, cb: (...args: unknown[]) => void) => number;
          off: (event: string, id: number) => void;
        };
      };
      if (typeof doc.nextTurn !== "function" || !lifecycle.Hooks?.on || !lifecycle.Hooks.off)
        fail("Supported combat lifecycle API unavailable");
      const hooks = lifecycle.Hooks;
      let observed: Record<string, unknown> | undefined;
      let observedOptions: Record<string, unknown> | undefined;
      const enrich = (combat: unknown, updateData: unknown, updateOptions: unknown) => {
        if (combat !== doc || observed) return;
        const changes = record(updateData),
          update = record(updateOptions);
        Object.assign(update, options);
        observed = changes;
        observedOptions = update;
      };
      const turnHook = hooks.on("combatTurn", enrich),
        roundHook = hooks.on("combatRound", enrich);
      try {
        mutationStarting?.();
        await doc.nextTurn();
        if (!observed || observedOptions?.["correlationId"] !== input.correlationId)
          fail("Combat lifecycle acknowledgement/provenance unavailable; result uncertain");
        nextCombatState = {
          turn: observed["turn"],
          round: observed["round"],
          turnCount: doc.turns?.length ?? 0,
        };
      } finally {
        hooks.off("combatTurn", turnHook);
        hooks.off("combatRound", roundHook);
      }
    }
    const readbackStarted = performance.now();
    state = readSessionAction(input).state;
    timing?.record("authoritative-readback", performance.now() - readbackStarted);
    if (
      (a.kind === "actor.hp" && state["value"] !== a.value) ||
      (a.kind === "actor.condition" && state["active"] !== a.active) ||
      (a.kind === "playlist.sound" &&
        (state["playing"] !== (a.state === "playing") ||
          (a.state === "stopped" && state["pausedTime"] !== null))) ||
      (a.kind === "door.state" && state["ds"] !== a.value) ||
      (a.kind === "token.position" && (state["x"] !== a.x || state["y"] !== a.y)) ||
      (a.kind === "token.light" && !lightEqual(state["light"], nextLight)) ||
      (a.kind === "combat.initiative" && state["initiative"] !== a.value) ||
      (a.kind === "combat.next" && (!nextCombatState || !equal(state, nextCombatState)))
    )
      fail("Session action read-back mismatch; result uncertain");
  }
  return {
    worldId: game.world.id,
    action: a,
    state,
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey,
    verified: true,
  };
}
registerCommand(SESSION_ACTION_COMMANDS.READ, readSessionAction);
registerTimedCommand(SESSION_ACTION_COMMANDS.APPLY, (input: SessionActionApplyInput, timing) =>
  inWorldMutationLane(game, async () => {
    let started = false;
    try {
      return await applySessionAction(input, timing, () => {
        started = true;
      });
    } catch (error) {
      if (started)
        throw new UncertainWorldMutationError(
          error instanceof Error ? error.message : "Session mutation outcome uncertain",
        );
      throw error;
    }
  }),
);

import {
  CORE_ACTION_COMMAND,
  type CoreActionInput,
  type CoreActionResult,
} from "@foundry-local-api/shared";
const coreLanes = new WeakMap<
  object,
  {
    tail: Promise<unknown>;
    uncertain: boolean;
    receipts: Map<string, { fingerprint: string; result: Promise<CoreActionResult> }>;
  }
>();
export function executeCoreAction(
  input: CoreActionInput,
  timing?: CommandTiming,
): Promise<CoreActionResult> {
  const base = {
    worldId: input.worldId,
    correlationId: input.correlationId,
    schemaVersion: "core-actions-v1" as const,
    action: input.action,
    state: null,
    mutated: false,
  };
  const failure = (message: string): CoreActionResult => ({ ...base, outcome: "failure", message });
  if (
    input.schemaVersion !== "core-actions-v1" ||
    input.origin !== "ai-dm" ||
    !input.requestId ||
    !input.correlationId
  )
    return Promise.resolve(failure("Invalid core protocol"));
  if (
    input.worldId !== game.world.id ||
    input.userId !== game.user.id ||
    !game.user.isGM ||
    !game.user.active
  )
    return Promise.resolve(failure("Exact live GM/world required"));
  const requesting = game.users.get(input.userId);
  if (!requesting?.isGM || !requesting.active)
    return Promise.resolve(failure("GM authority revoked"));
  let lane = coreLanes.get(game);
  if (!lane) {
    lane = { tail: Promise.resolve(), uncertain: false, receipts: new Map() };
    coreLanes.set(game, lane);
  }
  const key = `${input.worldId}:${input.userId}:${input.requestId}`,
    fingerprint = JSON.stringify(input),
    previous = lane.receipts.get(key);
  if (previous)
    return previous.fingerprint === fingerprint
      ? previous.result
      : Promise.resolve(failure("Request ID reused with different action"));
  if (lane.receipts.size >= 4096) return Promise.resolve(failure("Receipt capacity exhausted"));
  const operation = lane.tail.then(async (): Promise<CoreActionResult> => {
    if (lane.uncertain)
      return failure("Prior mutation uncertain; inspect state and reconnect before more mutations");
    if (
      input.worldId !== game.world.id ||
      input.userId !== game.user.id ||
      !game.user.isGM ||
      !game.user.active ||
      !game.users.get(input.userId)?.isGM ||
      !game.users.get(input.userId)?.active
    )
      return failure("GM/world changed before execution");
    let dispatched = false;
    try {
      if (input.action.kind === "system.roll") {
        const a = input.action;
        if (game.system.id !== "dnd5e") return failure("System rolls support dnd5e only");
        const config = (
          CONFIG as unknown as {
            DND5E?: { abilities?: Record<string, unknown>; skills?: Record<string, unknown> };
          }
        ).DND5E;
        const allowed = a.rollType === "skill" ? config?.skills : config?.abilities;
        if (!allowed || !Object.hasOwn(allowed, a.key))
          return failure("Unknown configured roll key");
        const scene = game.collections.get("Scene")?.get(a.sceneId) as Doc | undefined;
        if (!scene || scene.toObject()["active"] !== true)
          return failure("System roll requires active scene");
        const actors = [...scene.getEmbeddedCollection("Token").values()]
          .filter((t) => t.actor?.id === a.targetId)
          .map((t) => t.actor!);
        const actor = actors[0];
        if (!actor || actors.some((t) => t !== actor))
          return failure("Actor missing or ambiguous on current scene");
        const method =
          a.rollType === "skill"
            ? "rollSkill"
            : a.rollType === "save"
              ? "rollSavingThrow"
              : "rollAbilityCheck";
        const fn = (actor as unknown as Record<string, unknown>)[method];
        if (typeof fn !== "function") return failure("Modern system roll API unavailable");
        // Never fall back after an attempted roll: that may reroll after a lost result.
        dispatched = true;
        const raw = await (fn as (...args: unknown[]) => Promise<unknown>).call(
          actor,
          { [a.rollType === "skill" ? "skill" : "ability"]: a.key },
          { configure: false },
          {
            create: false,
            foundryLocalApiOrigin: {
              source: "foundry-local-api.session-action",
              phase: "apply",
              correlationId: input.correlationId,
            },
          },
        );
        const rolls = Array.isArray(raw) ? raw : [raw];
        if (!rolls.length || rolls.length > 10) throw Error("System roll result unavailable");
        const results = rolls.map((value) => {
          const r = record(value);
          if (
            typeof r["total"] !== "number" ||
            !Number.isFinite(r["total"]) ||
            typeof r["formula"] !== "string"
          )
            throw Error("System roll result unavailable");
          return { formula: r["formula"], total: r["total"], result: r["result"] };
        });
        if (
          input.worldId !== game.world.id ||
          input.userId !== game.user.id ||
          !game.user.isGM ||
          !game.user.active ||
          !game.users.get(input.userId)?.isGM ||
          !game.users.get(input.userId)?.active
        )
          throw Error("System roll authority changed");
        return {
          ...base,
          outcome: "confirmed",
          mutated: true,
          state: { systemId: "dnd5e", rollType: a.rollType, key: a.key, rolls: results },
        };
      }
      if (input.action.kind === "dice.roll") {
        if (
          !/^(?:[1-9]|[1-9][0-9])d(?:4|6|8|10|12|20|100)(?:[+-](?:0|[1-9][0-9]{0,3}))?$/.test(
            input.action.formula,
          )
        )
          return failure("Only bounded NdS +/- integer dice formulas supported");
        const roll = new Roll(input.action.formula);
        dispatched = true;
        await roll.evaluate();
        if (
          input.worldId !== game.world.id ||
          input.userId !== game.user.id ||
          !game.user.isGM ||
          !game.user.active ||
          !game.users.get(input.userId)?.active ||
          !game.users.get(input.userId)?.isGM ||
          !Number.isFinite(roll.total)
        )
          throw Error("Roll authority or result changed");
        return {
          ...base,
          outcome: "confirmed",
          mutated: true,
          state: {
            formula: roll.formula,
            total: roll.total,
            result: roll.result,
            dice: roll.dice.map((d) => ({
              faces: d.faces,
              results: d.results.map((r) => r.result),
            })),
          },
        };
      }
      const actionInput = {
        worldId: input.worldId,
        requestingUserId: input.userId,
        action: input.action,
      };
      const before = readSessionAction(actionInput);
      const a = input.action,
        s = before.state;
      const already =
        (a.kind === "actor.hp" && s["value"] === a.value) ||
        (a.kind === "door.state" && s["ds"] === a.value) ||
        (a.kind === "token.position" && s["x"] === a.x && s["y"] === a.y) ||
        (a.kind === "token.light" &&
          lightEqual(s["light"], normalizedLight(resolve(actionInput).doc, a.light))) ||
        (a.kind === "actor.condition" && s["active"] === a.active) ||
        (a.kind === "combat.initiative" && s["initiative"] === a.value);
      if (already) return { ...base, outcome: "confirmed", state: s };
      dispatched = true;
      const mutationStarted = performance.now();
      const receipt = await applySessionAction(
        {
          ...actionInput,
          expectedState: s,
          correlationId: input.correlationId,
          idempotencyKey: input.requestId,
        },
        timing,
      );
      timing?.record("mutation-and-readback", performance.now() - mutationStarted);
      if (
        input.worldId !== game.world.id ||
        input.userId !== game.user.id ||
        !game.user.isGM ||
        !game.user.active ||
        !game.users.get(input.userId)?.isGM ||
        !game.users.get(input.userId)?.active
      )
        throw Error("GM/world changed during mutation");
      return { ...base, outcome: "confirmed", state: receipt.state, mutated: true };
    } catch (error) {
      if (dispatched) lane.uncertain = true;
      return {
        ...base,
        outcome: dispatched ? "uncertain" : "failure",
        message: error instanceof Error ? error.message : "Execution failed",
      };
    }
  });
  lane.receipts.set(key, { fingerprint, result: operation });
  lane.tail = operation.catch(() => undefined);
  return operation;
}
registerTimedCommand(CORE_ACTION_COMMAND, (input: CoreActionInput, timing) =>
  inWorldMutationLane(game, () => executeCoreAction(input, timing)),
);

export function readCoreState(input: {
  worldId: string;
  userId: string;
  schemaVersion: "core-actions-v1";
}): Record<string, unknown> {
  if (
    input.schemaVersion !== "core-actions-v1" ||
    input.worldId !== game.world.id ||
    input.userId !== game.user.id ||
    !game.user.isGM ||
    !game.user.active ||
    !game.users.get(input.userId)?.isGM ||
    !game.users.get(input.userId)?.active
  )
    fail("Exact live GM/world required");
  const scenes = game.collections.get("Scene");
  const scene = [...(scenes?.values() ?? [])].find((s) => s.toObject()["active"] === true) as
    Doc | undefined;
  const statuses = (CONFIG as unknown as { statusEffects?: { id: string }[] }).statusEffects;
  const combats = [...(game.collections.get("Combat")?.values() ?? [])]
    .filter((c) => c.toObject()["active"] === true && c.toObject()["scene"] === scene?.id)
    .slice(0, 5)
    .map((c) => {
      const d = c.toObject();
      return {
        id: c.id,
        round: d["round"],
        turn: d["turn"],
        combatants: [...((c as Doc).combatants?.values() ?? [])].slice(0, 100).map((t) => ({
          id: t.id,
          name: t.toObject()["name"],
          initiative: t.toObject()["initiative"],
          tokenId: t.toObject()["tokenId"],
          actorId: t.toObject()["actorId"],
        })),
      };
    });
  return {
    schemaVersion: "core-actions-v1",
    movementPolicy: "native-constrained-walk-v1",
    worldId: game.world.id,
    systemId: game.system.id,
    scene: scene
      ? {
          id: scene.id,
          name: scene.toObject()["name"],
          width: scene.toObject()["width"],
          height: scene.toObject()["height"],
          tokens: [...scene.getEmbeddedCollection("Token").values()].slice(0, 100).map((t) => {
            const d = t.toObject();
            return { id: t.id, name: d["name"], actorId: t.actor?.id, x: d["x"], y: d["y"] };
          }),
          doors: [...scene.getEmbeddedCollection("Wall").values()]
            .filter((w) => Boolean(w.toObject()["door"]))
            .slice(0, 100)
            .map((w) => ({ id: w.id, state: w.toObject()["ds"], coordinates: w.toObject()["c"] })),
        }
      : null,
    combats,
    rollKeys:
      game.system.id === "dnd5e"
        ? {
            abilities: Object.keys(
              (CONFIG as unknown as { DND5E?: { abilities?: Record<string, unknown> } }).DND5E
                ?.abilities ?? {},
            ).slice(0, 100),
            skills: Object.keys(
              (CONFIG as unknown as { DND5E?: { skills?: Record<string, unknown> } }).DND5E
                ?.skills ?? {},
            ).slice(0, 100),
          }
        : null,
    conditionIds: Array.isArray(statuses)
      ? statuses.map((s) => s.id).slice(0, 100)
      : Object.keys(statuses ?? {}).slice(0, 100),
  };
}
registerCommand("coreState", readCoreState);

/** Read one placed token through the same authorization and scene resolution as mutations. */
export function readTokenLight(input: {
  worldId: string;
  userId: string;
  sceneId: string;
  tokenId: string;
}): Record<string, unknown> {
  if (input.userId !== game.user.id) fail("Exact live GM/world required");
  const actionInput: SessionActionInput = {
    worldId: input.worldId,
    requestingUserId: input.userId,
    action: {
      kind: "token.light",
      sceneId: input.sceneId,
      targetId: input.tokenId,
      light: { bright: 0, dim: 0 },
    },
  };
  const state = readSessionAction(actionInput).state;
  boundedLightState(state["light"]);
  const scene = sceneFor(actionInput).toObject();
  const units = record(scene["grid"])["units"];
  return {
    worldId: input.worldId,
    sceneId: input.sceneId,
    tokenId: input.tokenId,
    scope: "placed-token",
    units: typeof units === "string" ? units.slice(0, 80) : "",
    light: state["light"],
  };
}
registerCommand("tokenLightRead", readTokenLight);
