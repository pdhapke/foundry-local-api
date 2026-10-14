import { z } from "zod";
import { ATTACK_COMMAND, ATTACK_PROTOCOL, ATTACK_STATE_COMMAND, type AttackInput, type AttackResult, type AttackStateInput, ATTACK_SEQUENCE_PROTOCOL, ATTACK_SEQUENCE_COMMAND, type AttackSequenceInput, type AttackSequenceResult } from "@foundry-local-api/shared";
import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";
import { enqueueRoutineMutation, isRoutineUncertain, markRoutineUncertain } from "./routine-mutation-lane.js";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const scope = { schemaVersion: z.literal(ATTACK_PROTOCOL), worldId: id, userId: id };
export const attackActionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("roll"), sceneId: id, attackerTokenId: id, actorId: id, itemId: id,
    activityId: id, targetTokenId: id, advantage: z.enum(["normal", "advantage", "disadvantage"]),
    attackMode: id.optional(), ammunitionId: id.optional(), abilityId: id.optional() }).strict(),
  z.object({ mode: z.literal("apply"), priorAttackRequestId: id, decisionId: id.optional() }).strict(),
]);
export const attackInputSchema = z.object({ ...scope, requestId: id, correlationId: id,
  origin: z.literal("ai-dm"), action: attackActionSchema }).strict();
const state: EndpointDescriptor<AttackStateInput, Record<string, unknown>> = {
  name: "foundry_attack_state", method: "post", path: "/attacks/state",
  description: "Read current GM-only dnd5e attack identifiers, native choice options and unsupported workflows. Player knowledge is separate.",
  inputSchema: z.object({ ...scope, sceneId: id.optional(), actorId: id.optional() }).strict(), annotations: { readOnlyHint: true },
  handler: (input, { foundryClient }) => {
    const client = foundryClient.getCapabilityReport().clients.find(value => value.userId === input.userId && value.lane === "gm" && value.isGM && value.optedIn);
    if (!client) throw Error("Exact GM bridge unavailable");
    return foundryClient.call(ATTACK_STATE_COMMAND, input, { clientId: client.clientId, userId: input.userId, lane: "gm", requestingUserId: input.userId });
  },
};
const receipts = new WeakMap<object, Map<string, { fingerprint: string; result: Promise<AttackResult> }>>();
const attack: EndpointDescriptor<AttackInput, AttackResult> = {
  name: "foundry_attack_confirmed", method: "post", path: "/attacks/confirmed", inputSchema: attackInputSchema,
  description: "Durably deduplicated single native dnd5e attack. Roll and apply are separate; apply references prior evidence. Genuine reaction tickets require explicit human adjudication. Reconcile uncertain outcomes; never retry with a new ID.",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  handler: async (input, { foundryClient }) => {
    const failure = (message: string, uncertain = false): AttackResult => ({ schemaVersion: ATTACK_PROTOCOL,
      worldId: input.worldId, userId: input.userId, requestId: input.requestId, correlationId: input.correlationId,
      action: input.action, outcome: uncertain ? "uncertain" : "failure", mutated: uncertain, state: null, message });
    if (!attackInputSchema.safeParse(input).success) return failure("Invalid attack contract");
    const client = foundryClient.getCapabilityReport().clients.find(value => value.userId === input.userId && value.lane === "gm" && value.isGM && value.optedIn);
    if (!client) return failure("Exact GM bridge unavailable");
    const connection = `${client.clientId}:${client.connectedAt}`;
    const options = { clientId: client.clientId, userId: input.userId, lane: "gm" as const, requestingUserId: input.userId, correlationId: input.correlationId };
    const authorize = async () => {
      const status = await foundryClient.call<undefined, { worldId: string; userId: string }>("status", undefined, options);
      const user = await foundryClient.call<undefined, { isGM: boolean; active: boolean }>("user", undefined, options);
      if (status.worldId !== input.worldId || status.userId !== input.userId || !user.isGM || !user.active) throw Error("Current exact GM/world required");
      const current = foundryClient.getCapabilityReport().clients.find(value => value.clientId === client.clientId && value.userId === input.userId && value.isGM && value.optedIn);
      if (!current || `${current.clientId}:${current.connectedAt}` !== connection) throw Error("GM connection changed");
    };
    try { await authorize(); } catch { return failure("Current authority unavailable"); }
    let cache = receipts.get(foundryClient);
    if (!cache) { cache = new Map(); receipts.set(foundryClient, cache); }
    const key = `${input.worldId}:${input.userId}:${input.requestId}`, fingerprint = JSON.stringify(input);
    const prior = cache.get(key);
    if (prior) return prior.fingerprint === fingerprint ? prior.result : failure("Changed attack arguments under reused ID");
    if (cache.size >= 4096) return failure("Attack receipt capacity reached");
    const result = enqueueRoutineMutation(foundryClient, async () => {
      if (isRoutineUncertain(foundryClient)) return failure("Prior mutation uncertain; reconcile before attacking");
      let dispatched = false;
      try {
        await authorize(); dispatched = true;
        const receipt = await foundryClient.call<AttackInput, AttackResult>(ATTACK_COMMAND, input, options);
        await authorize();
        if (receipt.schemaVersion !== ATTACK_PROTOCOL || receipt.worldId !== input.worldId || receipt.userId !== input.userId
          || receipt.requestId !== input.requestId || receipt.correlationId !== input.correlationId || JSON.stringify(receipt.action) !== JSON.stringify(input.action)
          || !["confirmed", "failure", "uncertain", "decision-required"].includes(receipt.outcome)
          || typeof receipt.mutated !== "boolean" || (receipt.outcome === "confirmed" && (!receipt.state || typeof receipt.state !== "object"))) throw Error("Attack acknowledgement mismatch");
        if (receipt.outcome === "uncertain") markRoutineUncertain(foundryClient);
        return receipt;
      } catch {
        if (dispatched) markRoutineUncertain(foundryClient);
        return failure(dispatched ? "Attack acknowledgement unavailable; reconcile without retry" : "Authority unavailable", dispatched);
      }
    });
    cache.set(key, { fingerprint, result }); return result;
  },
};
export const attackSequenceInputSchema = z.object({ schemaVersion: z.literal(ATTACK_SEQUENCE_PROTOCOL), worldId: id, userId: id, requestId: id, correlationId: id, origin: z.literal("ai-dm"), action: z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("execute"), steps: z.array(z.object({ stepId: id, attack: attackActionSchema.options[0] }).strict()).min(1).max(4).refine(steps => new Set(steps.map(step => step.stepId)).size === steps.length), maxDurationMs: z.number().int().min(1000).max(8000) }).strict(),
  z.object({ mode: z.literal("resume"), priorSequenceRequestId: id, continuationId: id, maxDurationMs: z.number().int().min(1000).max(8000) }).strict()
]) }).strict();
const sequenceReceipts = new WeakMap<object, Map<string, { fingerprint: string; result: Promise<AttackSequenceResult> }>>();
const sequence: EndpointDescriptor<AttackSequenceInput, AttackSequenceResult> = {
  name: "foundry_attack_sequence_confirmed", method: "post", path: "/attacks/sequence", inputSchema: attackSequenceInputSchema,
  description: "Bounded explicit GM-authorized attack list, durable per-step roll/apply evidence and clean deadline continuation. No inferred Multiattack entitlement. Reactions and uncertainty need manual reconciliation. Budget is soft between native stages.",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  handler: async (input, { foundryClient }) => {
    const failure = (message: string, uncertain = false): AttackSequenceResult => ({ schemaVersion: ATTACK_SEQUENCE_PROTOCOL,
      worldId: input.worldId, userId: input.userId, requestId: input.requestId, correlationId: input.correlationId,
      action: input.action, outcome: uncertain ? "uncertain" : "failure", mutated: uncertain, state: null, message });
    if (!attackSequenceInputSchema.safeParse(input).success) return failure("Invalid attack contract");
    const client = foundryClient.getCapabilityReport().clients.find(value => value.userId === input.userId && value.lane === "gm" && value.isGM && value.optedIn);
    if (!client) return failure("Exact GM bridge unavailable");
    const connection = `${client.clientId}:${client.connectedAt}`;
    const options = { clientId: client.clientId, userId: input.userId, lane: "gm" as const, requestingUserId: input.userId, correlationId: input.correlationId };
    const authorize = async () => {
      const status = await foundryClient.call<undefined, { worldId: string; userId: string }>("status", undefined, options);
      const user = await foundryClient.call<undefined, { isGM: boolean; active: boolean }>("user", undefined, options);
      if (status.worldId !== input.worldId || status.userId !== input.userId || !user.isGM || !user.active) throw Error("Current exact GM/world required");
      const current = foundryClient.getCapabilityReport().clients.find(value => value.clientId === client.clientId && value.userId === input.userId && value.isGM && value.optedIn);
      if (!current || `${current.clientId}:${current.connectedAt}` !== connection) throw Error("GM connection changed");
    };
    try { await authorize(); } catch { return failure("Current authority unavailable"); }
    let cache = sequenceReceipts.get(foundryClient);
    if (!cache) { cache = new Map(); sequenceReceipts.set(foundryClient, cache); }
    const key = `${input.worldId}:${input.userId}:${input.requestId}`, fingerprint = JSON.stringify(input);
    const prior = cache.get(key);
    if (prior) return prior.fingerprint === fingerprint ? prior.result : failure("Changed attack arguments under reused ID");
    if (cache.size >= 4096) return failure("Attack receipt capacity reached");
    const result = enqueueRoutineMutation(foundryClient, async () => {
      if (isRoutineUncertain(foundryClient)) return failure("Prior mutation uncertain; reconcile before attacking");
      let dispatched = false;
      try {
        await authorize(); dispatched = true;
        const receipt = await foundryClient.call<AttackSequenceInput, AttackSequenceResult>(ATTACK_SEQUENCE_COMMAND, input, options);
        await authorize();
        if (receipt.schemaVersion !== ATTACK_SEQUENCE_PROTOCOL || receipt.worldId !== input.worldId || receipt.userId !== input.userId
          || receipt.requestId !== input.requestId || receipt.correlationId !== input.correlationId || JSON.stringify(receipt.action) !== JSON.stringify(input.action)
          || !["confirmed", "partial", "failure", "uncertain", "decision-required"].includes(receipt.outcome)
          || typeof receipt.mutated !== "boolean" || (receipt.outcome === "confirmed" && (!receipt.state || typeof receipt.state !== "object"))) throw Error("Attack acknowledgement mismatch");
        if (receipt.outcome === "uncertain") markRoutineUncertain(foundryClient);
        return receipt;
      } catch {
        if (dispatched) markRoutineUncertain(foundryClient);
        return failure(dispatched ? "Attack acknowledgement unavailable; reconcile without retry" : "Authority unavailable", dispatched);
      }
    });
    cache.set(key, { fingerprint, result }); return result;
  },
};
export const attackEndpointDescriptors: AnyEndpointDescriptor[] = [state, attack, sequence];
