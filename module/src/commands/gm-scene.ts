import type { NativeGmInput, NativeGmApplyInput } from "@foundry-local-api/shared";
import { registerCommand } from "../command-registry.js";
import { authorizeNative, nativeToken, runNativeMutation } from "./native-gm-runtime.js";
import { assertCombatMovementBudget, spendCombatMovementBudget } from "./gm-combat.js";
import { preflightTokenTravel, moveTokenVerified } from "./movement-policy.js";
type MoveToken = ReturnType<typeof nativeToken> & {
  move(destination: Record<string, unknown>, options: Record<string, unknown>): Promise<boolean>;
  object?: {
    constrainMovementPath(
      path: Record<string, unknown>[],
      options: Record<string, unknown>,
    ): unknown;
  };
};
function validate(input: NativeGmInput): void {
  authorizeNative(input);
  const a = input.action;
  if (a["kind"] === "recipe.reservation") {
    if (
      Object.keys(a).some((k) => !["kind", "recipeId", "requestFingerprint"].includes(k)) ||
      typeof a["recipeId"] !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(a["recipeId"]) ||
      typeof a["requestFingerprint"] !== "string" ||
      !/^[a-f0-9]{64}$/.test(a["requestFingerprint"])
    )
      throw Error("Bounded native recipe reservation identity required");
    return;
  }
  const keys =
    a["kind"] === "world-time.advance"
      ? ["kind", "seconds", "decision"]
      : a["kind"] === "token.elevation"
        ? ["kind", "tokenId", "elevation", "decision"]
        : a["kind"] === "token.move"
          ? ["kind", "tokenId", "x", "y", "mode", "movementCost", "ruling"]
          : [];
  const ruling = a["kind"] === "token.move" ? a["ruling"] : a["decision"];
  if (
    !keys.length ||
    Object.keys(a).some((k) => !keys.includes(k)) ||
    typeof ruling !== "string" ||
    !ruling.trim() ||
    ruling.length > 1000
  )
    throw Error("Explicit bounded native travel/elevation decision required");
  if (
    a["kind"] === "world-time.advance" &&
    (typeof a["seconds"] !== "number" ||
      !Number.isInteger(a["seconds"]) ||
      a["seconds"] < 0 ||
      a["seconds"] > 31536000)
  )
    throw Error("Bounded positive world time required");
  if (
    a["kind"] === "token.elevation" &&
    (typeof a["tokenId"] !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(a["tokenId"]) ||
      typeof a["elevation"] !== "number" ||
      !Number.isFinite(a["elevation"]) ||
      Math.abs(a["elevation"]) > 100000)
  )
    throw Error("Bounded token elevation required");
  if (
    a["kind"] === "token.move" &&
    (typeof a["tokenId"] !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(a["tokenId"]) ||
      ![a["x"], a["y"]].every(
        (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100000,
      ) ||
      !["walk", "teleport"].includes(String(a["mode"])) ||
      typeof a["movementCost"] !== "number" ||
      !Number.isFinite(a["movementCost"]) ||
      a["movementCost"] < 0 ||
      a["movementCost"] > 10000)
  )
    throw Error("Bounded native movement and explicit scene-unit cost required");
}
export function readGmScene(input: NativeGmInput): Record<string, unknown> {
  validate(input);
  if (input.action["kind"] === "recipe.reservation")
    return {
      worldId: input.worldId,
      sceneId: input.sceneId,
      recipeId: input.action["recipeId"],
      requestFingerprint: input.action["requestFingerprint"],
      reservationOnly: true,
    };
  if (input.action["kind"] === "world-time.advance") {
    if (!Number.isFinite(game.time.worldTime) || typeof game.time.advance !== "function")
      throw Error("Native world time unavailable");
    return { worldId: input.worldId, sceneId: input.sceneId, worldTime: game.time.worldTime };
  }
  const token = nativeToken(input, String(input.action["tokenId"]));
  const d = token.toObject();
  let combatBudget: Record<string, unknown> | null = null;
  if (input.action["kind"] === "token.move") {
    try {
      combatBudget = assertCombatMovementBudget(input, token.id, 0);
    } catch {
      combatBudget = {
        decisionRequired: true,
        reason: "Initialize/reconcile native combat movement budget before movement",
      };
    }
  }
  return {
    worldId: input.worldId,
    sceneId: input.sceneId,
    tokenId: token.id,
    actorId: token.actor?.id ?? null,
    tokenSource: d,
    elevation: d["elevation"],
    x: d["x"],
    y: d["y"],
    revision: d["_stats"] ?? null,
    combatBudget,
  };
}
export async function applyGmScene(input: NativeGmApplyInput) {
  return runNativeMutation(
    input,
    () => readGmScene(input),
    async () => {
      validate(input);
      if (input.action["kind"] === "recipe.reservation") return { reservationOnly: true };
      if (input.action["kind"] === "world-time.advance") {
        const before = game.time.worldTime;
        const value = await game.time.advance(Number(input.action["seconds"]));
        authorizeNative(input);
        if (value !== before + Number(input.action["seconds"]) || game.time.worldTime !== value)
          throw Error("Native world time readback differs");
        return { worldTime: value };
      }
      if (input.action["kind"] === "token.move") {
        const token = nativeToken(input, String(input.action["tokenId"])) as MoveToken;
        const destination = {
          x: Number(input.action["x"]),
          y: Number(input.action["y"]),
          mode: input.action["mode"] as "walk" | "teleport",
        };
        const originalActor = token.actor,
          originalSource = JSON.stringify(token.toObject());
        const originalBudget = assertCombatMovementBudget(input, token.id, 0);
        await spendCombatMovementBudget(input, token.id, Number(input.action["movementCost"]));
        authorizeNative(input);
        const currentBudget = assertCombatMovementBudget(input, token.id, 0);
        if (
          nativeToken(input, token.id) !== token ||
          token.actor !== originalActor ||
          JSON.stringify(token.toObject()) !== originalSource ||
          JSON.stringify([
            originalBudget?.combatId,
            originalBudget?.combatantId,
            originalBudget?.cursor,
          ]) !==
            JSON.stringify([
              currentBudget?.combatId,
              currentBudget?.combatantId,
              currentBudget?.cursor,
            ])
        )
          throw Error(
            "Native token or combat changed while reserving movement budget; reconcile without dispatch",
          );
        preflightTokenTravel(token, destination);
        await moveTokenVerified(token, destination, {
          foundryLocalApiOrigin: {
            source: "foundry-local-api.native-gm",
            correlationId: input.correlationId,
          },
        });
        authorizeNative(input);
        if (nativeToken(input, token.id) !== token || token.actor !== originalActor)
          throw Error("Native movement actor/token binding changed");
        const after = token.toObject();
        if (after["x"] !== destination.x || after["y"] !== destination.y)
          throw Error("Native movement readback differs");
        return {
          tokenId: token.id,
          ...destination,
          movementCost: input.action["movementCost"],
          nativeCollisionChecked: destination.mode === "walk",
        };
      }
      const token = nativeToken(input, String(input.action["tokenId"]));
      await token.update({ elevation: input.action["elevation"] });
      authorizeNative(input);
      if (
        nativeToken(input, token.id) !== token ||
        token.toObject()["elevation"] !== input.action["elevation"]
      )
        throw Error("Native elevation readback differs");
      return { tokenId: token.id, elevation: input.action["elevation"] };
    },
    () => {
      validate(input);
      if (input.action["kind"] !== "token.move") return;
      const token = nativeToken(input, String(input.action["tokenId"])) as MoveToken;
      if (typeof token.move !== "function") throw Error("Native constrained movement unavailable");
      assertCombatMovementBudget(input, token.id, Number(input.action["movementCost"]));
      preflightTokenTravel(token, {
        x: Number(input.action["x"]),
        y: Number(input.action["y"]),
        mode: input.action["mode"] as "walk" | "teleport",
      });
    },
  );
}
registerCommand("gmSceneRead", readGmScene);
registerCommand("gmSceneApply", applyGmScene);
