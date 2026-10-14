import type { NativeGmInput } from "@foundry-local-api/shared";
import { registerCommand } from "../command-registry.js";
import { authorizeNative, verifyStoredNativeReceipt } from "./native-gm-runtime.js";
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
export function inspectGmReceipt(input: NativeGmInput): Record<string, unknown> {
  authorizeNative(input);
  const key = input.action["idempotencyKey"];
  if (
    input.action["kind"] !== "receipt" ||
    typeof key !== "string" ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(key) ||
    Object.keys(input.action).some((k) => !["kind", "idempotencyKey"].includes(k))
  )
    throw Error("Bounded exact receipt lookup required");
  const docs = [...(game.collections.get("JournalEntry")?.values() ?? [])].filter(
    (doc) =>
      object(object(doc.toObject()["flags"])["foundry-local-api"])["nativeGmVersion"] ===
      "gm-actions-v1",
  );
  if (docs.length > 1) throw Error("Ambiguous native receipt journals");
  const doc = docs[0];
  if (!doc) return { status: "missing", idempotencyKey: key };
  const ownership = object(doc.toObject()["ownership"]);
  if (
    ownership["default"] !== 0 ||
    Object.entries(ownership).some(
      ([id, level]) => id !== "default" && level !== 0 && !game.users.get(id)?.isGM,
    )
  )
    throw Error("Receipt privacy unsafe");
  const entries = object(
    object(object(doc.toObject()["flags"])["foundry-local-api"])["nativeGmReceipts"],
  );
  if (!Object.hasOwn(entries, key)) return { status: "missing", idempotencyKey: key };
  const entry = object(entries[key]);
  if (typeof entry["fingerprint"] !== "string") throw Error("Receipt fingerprint invalid");
  const fingerprint = object(JSON.parse(entry["fingerprint"]));
  if (
    fingerprint["worldId"] !== input.worldId ||
    fingerprint["userId"] !== input.userId ||
    fingerprint["sceneId"] !== input.sceneId ||
    fingerprint["idempotencyKey"] !== key
  )
    throw Error("Receipt scope mismatch");
  if (entry["status"] === "reserved")
    return {
      status: "reserved",
      idempotencyKey: key,
      outcome: "uncertain",
      action: fingerprint["action"],
      correlationId: fingerprint["correlationId"],
    };
  const receipt = object(entry["receipt"]);
  if (
    entry["status"] !== "terminal" ||
    receipt["worldId"] !== input.worldId ||
    receipt["userId"] !== input.userId ||
    receipt["sceneId"] !== input.sceneId ||
    receipt["idempotencyKey"] !== key ||
    !["confirmed", "failure", "uncertain"].includes(String(receipt["outcome"]))
  )
    throw Error("Stored receipt invalid");
  return { status: "terminal", receipt: verifyStoredNativeReceipt(input, key, entry) };
}
registerCommand("gmReceiptRead", inspectGmReceipt);
