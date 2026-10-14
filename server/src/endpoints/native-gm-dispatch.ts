import type { NativeGmInput, NativeGmApplyInput, NativeGmReceipt } from "@foundry-local-api/shared";
import type { FoundryClient } from "../bridge/foundry-client.js";
import { FoundryBridgeError } from "../bridge/errors.js";
import {
  enqueueRoutineMutation,
  isRoutineUncertain,
  markRoutineUncertain,
} from "./routine-mutation-lane.js";

export interface AuthenticatedFoundryScope {
  worldId: string;
  userId: string;
  sceneId?: string | undefined;
  correlationId?: string | undefined;
}

/** Bind generic native commands to the same exact authenticated GM and mutation lane. */
export async function dispatchAuthenticatedFoundry<T>(
  client: FoundryClient,
  command: string,
  payload: unknown,
  scope: AuthenticatedFoundryScope,
  mutating = false,
  validateResult?: (result: T) => void,
  isPreDispatchRefusal?: (error: unknown) => boolean,
): Promise<T> {
  const matching = () =>
    client
      .getCapabilityReport()
      .clients.filter(
        (c) =>
          c.userId === scope.userId &&
          c.isGM &&
          c.lane === "gm" &&
          c.optedIn &&
          c.capabilities.includes(command),
      );
  const selected = matching();
  if (selected.length !== 1)
    throw Error("One exact opted-in native GM client required; resolve duplicate GM tabs");
  const owner = selected[0]!;
  const connection = `${owner.clientId}:${owner.connectedAt}`;
  const options = {
    clientId: owner.clientId,
    userId: owner.userId,
    lane: "gm" as const,
    requestingUserId: owner.userId,
    ...(scope.correlationId ? { correlationId: scope.correlationId } : {}),
  };
  const authority = async () => {
    const status = await client.call<undefined, { worldId: string; userId: string }>(
      "status",
      undefined,
      options,
    );
    const user = await client.call<undefined, { isGM: boolean; active: boolean }>(
      "user",
      undefined,
      options,
    );
    if (
      status.worldId !== scope.worldId ||
      status.userId !== scope.userId ||
      !user.isGM ||
      !user.active
    )
      throw Error("Native GM session/world authority unavailable");
    const current = matching();
    if (current.length !== 1 || `${current[0]!.clientId}:${current[0]!.connectedAt}` !== connection)
      throw Error("Native GM connection changed");
  };
  const execute = async (): Promise<T> => {
    await authority();
    if (mutating && isRoutineUncertain(client))
      throw Error("Prior native transport uncertainty requires reconciliation; no new dispatch");
    let dispatched = false;
    try {
      dispatched = mutating;
      const result = await client.call<unknown, T>(command, payload, {
        ...options,
        ...(mutating ? { requireDurableAudit: true } : {}),
      });
      await authority();
      validateResult?.(result);
      return result;
    } catch (error) {
      // Only an exact native pre-reservation acknowledgement can establish that
      // gameplay was not dispatched. Timeouts, generic errors and bad receipts
      // must continue to fence mutations without replay.
      if (dispatched && isPreDispatchRefusal?.(error)) {
        await authority();
        throw error;
      }
      if (dispatched) {
        markRoutineUncertain(client);
        throw Error(
          "Native dispatch acknowledgement uncertain; inspect durable receipt and current documents, do not replay",
        );
      }
      throw error;
    }
  };
  return mutating ? enqueueRoutineMutation(client, execute) : execute();
}

/** Native GM actions add exact durable receipt provenance to the shared transport binding. */
export async function dispatchNativeGm<T>(
  client: FoundryClient,
  command: string,
  input: NativeGmInput,
  mutating = false,
): Promise<T> {
  return dispatchAuthenticatedFoundry<T>(
    client,
    command,
    input,
    {
      worldId: input.worldId,
      userId: input.userId,
      sceneId: input.sceneId,
      ...("correlationId" in input ? { correlationId: String(input.correlationId) } : {}),
    },
    mutating,
    mutating
      ? (result) => {
          const receipt = result as NativeGmReceipt,
            request = input as NativeGmApplyInput;
          if (
            !receipt ||
            receipt.schemaVersion !== input.schemaVersion ||
            receipt.worldId !== input.worldId ||
            receipt.userId !== input.userId ||
            receipt.sceneId !== input.sceneId ||
            receipt.idempotencyKey !== request.idempotencyKey ||
            receipt.correlationId !== request.correlationId ||
            !["confirmed", "failure", "uncertain"].includes(receipt.outcome) ||
            (receipt.outcome === "confirmed" &&
              (!receipt.after || typeof receipt.after !== "object"))
          )
            throw Error("Native acknowledgement scope mismatch");
          if (receipt.outcome === "uncertain") markRoutineUncertain(client);
        }
      : undefined,
    mutating
      ? (error) => {
          if (
            !(error instanceof FoundryBridgeError) ||
            error.code !== "STALE_REVISION" ||
            error.retryable
          )
            return false;
          const details = error.details,
            request = input as NativeGmApplyInput;
          return (
            !!details &&
            details["nativeGmPreflight"] === "before-reservation-v1" &&
            details["gameplayDispatched"] === false &&
            details["schemaVersion"] === request.schemaVersion &&
            details["worldId"] === request.worldId &&
            details["userId"] === request.userId &&
            details["sceneId"] === request.sceneId &&
            details["idempotencyKey"] === request.idempotencyKey &&
            details["correlationId"] === request.correlationId &&
            error.correlationId === request.correlationId
          );
        }
      : undefined,
  );
}
