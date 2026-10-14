import {
  ProtocolError,
  type NativeGmInput,
  type NativeGmApplyInput,
  type NativeGmReceipt,
} from "@foundry-local-api/shared";
import { inWorldMutationLane } from "../world-mutation-lane.js";

type Doc = FoundryDocument & {
  actor?: Doc;
  getEmbeddedCollection(name: string): Map<string, Doc>;
  system: Record<string, any>;
  items: Map<string, Doc>;
};
const MODULE = "foundry-local-api";
const FLAG = "nativeGmReceipts";
const MAX_ENTRIES = 500;
type Entry = { fingerprint: string; status: "reserved" | "terminal"; receipt?: NativeGmReceipt };
const object = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
function canonical(value: unknown): string {
  const visit = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(visit)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([, x]) => x !== undefined)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, visit(x)]),
          )
        : v;
  return JSON.stringify(visit(value));
}
const bounded = (value: unknown): string => {
  const result = canonical(value);
  if (!result || new TextEncoder().encode(result).byteLength > 128_000)
    throw Error("Native operation exceeds bounded state size");
  return result;
};
export function authorizeNative(input: NativeGmInput): void {
  if (
    !input ||
    input.schemaVersion !== "gm-actions-v1" ||
    input.worldId !== game.world.id ||
    input.userId !== game.user.id ||
    !game.user.active ||
    !game.user.isGM ||
    !game.users.get(input.userId)?.active ||
    !game.users.get(input.userId)?.isGM
  )
    throw Error("Exact active native GM and world required");
  if (
    game.release.version !== "14.368" ||
    game.system.id !== "dnd5e" ||
    game.system.version !== "6.0.3"
  )
    throw Error("Native GM operations require reviewed Foundry 14.368 / dnd5e 6.0.3");
  if (
    ![input.worldId, input.userId, input.sceneId].every(
      (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v),
    )
  )
    throw Error("Invalid native world/user/scene scope");
  bounded(input.action);
  nativeScene(input);
}
export function nativeScene(input: NativeGmInput): Doc {
  const scene = game.collections.get("Scene")?.get(input.sceneId) as Doc | undefined;
  if (!scene || scene.toObject()["active"] !== true || canvas?.scene?.id !== input.sceneId)
    throw Error("Exact current active rendered scene required");
  return scene;
}
export function nativeToken(input: NativeGmInput, tokenId: string): Doc {
  const token = nativeScene(input).getEmbeddedCollection("Token").get(tokenId);
  if (!token) throw Error("Token missing from exact current scene");
  return token;
}
export function nativeActor(input: NativeGmInput, tokenId: string, actorId?: string): Doc {
  const actor = nativeToken(input, tokenId).actor;
  if (!actor || (actorId !== undefined && actor.id !== actorId))
    throw Error("Exact placed actor binding required");
  return actor;
}
function privateLedger(doc: FoundryDocument): void {
  const data = doc.toObject();
  const ownership = object(data["ownership"]);
  if (
    ownership["default"] !== 0 ||
    Object.entries(ownership).some(
      ([id, level]) => id !== "default" && level !== 0 && !game.users.get(id)?.isGM,
    )
  )
    throw Error("Native receipt journal privacy unsafe");
  if (object(object(data["flags"])[MODULE])["nativeGmVersion"] !== "gm-actions-v1")
    throw Error("Native ledger version invalid");
}
async function ledger(
  input: NativeGmInput,
): Promise<{ doc: FoundryDocument; entries: Record<string, Entry> }> {
  authorizeNative(input);
  const collection = game.collections.get("JournalEntry");
  const docs = collection
    ? [...collection.values()].filter(
        (doc) =>
          object(object(doc.toObject()["flags"])[MODULE])["nativeGmVersion"] === "gm-actions-v1",
      )
    : [];
  if (docs.length > 1) throw Error("Ambiguous native receipt journals");
  let doc = docs[0];
  if (!doc)
    doc = await CONFIG["JournalEntry"]?.documentClass.create({
      name: "Foundry Local API Native GM Receipts",
      ownership: { default: 0 },
      flags: { [MODULE]: { nativeGmVersion: "gm-actions-v1", [FLAG]: {} } },
    });
  authorizeNative(input);
  if (!doc) throw Error("Durable native receipts unavailable");
  privateLedger(doc);
  const raw = object(object(doc.toObject()["flags"])[MODULE])[FLAG];
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw Error("Native receipt ledger corrupt");
  const entries = structuredClone(raw) as Record<string, Entry>;
  if (
    Object.values(entries).some(
      (e) =>
        !e ||
        typeof e.fingerprint !== "string" ||
        !["reserved", "terminal"].includes(e.status) ||
        (e.status === "terminal" &&
          (!e.receipt || !["confirmed", "uncertain", "failure"].includes(e.receipt.outcome))),
    )
  )
    throw Error("Native receipt ledger invalid");
  for (const [key, entry] of Object.entries(entries)) validateEntry(key, entry);
  return { doc, entries };
}
async function save(
  input: NativeGmApplyInput,
  doc: FoundryDocument,
  entries: Record<string, Entry>,
): Promise<void> {
  authorizeNative(input);
  privateLedger(doc);
  const encoded = canonical(entries);
  if (new TextEncoder().encode(encoded).byteLength > 2_000_000)
    throw Error("Native receipt ledger capacity exceeded");
  await doc.update(
    { [`flags.${MODULE}.${FLAG}`]: JSON.parse(encoded) },
    {
      foundryLocalApiOrigin: {
        source: "foundry-local-api.native-gm",
        phase: "receipt",
        correlationId: input.correlationId,
      },
    },
  );
  authorizeNative(input);
  privateLedger(doc);
  if (canonical(object(object(doc.toObject()["flags"])[MODULE])[FLAG]) !== encoded)
    throw Error("Native receipt persistence acknowledgement unavailable");
}
/** Reserve before any effect; a persisted unfinished reservation never authorizes replay. */
export async function runNativeMutation(
  input: NativeGmApplyInput,
  read: () => Record<string, unknown> | Promise<Record<string, unknown>>,
  apply: () => Promise<unknown>,
  preflight?: () => void | Promise<void>,
): Promise<NativeGmReceipt> {
  // Reading a prior durable receipt must remain possible behind a mutation fence.
  authorizeNative(input);
  const priorDocs = [...(game.collections.get("JournalEntry")?.values() ?? [])].filter(
    (doc) => object(object(doc.toObject()["flags"])[MODULE])["nativeGmVersion"] === "gm-actions-v1",
  );
  if (priorDocs.length > 1) throw Error("Ambiguous native receipt journals");
  const priorDoc = priorDocs[0];
  if (priorDoc) {
    privateLedger(priorDoc);
    const priorEntries = object(object(object(priorDoc.toObject()["flags"])[MODULE])[FLAG]);
    if (Object.hasOwn(priorEntries, input.idempotencyKey)) {
      const prior = priorEntries[input.idempotencyKey] as Entry;
      if (prior.fingerprint !== bounded(input))
        throw Error("Idempotency key reused with different action/scope/preconditions");
      if (prior.status === "reserved")
        return receipt(
          input,
          "uncertain",
          input.expectedState,
          null,
          null,
          "Unfinished durable reservation; inspect current native effects without replay",
        );
      const result = prior.receipt;
      if (
        prior.status !== "terminal" ||
        !result ||
        result.schemaVersion !== input.schemaVersion ||
        result.worldId !== input.worldId ||
        result.userId !== input.userId ||
        result.sceneId !== input.sceneId ||
        result.idempotencyKey !== input.idempotencyKey ||
        result.correlationId !== input.correlationId ||
        canonical(result.action) !== canonical(input.action) ||
        canonical(result.before) !== canonical(input.expectedState) ||
        !["confirmed", "failure", "uncertain"].includes(result.outcome) ||
        !result.before ||
        Array.isArray(result.before) ||
        (result.outcome === "confirmed" &&
          (!result.after || typeof result.after !== "object" || Array.isArray(result.after)))
      )
        throw Error("Native stored receipt scope or evidence corrupt");
      return replayReceipt(input, result);
    }
  }
  return inWorldMutationLane(game, async () => {
    authorizeNative(input);
    if (
      ![input.idempotencyKey, input.correlationId].every(
        (v) =>
          typeof v === "string" &&
          /^[A-Za-z0-9_.:-]{1,128}$/.test(v) &&
          !["__proto__", "constructor", "prototype"].includes(v),
      )
    )
      throw Error("Bounded safe idempotency and correlation IDs required");
    bounded(input.expectedState);
    const fingerprint = bounded(input);
    const { doc, entries } = await ledger(input);
    const existing = Object.hasOwn(entries, input.idempotencyKey)
      ? entries[input.idempotencyKey]
      : undefined;
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw Error("Idempotency key reused with different action/scope/preconditions");
      if (existing.status === "terminal" && existing.receipt) {
        const result = existing.receipt;
        if (
          result.schemaVersion !== input.schemaVersion ||
          result.worldId !== input.worldId ||
          result.userId !== input.userId ||
          result.sceneId !== input.sceneId ||
          result.idempotencyKey !== input.idempotencyKey ||
          result.correlationId !== input.correlationId ||
          canonical(result.action) !== canonical(input.action) ||
          canonical(result.before) !== canonical(input.expectedState) ||
          !result.before ||
          typeof result.before !== "object" ||
          Array.isArray(result.before) ||
          (result.outcome === "confirmed" &&
            (!result.after || typeof result.after !== "object" || Array.isArray(result.after)))
        )
          throw Error("Native stored receipt scope or evidence corrupt");
        return replayReceipt(input, result);
      }
      return receipt(
        input,
        "uncertain",
        {},
        null,
        null,
        "Unfinished durable reservation; reconcile native effects before any new intent",
      );
    }
    if (
      Object.values(entries).some(
        (entry) => entry.status === "reserved" || entry.receipt?.outcome === "uncertain",
      )
    )
      throw Error(
        "Prior native reservation or result is uncertain; reconcile durable journal before a new intent",
      );
    if (Object.keys(entries).length >= MAX_ENTRIES)
      throw Error("Native receipt capacity reached; retain and reconcile receipts before archive");
    const before = JSON.parse(bounded(await read())) as Record<string, unknown>;
    authorizeNative(input);
    if (canonical(before) !== canonical(input.expectedState))
      throw new ProtocolError({
        code: "STALE_REVISION",
        message: "Native expected state changed; reread and obtain a new scoped decision",
        retryable: false,
        details: {
          nativeGmPreflight: "before-reservation-v1",
          gameplayDispatched: false,
          schemaVersion: input.schemaVersion,
          worldId: input.worldId,
          userId: input.userId,
          sceneId: input.sceneId,
          idempotencyKey: input.idempotencyKey,
          correlationId: input.correlationId,
        },
      });
    try {
      await preflight?.();
    } catch {
      return receipt(
        input,
        "failure",
        before,
        null,
        { decisionRequired: true },
        "Native preflight refused before gameplay reservation; resolve choices with the human GM and read current state",
      );
    }
    authorizeNative(input);
    entries[input.idempotencyKey] = { fingerprint, status: "reserved" };
    await save(input, doc, entries);
    // Reservation creation is itself a mutation. Re-read immediately before gameplay dispatch.
    authorizeNative(input);
    const fresh = await read();
    if (canonical(fresh) !== canonical(before)) {
      const result = receipt(
        input,
        "failure",
        before,
        null,
        null,
        "Native state changed after reservation; no gameplay effect dispatched",
      );
      entries[input.idempotencyKey] = { fingerprint, status: "terminal", receipt: result };
      await save(input, doc, entries);
      return result;
    }
    let result: NativeGmReceipt;
    try {
      authorizeNative(input);
      const data = await apply();
      authorizeNative(input);
      const after = JSON.parse(bounded(await read())) as Record<string, unknown>;
      const safeData = data === undefined ? null : JSON.parse(bounded(data));
      result = receipt(input, "confirmed", before, after, safeData);
    } catch {
      result = receipt(
        input,
        "uncertain",
        before,
        null,
        null,
        "Native dispatch or verification incomplete; inspect current documents, never reroll or spend again",
      );
    }
    entries[input.idempotencyKey] = { fingerprint, status: "terminal", receipt: result };
    try {
      await save(input, doc, entries);
    } catch {
      return receipt(
        input,
        "uncertain",
        before,
        null,
        null,
        "Native result persistence uncertain; durable reservation retained, do not replay",
      );
    }
    return result;
  });
}
/** Workflow markers grant admission once; retained receipts remain readable evidence. */
function replayReceipt(input: NativeGmApplyInput, result: NativeGmReceipt): NativeGmReceipt {
  if (input.action["kind"] === "recipe.reservation")
    return receipt(
      input,
      "failure",
      structuredClone(result.before),
      null,
      { reservationAlreadyExists: true },
      "Recipe reservation already exists; inspect retained receipt and reconcile without dispatching steps",
    );
  return structuredClone(result);
}
function receipt(
  input: NativeGmApplyInput,
  outcome: NativeGmReceipt["outcome"],
  before: Record<string, unknown>,
  after: Record<string, unknown> | null,
  data: unknown,
  message?: string,
): NativeGmReceipt {
  return {
    action: structuredClone(input.action),
    schemaVersion: "gm-actions-v1",
    worldId: input.worldId,
    userId: input.userId,
    sceneId: input.sceneId,
    idempotencyKey: input.idempotencyKey,
    correlationId: input.correlationId,
    outcome,
    before,
    after,
    data,
    ...(message ? { message } : {}),
  };
}
export async function readNativeReceipt(
  input: NativeGmInput,
  key: string,
): Promise<NativeGmReceipt | null> {
  authorizeNative(input);
  const docs = [...(game.collections.get("JournalEntry")?.values() ?? [])].filter(
    (doc) => object(object(doc.toObject()["flags"])[MODULE])["nativeGmVersion"] === "gm-actions-v1",
  );
  if (docs.length > 1) throw Error("Ambiguous native receipt journal");
  const doc = docs[0];
  if (!doc) return null;
  privateLedger(doc);
  const entries = object(object(object(doc.toObject()["flags"])[MODULE])[FLAG]);
  if (!Object.hasOwn(entries, key)) return null;
  const entry = entries[key] as Entry;
  if (entry.status !== "terminal" || !entry.receipt || entry.receipt.outcome !== "confirmed")
    return null;
  return verifyStoredNativeReceipt(input, key, entry);
}
export function verifyStoredNativeReceipt(
  input: NativeGmInput,
  key: string,
  raw: unknown,
): NativeGmReceipt {
  authorizeNative(input);
  const entry = object(raw);
  validateEntry(key, entry);
  if (entry["status"] !== "terminal" || typeof entry["fingerprint"] !== "string")
    throw Error("Stored native receipt invalid");
  const request = object(JSON.parse(entry["fingerprint"]));
  const result = entry["receipt"] as NativeGmReceipt | undefined;
  if (
    !result ||
    request["schemaVersion"] !== "gm-actions-v1" ||
    request["worldId"] !== input.worldId ||
    request["userId"] !== input.userId ||
    request["sceneId"] !== input.sceneId ||
    request["idempotencyKey"] !== key ||
    result.schemaVersion !== request["schemaVersion"] ||
    result.worldId !== request["worldId"] ||
    result.userId !== request["userId"] ||
    result.sceneId !== request["sceneId"] ||
    result.idempotencyKey !== key ||
    result.correlationId !== request["correlationId"] ||
    canonical(result.action) !== canonical(request["action"]) ||
    canonical(result.before) !== canonical(request["expectedState"]) ||
    !["confirmed", "failure", "uncertain"].includes(result.outcome) ||
    !result.before ||
    typeof result.before !== "object" ||
    Array.isArray(result.before) ||
    (result.outcome === "confirmed" &&
      (!result.after || typeof result.after !== "object" || Array.isArray(result.after)))
  )
    throw Error("Stored native receipt scope or evidence invalid");
  return structuredClone(result);
}
function validateEntry(key: string, raw: unknown): void {
  const entry = object(raw);
  let request: Record<string, any>;
  try {
    request = object(JSON.parse(String(entry["fingerprint"])));
  } catch {
    throw Error("Native receipt ledger invalid or uncertain");
  }
  if (
    request["schemaVersion"] !== "gm-actions-v1" ||
    request["idempotencyKey"] !== key ||
    ![request["worldId"], request["userId"], request["sceneId"]].every(
      (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v),
    ) ||
    typeof request["correlationId"] !== "string" ||
    !request["action"] ||
    typeof request["action"] !== "object" ||
    Array.isArray(request["action"]) ||
    !request["expectedState"] ||
    typeof request["expectedState"] !== "object" ||
    Array.isArray(request["expectedState"]) ||
    !["reserved", "terminal"].includes(String(entry["status"]))
  )
    throw Error("Native receipt ledger invalid or uncertain");
  if (entry["status"] === "reserved") return;
  const r = entry["receipt"] as NativeGmReceipt | undefined;
  if (
    !r ||
    r.schemaVersion !== request["schemaVersion"] ||
    r.worldId !== request["worldId"] ||
    r.userId !== request["userId"] ||
    r.sceneId !== request["sceneId"] ||
    r.idempotencyKey !== key ||
    r.correlationId !== request["correlationId"] ||
    canonical(r.action) !== canonical(request["action"]) ||
    canonical(r.before) !== canonical(request["expectedState"]) ||
    !["confirmed", "failure", "uncertain"].includes(r.outcome) ||
    (r.outcome === "confirmed" &&
      (!r.after || typeof r.after !== "object" || Array.isArray(r.after)))
  )
    throw Error("Native receipt ledger provenance invalid");
}
