import type { NativeGmInput, NativeGmApplyInput } from "./native-gm.js";

export const GM_CHARACTER_COMMANDS = {
  READ: "gmCharacterRead",
  APPLY: "gmCharacterApply",
} as const;
export type GmCharacterInput = NativeGmInput;
export type GmCharacterApplyInput = NativeGmApplyInput;

/** Shared validation is used on both REST/MCP and native bridge dispatch. */
export function validateGmCharacterAction(action: Record<string, unknown>, applying = false): void {
  const layouts: Record<string, string[]> = {
    "party.roster": [],
    "actor.state": ["tokenId", "actorId"],
    "actor.damage": ["tokenId", "actorId", "components", "multiplier", "sourceMessageId"],
    "actor.check": [
      "tokenId",
      "actorId",
      "check",
      "key",
      "dc",
      "rollMode",
      "advantageMode",
      "ability",
    ],
    "actor.condition": ["tokenId", "actorId", "conditionId", "active"],
    "actor.exhaustion": ["tokenId", "actorId", "level"],
    "actor.concentration.end": ["tokenId", "actorId", "effectId"],
    "actor.stabilize": ["tokenId", "actorId", "rulingConfirmed"],
    "actor.rest": ["tokenId", "actorId", "restType", "eligibilityConfirmed"],
    "actor.hitDie": ["tokenId", "actorId", "denomination", "rollMode"],
    "actor.item.equip": ["tokenId", "actorId", "itemId", "equipped"],
    "actor.item.attune": ["tokenId", "actorId", "itemId", "attuned", "eligibilityConfirmed"],
    "actor.item.remove": ["tokenId", "actorId", "itemId"],
    "actor.item.quantity": ["tokenId", "actorId", "itemId", "quantity"],
    "actor.item.grant": ["tokenId", "actorId", "sourceItemId", "grantItemId", "quantity"],
    "actor.item.copy": [
      "tokenId",
      "actorId",
      "sourceTokenId",
      "sourceItemId",
      "grantItemId",
      "quantity",
    ],
    "actor.xp": ["tokenId", "actorId", "value"],
    "actor.hp.tempmax": ["tokenId", "actorId", "value"],
    "actor.currency": ["tokenId", "actorId", "denomination", "value"],
    "actor.currency.convert": ["tokenId", "actorId"],
    "actor.effect.duration": ["tokenId", "actorId", "effectId", "duration"],
  };
  const fail = (): never => {
    throw new Error("Invalid bounded native character action");
  };
  const id = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
  const number = (v: unknown, max = 100000) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max;
  const integer = (v: unknown, max = 100000) => number(v, max) && Number.isInteger(v);
  const kind = typeof action["kind"] === "string" ? action["kind"] : "";
  const keys = layouts[kind];
  if (!keys || Object.keys(action).some((k) => k !== "kind" && !keys.includes(k))) fail();
  if (applying && ["party.roster", "actor.state"].includes(kind)) fail();
  if (kind !== "party.roster" && !id(action["tokenId"])) fail();
  for (const key of [
    "actorId",
    "itemId",
    "effectId",
    "sourceMessageId",
    "conditionId",
    "sourceItemId",
    "grantItemId",
    "sourceTokenId",
  ])
    if (action[key] !== undefined && !id(action[key])) fail();
  if (
    ["actor.item.equip", "actor.item.quantity", "actor.item.attune", "actor.item.remove"].includes(
      kind,
    ) &&
    !id(action["itemId"])
  )
    fail();
  if (
    ["actor.effect.duration", "actor.concentration.end"].includes(kind) &&
    !id(action["effectId"])
  )
    fail();
  if (kind === "actor.damage") {
    if (
      !Array.isArray(action["components"]) ||
      !action["components"].length ||
      action["components"].length > 20 ||
      ![0, 0.5, 1, 2].includes(action["multiplier"] as number)
    )
      fail();
    for (const component of action["components"] as unknown[]) {
      if (!component || typeof component !== "object" || Array.isArray(component)) fail();
      const c = component as Record<string, unknown>;
      if (
        Object.keys(c).some((k) => !["type", "value", "properties"].includes(k)) ||
        !id(c["type"]) ||
        !number(c["value"])
      )
        fail();
      const properties = c["properties"];
      if (
        properties !== undefined &&
        (!Array.isArray(properties) || properties.length > 20 || !properties.every(id))
      )
        fail();
    }
  }
  if (kind === "actor.check") {
    if (
      !["skill", "tool", "ability", "save", "death", "concentration"].includes(
        action["check"] as string,
      ) ||
      !["publicroll", "gmroll", "blindroll", "selfroll"].includes(action["rollMode"] as string) ||
      !["normal", "advantage", "disadvantage"].includes(action["advantageMode"] as string)
    )
      fail();
    if (
      ["skill", "tool", "ability", "save"].includes(action["check"] as string) &&
      !id(action["key"])
    )
      fail();
    if (action["ability"] !== undefined && !id(action["ability"])) fail();
    if (
      ["death", "concentration"].includes(action["check"] as string) &&
      action["key"] !== undefined
    )
      fail();
    if (
      ["ability", "save", "death"].includes(action["check"] as string) &&
      action["ability"] !== undefined
    )
      fail();
    if (action["check"] === "death" && action["dc"] !== undefined) fail();
    if (action["dc"] !== undefined && !integer(action["dc"], 1000)) fail();
    if (action["check"] === "concentration" && !integer(action["dc"], 1000)) fail();
  }
  if (
    kind === "actor.condition" &&
    (!id(action["conditionId"]) || typeof action["active"] !== "boolean")
  )
    fail();
  if (kind === "actor.exhaustion" && !integer(action["level"], 20)) fail();
  if (kind === "actor.stabilize" && action["rulingConfirmed"] !== true) fail();
  if (
    kind === "actor.rest" &&
    (!["short", "long"].includes(action["restType"] as string) ||
      action["eligibilityConfirmed"] !== true)
  )
    fail();
  if (
    kind === "actor.hitDie" &&
    (!/^d(6|8|10|12)$/.test(String(action["denomination"])) ||
      !["publicroll", "gmroll", "blindroll", "selfroll"].includes(action["rollMode"] as string))
  )
    fail();
  if (kind === "actor.item.equip" && typeof action["equipped"] !== "boolean") fail();
  if (
    kind === "actor.item.attune" &&
    (typeof action["attuned"] !== "boolean" || action["eligibilityConfirmed"] !== true)
  )
    fail();
  if (kind === "actor.item.quantity" && !integer(action["quantity"])) fail();
  if (
    ["actor.item.grant", "actor.item.copy"].includes(kind) &&
    (!id(action["sourceItemId"]) ||
      !/^[A-Za-z0-9]{16}$/.test(String(action["grantItemId"])) ||
      !integer(action["quantity"]) ||
      action["quantity"] === 0)
  )
    fail();
  if (kind === "actor.item.copy" && !id(action["sourceTokenId"])) fail();
  if (kind === "actor.xp" && !integer(action["value"], 100000000)) fail();
  if (
    kind === "actor.hp.tempmax" &&
    (typeof action["value"] !== "number" ||
      !Number.isInteger(action["value"]) ||
      Math.abs(action["value"]) > 100000)
  )
    fail();
  if (
    kind === "actor.currency" &&
    (!id(action["denomination"]) || !integer(action["value"], 100000000))
  )
    fail();
  if (kind === "actor.effect.duration") {
    const d = action["duration"];
    if (
      !d ||
      typeof d !== "object" ||
      Array.isArray(d) ||
      !Object.keys(d).length ||
      Object.entries(d as Record<string, unknown>).some(
        ([k, v]) => !["seconds", "rounds", "turns"].includes(k) || !integer(v, 100000000),
      )
    )
      fail();
    if (
      (d as Record<string, unknown>)["seconds"] !== undefined &&
      Object.keys(d as object).length !== 1
    )
      fail();
  }
}
