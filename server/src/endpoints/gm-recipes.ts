import { createHash } from "node:crypto";
import { z } from "zod";
import type { AnyEndpointDescriptor, EndpointContext } from "./types.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const record = z.record(z.string(), z.unknown());
const scope = { schemaVersion: z.literal("gm-actions-v1"), worldId: id, userId: id, sceneId: id };
export const gmRecipeInvokeSchema = z
  .object({
    ...scope,
    recipeId: id,
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/),
    correlationId: z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/),
    expectedInitialState: record,
    steps: z
      .array(z.object({ stepId: id, action: record }).strict())
      .min(1)
      .max(12)
      .refine((v) => new Set(v.map((s) => s.stepId)).size === v.length, "Unique step IDs required"),
  })
  .strict();
export type GmRecipeInput = z.infer<typeof gmRecipeInvokeSchema>;
const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
          .join(",")}}`
      : (JSON.stringify(v) ?? "null");
export interface GenericGmRecipe {
  id: string;
  purpose: string;
  triggers: string[];
  requiredTools: string[];
  parameters: Record<string, unknown>;
  preconditions: string[];
  steps: string[];
  verification: string[];
  permissions: string[];
  recovery: string[];
  versionCompatibility: string[];
  markedForLookup: true;
  family: "combat" | "activity" | "character" | "scene" | "session" | "document" | "tv";
  allowedKinds: string[];
  executable: boolean;
}
function recipe(
  id: string,
  family: GenericGmRecipe["family"],
  purpose: string,
  triggers: string[],
  allowedKinds: string[],
): GenericGmRecipe {
  return {
    id,
    family,
    purpose,
    triggers,
    allowedKinds,
    markedForLookup: true,
    executable: true,
    requiredTools:
      family === "session"
        ? [
            "foundry_get_session_action_state",
            "foundry_apply_session_action",
            "foundry_gm_scene_state",
            "foundry_gm_scene_apply",
            "foundry_gm_receipt_read",
          ]
        : [`foundry_gm_${family}_state`, `foundry_gm_${family}_apply`, "foundry_gm_receipt_read"],
    parameters: {
      schema: "gm-actions-v1",
      worldId: "authenticated current world",
      userId: "authenticated opted-in native GM",
      sceneId: "exact scene",
      expectedInitialState: "latest exact authoritative snapshot",
      steps: "1..12 unique step IDs with explicit native actions; no inferred IDs or rules",
    },
    preconditions: [
      "Explicit authenticated GM intent; native scene/document authority is revalidated by each operation",
      "Resolve edition, roll privacy, targets and all human rules choices explicitly",
      "No unresolved prior mutation; no automatic capture-dependent dispatch",
    ],
    steps: [
      "Read exact native action state",
      "Compare first read with expectedInitialState",
      "Apply once with stable derived per-step key and current expectedState",
      "Verify exact native receipt identity and independent state readback",
      "Stop at first failure or uncertainty",
    ],
    verification: [
      "Confirmed native receipt for every step; readback equals receipt.after",
      "Ordered receipts retain exact action, step and scope; rolls/resources are never inferred from narration",
    ],
    permissions: [
      "GM-only private output",
      "Transport credentials do not grant native authority; no role/ownership changes",
    ],
    recovery: [
      "Same live endpoint instance returns exact cached invocation receipts; never issue new IDs to retry rolls/spends",
      "Process restart never automatically continues: changed initial state refuses; unchanged state is fenced by original native per-step receipts or the durable journal-only recipe reservation for session/document/TV. Use foundry_gm_receipt_read with original keys and human reconciliation; no replay under new IDs",
      "Uncertain/disconnected/cancelled dispatch requires native journal inspection and human reconciliation; no compensating roll or automatic restart",
      "Already confirmed effects remain; later failed steps do not roll back game state",
    ],
    versionCompatibility: [
      "Foundry 14.368",
      "dnd5e 6.0.3",
      "gm-actions-v1; other versions fail native compatibility checks",
    ],
  };
}
export const GM_GENERIC_RECIPES: GenericGmRecipe[] = [
  recipe(
    "combat-encounter",
    "combat",
    "Prepare existing scene tokens as an encounter and explicitly progress combat",
    ["encounter", "initiative", "start combat", "next turn", "end combat"],
    ["create", "add-combatants", "remove-combatants", "initiative", "start", "next", "end"],
  ),
  recipe(
    "combat-budgets",
    "combat",
    "Persist explicit action, bonus, reaction and movement budgets",
    ["action economy", "movement", "extra attack", "dash"],
    ["budget-initialize", "budget-spend", "budget-adjust", "special-decision"],
  ),
  recipe(
    "combat-interruptions",
    "combat",
    "Record human ready/opportunity/reaction/legendary/lair decisions before turn continuation",
    ["ready", "opportunity", "reaction", "legendary", "lair", "mythic"],
    ["ready", "ready-expire", "interrupt-open", "interrupt-resolve", "special-decision"],
  ),
  recipe(
    "native-activity",
    "activity",
    "Activate native dnd5e activities with once-only resources, attack/damage evidence, explicit native template/summon placements or held-spell ready/release phases",
    [
      "attack",
      "spell",
      "upcast",
      "ammunition",
      "charges",
      "template",
      "summon",
      "save",
      "critical",
    ],
    ["use"],
  ),
  recipe(
    "typed-health",
    "character",
    "Apply explicit typed damage/healing, native mitigation, maximum-HP modifier or verified native stabilization after explicit ruling",
    [
      "damage",
      "healing",
      "resistance",
      "immunity",
      "vulnerability",
      "temporary HP",
      "save half",
      "stabilize",
    ],
    ["actor.damage", "actor.hp.tempmax", "actor.stabilize"],
  ),
  recipe(
    "native-checks",
    "character",
    "Perform explicit native checks; group/contested comparisons remain human decisions",
    [
      "skill",
      "tool",
      "ability",
      "saving throw",
      "death save",
      "concentration",
      "stealth",
      "perception",
      "grapple",
      "shove",
      "trap",
      "disarm",
    ],
    ["actor.check"],
  ),
  recipe(
    "conditions-duration",
    "character",
    "Update native conditions, exhaustion, duration or end exact concentration effect",
    ["condition", "exhaustion", "duration", "concentration"],
    ["actor.condition", "actor.exhaustion", "actor.effect.duration", "actor.concentration.end"],
  ),
  recipe(
    "party-rests",
    "character",
    "Use native short/long rest and hit dice after explicit eligibility decision",
    ["short rest", "long rest", "hit dice"],
    ["actor.rest", "actor.hitDie"],
  ),
  recipe(
    "inventory-rewards",
    "character",
    "Grant/copy real native Items and adjust exact quantity/equip/attunement, currency or XP with explicit GM allocation decisions",
    ["inventory", "equip", "loot", "currency", "reward"],
    [
      "actor.item.grant",
      "actor.item.copy",
      "actor.item.remove",
      "actor.item.equip",
      "actor.item.attune",
      "actor.item.quantity",
      "actor.currency",
      "actor.currency.convert",
      "actor.xp",
    ],
  ),
  recipe(
    "exploration-movement",
    "scene",
    "Native token walk/teleport with durable combat movement spend and explicit movementCost/ruling; terrain, reach and interruption adjudication remain human choices",
    ["move", "teleport", "grapple", "shove", "terrain", "flight", "climb", "swim"],
    ["token.move"],
  ),
  recipe(
    "doors-light-corrections",
    "session",
    "Set actual native door state, bounded token light or explicit GM HP correction after native checks/rulings",
    ["door", "lock", "torch", "light", "HP correction"],
    ["door.state", "token.light", "actor.hp"],
  ),
  recipe(
    "scene-time-elevation",
    "scene",
    "Advance native world time or explicitly change token elevation after an exact GM decision",
    ["travel", "world time", "elevation", "exploration turn", "fall"],
    ["world-time.advance", "token.elevation"],
  ),
  {
    ...recipe(
      "native-document-preparation",
      "document",
      "Lookup existing generic revision-bound native documents for prepared spells/effects/scene placement, maps, journal and quest updates; human adjudication required",
      [
        "prepared spells",
        "timed effect",
        "battlemap",
        "placement",
        "scene activation",
        "journal",
        "quest",
        "terrain",
        "template",
      ],
      ["get", "list", "update"],
    ),
    requiredTools: [
      "foundry_get_world_document",
      "foundry_apply_world_document",
      "foundry_gm_scene_state",
      "foundry_gm_scene_apply",
      "foundry_gm_receipt_read",
    ],
    executable: true,
    parameters: {
      family: "bounded known native document family",
      operation: "DM wrapper permits read/get/list and revision-bound update only",
      targetId: "exact real document",
      parentId: "exact native parent; scene children bind requested scene",
      data: "bounded native fields; no ownership/security/executable fields",
      expectedState: "full latest source revision",
    },
    steps: [
      "Invoke explicit get/list/update steps with exact family/target/parent IDs",
      "Read the exact source; compare initial state and use each current revision for update",
      "Reject create/delete/security/scripts/ownership fields; preserve explicit human preparation decisions",
      "Independently verify exact source and revision after every update",
    ],
    verification: [
      "Revision-bound native update; no invented geometry or mechanical effect from artwork",
      "Invokable through the same exposed generic document handlers; no unsupported import/create semantics",
    ],
  },
  {
    ...recipe(
      "tv-camera-vision",
      "tv",
      "Control one exact authenticated opted-in TV client with existing native PC UNION vision and ruler-based physical calibration",
      ["TV", "camera", "zoom", "perspective", "union vision", "physical calibration"],
      ["inspect", "unionVision", "camera", "calibrate", "perspective"],
    ),
    requiredTools: [
      "foundry_tv_control",
      "foundry_gm_scene_state",
      "foundry_gm_scene_apply",
      "foundry_gm_receipt_read",
    ],
    executable: true,
    parameters: {
      version: "tv-controls-v1",
      worldId: "authenticated current world",
      requestingUserId: "injected exact authenticated native GM; IDs do not confer authority",
      sceneId: "exact current scene/level",
      tvUserId: "native opted-in non-GM TV user",
      tvClientId: "exact enrolled TV client",
      action: "inspect/unionVision/camera/calibrate/perspective",
      expectedState: "latest inspected camera",
      idempotencyKey: "stable companion operation",
      calibration:
        "actual measuredPixels/measuredInches/gridInches plus rulerConfirmed; physical proof remains later acceptance",
    },
    preconditions: [
      "Exact TV consent and existing OBSERVER access to all native party PC sources",
      "No non-PC or GM vision sources; missing source permission blocks, never grants broader permission",
      "Native walls/fog/detection remain authoritative; other levels/3D/rotation are unsupported",
    ],
    steps: [
      "Inspect one exact authenticated opted-in TV; compare latest expected camera state",
      "Invoke bounded explicit actions for that same exact TV, injecting the authenticated requester",
      "Use each current inspected camera as expectedState and verify native PC union after apply",
      "Independent exact-TV camera readback verifies result; physical proof remains later ruler acceptance",
    ],
    verification: [
      "Native exact PC union verified, permissionsChanged false, no secret/unseen bypass",
      "PhysicalVerified remains false until later human ruler acceptance",
      "Invokable through the same exposed foundry_tv_control handler; no permission or visibility override",
    ],
  },
];

/** A fixed catalog of generic native primitives. No DM policy, arbitrary code or provider dependency. */
export function createGmRecipeEndpointDescriptors(
  operations: AnyEndpointDescriptor[],
): AnyEndpointDescriptor[] {
  const operation = new Map(operations.map((d) => [d.name, d]));
  const lookup = (recipeId: string) => {
    const found = GM_GENERIC_RECIPES.find((r) => r.id === recipeId);
    if (!found) throw Error("Unknown GM recipe");
    return found;
  };
  const summary = (r: GenericGmRecipe) => ({
    id: r.id,
    purpose: r.purpose,
    triggers: r.triggers,
    requiredTools: r.requiredTools,
    markedForLookup: true,
    executable: r.executable && r.requiredTools.every((t) => operation.has(t)),
    toolsAvailable: r.requiredTools.every((t) => operation.has(t)),
  });
  const query = z
    .object({
      query: z.string().trim().min(1).max(200),
      limit: z.number().int().min(1).max(25).default(10),
    })
    .strict();
  const cache = new WeakMap<
    object,
    Map<string, { fingerprint: string; result: Promise<unknown> }>
  >();
  async function invoke(input: GmRecipeInput, ctx: EndpointContext): Promise<unknown> {
    const parsed = gmRecipeInvokeSchema.parse(input);
    if (Buffer.byteLength(canonical(parsed)) > 32768)
      throw Error("Recipe input exceeds byte limit");
    const r = lookup(parsed.recipeId);
    if (!r.executable)
      throw Error(
        "Recipe requires explicit named generic primitives; read its steps before dispatch",
      );
    if (r.family === "tv" || r.family === "document") return invokeSpecialized(parsed, r, ctx);
    const state = operation.get(r.requiredTools[0]!),
      apply = operation.get(r.requiredTools[1]!);
    if (!state || !apply) throw Error("Required native recipe tools unavailable");
    for (const step of parsed.steps) {
      const kind = r.family === "activity" ? step.action["mode"] : step.action["kind"];
      if (!r.allowedKinds.includes(String(kind)))
        throw Error("Action does not belong to this recipe");
      const envelope =
        r.family === "session"
          ? sessionEnvelope(parsed, step.action)
          : {
              schemaVersion: parsed.schemaVersion,
              worldId: parsed.worldId,
              userId: parsed.userId,
              sceneId: parsed.sceneId,
              action: step.action,
            };
      state.inputSchema?.parse(envelope);
      apply.inputSchema?.parse({
        ...envelope,
        expectedState: {},
        idempotencyKey: stepKey(parsed, step.stepId),
        correlationId: parsed.correlationId,
      });
    }
    // Native calls authenticate even before looking up process-local receipts.
    const firstEnvelope =
      r.family === "session"
        ? sessionEnvelope(parsed, parsed.steps[0]!.action)
        : {
            schemaVersion: parsed.schemaVersion,
            worldId: parsed.worldId,
            userId: parsed.userId,
            sceneId: parsed.sceneId,
            action: parsed.steps[0]!.action,
          };
    const first = await state.handler(firstEnvelope, ctx);
    let entries = cache.get(ctx.foundryClient);
    if (!entries) {
      entries = new Map();
      cache.set(ctx.foundryClient, entries);
    }
    const key = canonical([parsed.worldId, parsed.userId, parsed.idempotencyKey]),
      fingerprint = canonical(parsed),
      prior = entries.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw Error("Changed recipe arguments under reused ID");
      return prior.result;
    }
    if (entries.size >= 4096) throw Error("Recipe receipt capacity reached");
    const result = (async () => {
      const receipts: unknown[] = [];
      const failure = (outcome: "failure" | "uncertain", message: string, stepId: string) => ({
        schemaVersion: parsed.schemaVersion,
        worldId: parsed.worldId,
        userId: parsed.userId,
        sceneId: parsed.sceneId,
        recipeId: r.id,
        idempotencyKey: parsed.idempotencyKey,
        correlationId: parsed.correlationId,
        outcome,
        stepId,
        receipts,
        message,
      });
      if (canonical(first) !== canonical(parsed.expectedInitialState))
        return failure(
          "failure",
          "Initial recipe state changed; inspect before new intent",
          parsed.steps[0]!.stepId,
        );
      if (r.family === "session") {
        const reservation = await reserveRecipe(parsed, r, ctx);
        if ("outcome" in reservation)
          return failure(reservation.outcome, reservation.message, parsed.steps[0]!.stepId);
        receipts.push({ stepId: "recipe-reservation", receipt: reservation.marker });
      }
      if (r.family !== "session") {
        const journal = operation.get("foundry_gm_receipt_read");
        if (!journal)
          return failure(
            "failure",
            "Native recovery lookup unavailable; no action dispatched",
            parsed.steps[0]!.stepId,
          );
        try {
          // Only the exact live process cache can replay a settled workflow result.
          // A retained step without it means recovery, even when a roll left the
          // actor's numeric state unchanged. Do not continue missing later steps.
          for (const step of parsed.steps) {
            const retained = (await journal.handler(
              {
                schemaVersion: parsed.schemaVersion,
                worldId: parsed.worldId,
                userId: parsed.userId,
                sceneId: parsed.sceneId,
                action: { kind: "receipt", idempotencyKey: stepKey(parsed, step.stepId) },
              },
              ctx,
            )) as Record<string, unknown>;
            if (retained["status"] === "reserved" || retained["status"] === "terminal")
              return {
                ...failure(
                  "uncertain",
                  "Earlier native step retained; inspect original receipts and reconcile without automatic continuation",
                  step.stepId,
                ),
                recoveryReceipt: retained,
              };
            if (retained["status"] !== "missing")
              return failure(
                "failure",
                "Invalid native recovery status; no action dispatched",
                step.stepId,
              );
          }
        } catch {
          return failure(
            "failure",
            "Native recovery lookup unavailable; no action dispatched",
            parsed.steps[0]!.stepId,
          );
        }
      }
      for (const [index, step] of parsed.steps.entries()) {
        let dispatched = false;
        try {
          const envelope =
            r.family === "session"
              ? sessionEnvelope(parsed, step.action)
              : { ...firstEnvelope, action: step.action };
          const before = index === 0 ? first : await state.handler(envelope, ctx);
          dispatched = true;
          const raw = (await apply.handler(
            {
              ...envelope,
              expectedState:
                r.family === "session" ? (before as Record<string, unknown>)["state"] : before,
              idempotencyKey: stepKey(parsed, step.stepId),
              correlationId: parsed.correlationId,
            },
            ctx,
          )) as Record<string, unknown>;
          const receipt =
            r.family === "session"
              ? {
                  schemaVersion: parsed.schemaVersion,
                  worldId: raw["worldId"],
                  userId: parsed.userId,
                  sceneId: parsed.sceneId,
                  idempotencyKey: raw["idempotencyKey"],
                  correlationId: raw["correlationId"],
                  before,
                  after: { worldId: raw["worldId"], action: raw["action"], state: raw["state"] },
                  outcome:
                    raw["verified"] === true &&
                    canonical(raw["action"]) === canonical(envelope.action)
                      ? "confirmed"
                      : "uncertain",
                  data: raw,
                }
              : raw;
          receipts.push({ stepId: step.stepId, action: step.action, receipt });
          if (
            receipt["schemaVersion"] !== parsed.schemaVersion ||
            receipt["worldId"] !== parsed.worldId ||
            receipt["userId"] !== parsed.userId ||
            receipt["sceneId"] !== parsed.sceneId ||
            receipt["idempotencyKey"] !== stepKey(parsed, step.stepId) ||
            receipt["correlationId"] !== parsed.correlationId
          )
            return failure(
              "uncertain",
              "Native receipt identity mismatch; reconcile without replay",
              step.stepId,
            );
          if (canonical(receipt["before"]) !== canonical(before))
            return failure(
              "uncertain",
              "Native receipt precondition mismatch; reconcile without replay",
              step.stepId,
            );
          if (receipt["outcome"] === "failure")
            return failure(
              "failure",
              "Native action refused; prior confirmed steps retained",
              step.stepId,
            );
          if (
            receipt["outcome"] !== "confirmed" ||
            !receipt["after"] ||
            typeof receipt["after"] !== "object"
          )
            return failure(
              "uncertain",
              "Native action uncertain; reconcile without replay",
              step.stepId,
            );
          const nativeData = receipt["data"] as Record<string, unknown> | null;
          const readEnvelope =
            r.family === "combat" &&
            step.action["kind"] === "create" &&
            nativeData &&
            typeof nativeData["createdCombatId"] === "string"
              ? { ...envelope, action: { kind: "read", combatId: nativeData["createdCombatId"] } }
              : envelope;
          const after = await state.handler(readEnvelope, ctx);
          if (canonical(after) !== canonical(receipt["after"]))
            return failure(
              "uncertain",
              "Independent native readback changed; reconcile without replay",
              step.stepId,
            );
        } catch {
          return failure(
            dispatched ? "uncertain" : "failure",
            "Native recipe stage unavailable; inspect receipts before continuing",
            step.stepId,
          );
        }
      }
      return {
        schemaVersion: parsed.schemaVersion,
        worldId: parsed.worldId,
        userId: parsed.userId,
        sceneId: parsed.sceneId,
        recipeId: r.id,
        idempotencyKey: parsed.idempotencyKey,
        correlationId: parsed.correlationId,
        outcome: "confirmed",
        receipts,
      };
    })();
    entries.set(key, { fingerprint, result });
    return result;
  }
  async function reserveRecipe(
    input: GmRecipeInput,
    r: GenericGmRecipe,
    ctx: EndpointContext,
  ): Promise<
    { marker: Record<string, unknown> } | { outcome: "failure" | "uncertain"; message: string }
  > {
    const reservationState = operation.get("foundry_gm_scene_state"),
      reservationApply = operation.get("foundry_gm_scene_apply"),
      receiptRead = operation.get("foundry_gm_receipt_read");
    if (!reservationState || !reservationApply || !receiptRead)
      return { outcome: "failure", message: "Native reservation tools unavailable; no dispatch" };
    const reservationFailure = (outcome: "failure" | "uncertain", message: string) => ({
      outcome,
      message,
    });
    const reservationKey = `recipe-reservation-${createHash("sha256")
      .update(canonical([input.worldId, input.userId, input.idempotencyKey]))
      .digest("hex")}`;
    const reservationEnvelope = {
      schemaVersion: input.schemaVersion,
      worldId: input.worldId,
      userId: input.userId,
      sceneId: input.sceneId,
      action: {
        kind: "recipe.reservation",
        recipeId: r.id,
        requestFingerprint: createHash("sha256").update(canonical(input)).digest("hex"),
      },
    };
    try {
      const retained = (await receiptRead.handler(
        receiptRead.inputSchema?.parse({
          ...reservationEnvelope,
          action: { kind: "receipt", idempotencyKey: reservationKey },
        }) ?? {
          ...reservationEnvelope,
          action: { kind: "receipt", idempotencyKey: reservationKey },
        },
        ctx,
      )) as Record<string, unknown>;
      if (retained["status"] !== "missing")
        return reservationFailure(
          "uncertain",
          "Original native recipe reservation exists or cannot be verified; reconcile without replay or continuation",
        );
    } catch {
      return reservationFailure(
        "failure",
        "Native recipe reservation lookup unavailable; no dispatch",
      );
    }
    let reservationDispatched = false;
    try {
      const expectedState = await reservationState.handler(
        reservationState.inputSchema?.parse(reservationEnvelope) ?? reservationEnvelope,
        ctx,
      );
      const args = {
        ...reservationEnvelope,
        expectedState,
        idempotencyKey: reservationKey,
        correlationId: input.correlationId,
      };
      const validatedArgs = reservationApply.inputSchema?.parse(args) ?? args;
      reservationDispatched = true;
      const marker = (await reservationApply.handler(validatedArgs, ctx)) as Record<
        string,
        unknown
      >;
      const markerData = marker["data"] as Record<string, unknown> | null;
      if (markerData?.["reservationAlreadyExists"] === true)
        return reservationFailure(
          "uncertain",
          "Original recipe reservation was admitted elsewhere; inspect retained native evidence without replay or continuation",
        );
      const after = await reservationState.handler(
        reservationState.inputSchema?.parse(reservationEnvelope) ?? reservationEnvelope,
        ctx,
      );
      if (
        marker["outcome"] !== "confirmed" ||
        marker["schemaVersion"] !== input.schemaVersion ||
        marker["worldId"] !== input.worldId ||
        marker["userId"] !== input.userId ||
        marker["sceneId"] !== input.sceneId ||
        marker["idempotencyKey"] !== reservationKey ||
        marker["correlationId"] !== input.correlationId ||
        markerData?.["reservationOnly"] !== true ||
        canonical(marker["before"]) !== canonical(expectedState) ||
        canonical(marker["after"]) !== canonical(after)
      )
        return reservationFailure(
          "uncertain",
          "Native recipe reservation identity/readback unverified; no gameplay dispatch",
        );
      return { marker };
    } catch {
      return reservationFailure(
        reservationDispatched ? "uncertain" : "failure",
        "Native recipe reservation unavailable; no gameplay dispatch",
      );
    }
  }
  async function invokeSpecialized(
    input: GmRecipeInput,
    r: GenericGmRecipe,
    ctx: EndpointContext,
  ): Promise<unknown> {
    const state = operation.get(r.requiredTools[0]!),
      apply = r.family === "tv" ? state : operation.get(r.requiredTools[1]!);
    if (!state || !apply) throw Error("Required native recipe tools unavailable");
    const actions = input.steps.map((step) =>
      r.family === "tv"
        ? recipeTvAction.parse(step.action)
        : recipeDocumentAction.parse(step.action),
    );
    if (
      r.family === "tv" &&
      actions.some(
        (a) =>
          a["tvUserId"] !== actions[0]!["tvUserId"] ||
          a["tvClientId"] !== actions[0]!["tvClientId"],
      )
    )
      throw Error("TV recipe must target one exact client");
    const readArgs = (a: Record<string, unknown>): Record<string, unknown> => {
      if (r.family === "tv")
        return {
          version: "tv-controls-v1",
          worldId: input.worldId,
          requestingUserId: input.userId,
          sceneId: input.sceneId,
          tvUserId: a["tvUserId"],
          tvClientId: a["tvClientId"],
          action: "inspect",
        };
      validateRecipeDocumentScope(input, a);
      return {
        worldId: input.worldId,
        requestingUserId: input.userId,
        family: a["family"],
        ...(a["parentId"] !== undefined ? { parentId: a["parentId"] } : {}),
        ...(a["targetId"] !== undefined ? { targetId: a["targetId"] } : {}),
        operation: a["operation"] === "list" ? "list" : "get",
        ...(a["operation"] === "list"
          ? {
              ...(a["offset"] !== undefined ? { offset: a["offset"] } : {}),
              ...(a["limit"] !== undefined ? { limit: a["limit"] } : {}),
            }
          : {}),
      };
    };
    for (const a of actions) {
      if (
        r.family === "document" &&
        a["operation"] === "update" &&
        unsafeRecipeDocumentData(a["data"])
      )
        throw Error("Executable/security/ownership document fields are unsupported");
      if (
        r.family === "document" &&
        a["operation"] === "update" &&
        a["family"] === "scene-tokens" &&
        unsafeRecipeTokenCoordinates(a["data"])
      )
        throw Error(
          "Token movement/elevation requires the native scoped scene recipe, not a document update",
        );
      state.inputSchema?.parse(readArgs(a));
      if (r.family === "tv" && a["action"] !== "inspect")
        apply.inputSchema?.parse({
          ...readArgs(a),
          ...a,
          expectedState: recipeCameraState.parse(
            input.expectedInitialState["camera"] ?? input.expectedInitialState,
          ),
          idempotencyKey: "recipe-prevalidation",
        });
      if (r.family === "document" && a["operation"] === "update")
        apply.inputSchema?.parse({
          ...readArgs(a),
          operation: "update",
          data: a["data"],
          expectedRevision: "0".repeat(64),
          idempotencyKey: "recipe-prevalidation",
          correlationId: input.correlationId,
        });
    }
    const firstRaw = (await state.handler(readArgs(actions[0]!), ctx)) as Record<string, unknown>;
    const project = (raw: Record<string, unknown>): Record<string, unknown> =>
      r.family === "tv"
        ? recipeCameraState.parse(raw["camera"] ?? raw)
        : projectRecipeDocument(raw);
    const first = project(firstRaw);
    let entries = cache.get(ctx.foundryClient);
    if (!entries) {
      entries = new Map();
      cache.set(ctx.foundryClient, entries);
    }
    const key = canonical([input.worldId, input.userId, input.idempotencyKey]),
      fingerprint = canonical(input),
      prior = entries.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw Error("Changed recipe arguments under reused ID");
      return prior.result;
    }
    if (entries.size >= 4096) throw Error("Recipe receipt capacity reached");
    const result = (async () => {
      const receipts: unknown[] = [];
      const response = (outcome: "confirmed" | "failure" | "uncertain", message?: string) => ({
        schemaVersion: input.schemaVersion,
        worldId: input.worldId,
        userId: input.userId,
        sceneId: input.sceneId,
        recipeId: r.id,
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId,
        outcome,
        receipts,
        ...(message ? { message } : {}),
      });
      if (canonical(first) !== canonical(project(input.expectedInitialState)))
        return response("failure", "Initial recipe state changed; inspect before new intent");
      const reservation = await reserveRecipe(input, r, ctx);
      if ("outcome" in reservation) return response(reservation.outcome, reservation.message);
      receipts.push({ stepId: "recipe-reservation", receipt: reservation.marker });
      for (const [index, action] of actions.entries()) {
        const step = input.steps[index]!;
        let dispatched = false;
        try {
          const currentRaw =
              index === 0
                ? firstRaw
                : ((await state.handler(readArgs(action), ctx)) as Record<string, unknown>),
            before = project(currentRaw);
          if (currentRaw["worldId"] !== input.worldId)
            return response("failure", "Native current world mismatch");
          if (r.family === "tv" && !recipeTvScope(currentRaw, input, action))
            return response("failure", "Exact TV inspection authority mismatch");
          if (
            r.family === "document" &&
            (currentRaw["family"] !== action["family"] ||
              currentRaw["parentId"] !== action["parentId"] ||
              (action["operation"] !== "list" && currentRaw["targetId"] !== action["targetId"]))
          )
            return response("failure", "Exact native document scope mismatch");
          const readonly =
            r.family === "tv" ? action["action"] === "inspect" : action["operation"] !== "update";
          if (readonly) {
            receipts.push({
              stepId: step.stepId,
              action,
              receipt: {
                before,
                after: before,
                outcome: "confirmed",
                data: currentRaw,
                idempotencyKey: stepKey(input, step.stepId),
              },
            });
            continue;
          }
          const args =
            r.family === "tv"
              ? {
                  ...readArgs(action),
                  ...action,
                  expectedState: before,
                  idempotencyKey: stepKey(input, step.stepId),
                }
              : {
                  ...readArgs(action),
                  operation: "update",
                  data: action["data"],
                  expectedRevision: currentRaw["revision"],
                  idempotencyKey: stepKey(input, step.stepId),
                  correlationId: input.correlationId,
                };
          if (r.family === "document" && !/^[a-f0-9]{64}$/.test(String(currentRaw["revision"])))
            return response("failure", "Latest exact document revision is unavailable");
          dispatched = true;
          const raw = (await apply.handler(apply.inputSchema?.parse(args) ?? args, ctx)) as Record<
            string,
            unknown
          >;
          const observed = (await state.handler(readArgs(action), ctx)) as Record<string, unknown>,
            after = project(raw);
          receipts.push({
            stepId: step.stepId,
            action,
            receipt: {
              before,
              after,
              outcome: "confirmed",
              data: raw,
              idempotencyKey: stepKey(input, step.stepId),
            },
          });
          if (r.family === "tv") {
            if (
              !recipeTvScope(raw, input, action) ||
              !recipeTvScope(observed, input, action) ||
              raw["action"] !== action["action"] ||
              !recipeTvVisibility(raw) ||
              !recipeTvVisibility(observed)
            )
              return response(
                "uncertain",
                "Exact TV authority/visibility receipt mismatch; reconcile without replay",
              );
          } else if (
            raw["worldId"] !== input.worldId ||
            raw["family"] !== action["family"] ||
            raw["targetId"] !== action["targetId"] ||
            raw["parentId"] !== action["parentId"] ||
            raw["verified"] !== true ||
            raw["idempotencyKey"] !== stepKey(input, step.stepId) ||
            raw["correlationId"] !== input.correlationId
          )
            return response(
              "uncertain",
              "Exact document receipt mismatch; reconcile without replay",
            );
          if (canonical(project(observed)) !== canonical(after))
            return response(
              "uncertain",
              "Independent native recipe readback mismatch; reconcile without replay",
            );
        } catch {
          return response(
            dispatched ? "uncertain" : "failure",
            "Native recipe stage unavailable; inspect receipts before continuing",
          );
        }
      }
      return response("confirmed");
    })();
    entries.set(key, { fingerprint, result });
    return result;
  }
  return [
    {
      name: "foundry_gm_recipe_list",
      method: "get",
      path: "/gm/recipes",
      inputSchema: z.object({}).strict(),
      description:
        "Lookup required: bounded catalog of native GM workflows with exact required generic MCP tools. Catalog is public metadata; execution is native-authorized GM only.",
      annotations: { readOnlyHint: true },
      handler: () => ({ version: "gm-recipes-v1", recipes: GM_GENERIC_RECIPES.map(summary) }),
    },
    {
      name: "foundry_gm_recipe_search",
      method: "post",
      path: "/gm/recipes/search",
      inputSchema: query,
      description:
        "Lookup required: search bounded GM recipe purpose and triggers before gameplay.",
      annotations: { readOnlyHint: true },
      handler: (input: z.infer<typeof query>) => ({
        recipes: GM_GENERIC_RECIPES.filter((r) =>
          `${r.id} ${r.purpose} ${r.triggers.join(" ")}`
            .toLowerCase()
            .includes(input.query.toLowerCase()),
        )
          .slice(0, input.limit)
          .map(summary),
      }),
    },
    {
      name: "foundry_gm_recipe_read",
      method: "post",
      path: "/gm/recipes/read",
      inputSchema: z.object({ recipeId: id }).strict(),
      description:
        "Lookup required: read full purpose, triggers, tools, parameters, preconditions, verification, permissions, recovery and compatibility.",
      annotations: { readOnlyHint: true },
      handler: ({ recipeId }: { recipeId: string }) => {
        const r = lookup(recipeId);
        return { ...r, ...summary(r) };
      },
    },
    {
      name: "foundry_gm_recipe_invoke",
      method: "post",
      path: "/gm/recipes/invoke",
      inputSchema: gmRecipeInvokeSchema,
      description:
        "Explicit GM-only bounded native workflow. Lookup/read recipe first. Stable per-step IDs, fresh preconditions and independent readback; first failure stops; uncertain dispatch is never retried automatically. Native durable journal remains authoritative after reconnect/restart.",
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
      handler: invoke,
    },
  ];
}
function stepKey(input: GmRecipeInput, stepId: string): string {
  return `recipe-${createHash("sha256")
    .update(canonical([input.worldId, input.userId, input.idempotencyKey, stepId]))
    .digest("hex")}`;
}
function sessionEnvelope(input: GmRecipeInput, action: Record<string, unknown>) {
  if (action["sceneId"] !== undefined && action["sceneId"] !== input.sceneId)
    throw Error("Session action scene mismatch");
  return {
    worldId: input.worldId,
    requestingUserId: input.userId,
    action: { ...action, sceneId: input.sceneId },
  };
}
const recipeCamera = z
  .object({
    x: z.number().finite().min(-1e7).max(1e7),
    y: z.number().finite().min(-1e7).max(1e7),
    scale: z.number().finite().min(0.1).max(3),
  })
  .strict();
const recipeCameraState = recipeCamera.extend({ sceneId: id });
const tvId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const tvActionScope = { tvUserId: tvId, tvClientId: tvId };
const recipeTvAction = z
  .discriminatedUnion("action", [
    z.object({ ...tvActionScope, action: z.literal("inspect") }).strict(),
    z.object({ ...tvActionScope, action: z.literal("unionVision") }).strict(),
    z.object({ ...tvActionScope, action: z.literal("camera"), camera: recipeCamera }).strict(),
    z
      .object({
        ...tvActionScope,
        action: z.literal("calibrate"),
        calibration: z
          .object({
            measuredPixels: z.number().finite().min(1).max(10000),
            measuredInches: z.number().finite().min(0.01).max(200),
            gridInches: z.number().finite().min(0.1).max(10),
            rulerConfirmed: z.literal(true),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...tvActionScope,
        action: z.literal("perspective"),
        perspective: z.literal("native-top-down"),
      })
      .strict(),
  ])
  .transform((a) => a as Record<string, unknown>);
const recipeDocumentFamily = z.enum([
  "actors",
  "items",
  "journals",
  "scenes",
  "journal-pages",
  "actor-items",
  "actor-effects",
  "item-effects",
  "scene-tokens",
  "scene-walls",
  "scene-drawings",
  "scene-notes",
  "scene-lights",
  "scene-sounds",
  "scene-templates",
  "scene-regions",
]);
const recipeDocumentScope = { family: recipeDocumentFamily, parentId: id.optional() };
const recipeDocumentAction = z
  .discriminatedUnion("operation", [
    z.object({ ...recipeDocumentScope, operation: z.literal("get"), targetId: id }).strict(),
    z
      .object({
        ...recipeDocumentScope,
        operation: z.literal("list"),
        offset: z.number().int().min(0).max(100000).optional(),
        limit: z.number().int().min(1).max(20).optional(),
      })
      .strict(),
    z
      .object({
        ...recipeDocumentScope,
        operation: z.literal("update"),
        targetId: id,
        data: record,
      })
      .strict(),
  ])
  .transform((a) => a as Record<string, unknown>);
function validateRecipeDocumentScope(input: GmRecipeInput, action: Record<string, unknown>): void {
  const family = String(action["family"]);
  if (
    (family.startsWith("scene-") && action["parentId"] !== input.sceneId) ||
    (family === "scenes" && action["operation"] !== "list" && action["targetId"] !== input.sceneId)
  )
    throw Error("Document recipe scene mismatch");
}
function projectRecipeDocument(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    ["worldId", "family", "targetId", "parentId", "source", "revision", "documents", "nextOffset"]
      .filter((k) => raw[k] !== undefined)
      .map((k) => [k, raw[k]]),
  );
}
function unsafeRecipeDocumentData(v: unknown): boolean {
  return Array.isArray(v)
    ? v.some(unsafeRecipeDocumentData)
    : !!v &&
        typeof v === "object" &&
        Object.entries(v).some(
          ([k, value]) =>
            /(?:^|\.)(ownership|permission|permissions|script|scripts|command|commands|flags|behaviors|type|src|items|effects|tokens|walls|pages|regions)(?:\.|$)/i.test(
              k,
            ) || unsafeRecipeDocumentData(value),
        );
}
function unsafeRecipeTokenCoordinates(v: unknown): boolean {
  return (
    !!v &&
    typeof v === "object" &&
    Object.keys(v).some((k) => /^(?:x|y|elevation)(?:\.|$)/i.test(k))
  );
}
function recipeTvVisibility(raw: Record<string, unknown>): boolean {
  const vision = raw["vision"] as Record<string, unknown> | null,
    calibration = raw["calibration"] as Record<string, unknown> | null;
  return (
    vision?.["mode"] === "native-pc-union" &&
    vision["status"] === "verified" &&
    Number(vision["sourceCount"]) > 0 &&
    vision["permissionsChanged"] === false &&
    vision["nativeWallsFogDetection"] === true &&
    calibration?.["physicalVerified"] === false &&
    calibration["rulerAcceptanceRequired"] === true
  );
}
function recipeTvScope(
  raw: Record<string, unknown>,
  input: GmRecipeInput,
  action: Record<string, unknown>,
): boolean {
  const camera = raw["camera"] as Record<string, unknown> | null,
    vision = raw["vision"] as Record<string, unknown> | null;
  return (
    raw["version"] === "tv-controls-v1" &&
    raw["worldId"] === input.worldId &&
    raw["requestingUserId"] === input.userId &&
    raw["tvUserId"] === action["tvUserId"] &&
    raw["tvClientId"] === action["tvClientId"] &&
    camera?.["sceneId"] === input.sceneId &&
    vision?.["mode"] === "native-pc-union" &&
    vision["permissionsChanged"] === false &&
    vision["nativeWallsFogDetection"] === true
  );
}
