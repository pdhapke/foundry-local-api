import { ATTACK_PROTOCOL, ATTACK_SEQUENCE_PROTOCOL, ATTACK_SEQUENCE_COMMAND, type AttackSequenceInput, type AttackSequenceResult, type AttackInput } from "@foundry-local-api/shared";
import { registerCommand } from "../command-registry.js";
import { inWorldMutationLane } from "../world-mutation-lane.js";
import { executeAttack, attackSequenceLedgerDocument, attackSequenceObservation } from "./attack-actions.js";
type Entry = { input: AttackSequenceInput; pending: boolean; result: AttackSequenceResult; observation?: unknown; consumedBy?: string };
const moduleId = "foundry-local-api";
const validId = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
async function childId(origin: string, step: string, phase: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([origin, step, phase]))))].map(v => v.toString(16).padStart(2, "0")).join("");
}
export async function executeAttackSequence(input: AttackSequenceInput): Promise<AttackSequenceResult> {
  const base: AttackSequenceResult = { schemaVersion: ATTACK_SEQUENCE_PROTOCOL, worldId: input.worldId, userId: input.userId,
    requestId: input.requestId, correlationId: input.correlationId, action: input.action, outcome: "failure", mutated: false, state: null };
  let entry: Entry | undefined; let save: (() => Promise<void>) | undefined;
  try {
    const exact = (value: unknown, keys: string[]) => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
    if (!exact(input, ["schemaVersion", "worldId", "userId", "requestId", "correlationId", "origin", "action"]) || !validId(input.worldId) || !validId(input.userId)
      || !exact(input.action, input.action?.mode === "execute" ? ["mode", "steps", "maxDurationMs"] : ["mode", "priorSequenceRequestId", "continuationId", "maxDurationMs"])) throw Error("Malformed sequence envelope");
    if (input.action.mode !== "execute" && input.action.mode !== "resume") throw Error("Unsupported sequence mode");
    if (input.action.mode === "resume" && (!validId(input.action.priorSequenceRequestId) || !validId(input.action.continuationId))) throw Error("Invalid continuation identifiers");
    if (input.action.mode === "execute") {
      if (!Array.isArray(input.action.steps) || input.action.steps.length < 1 || input.action.steps.length > 4 || new Set(input.action.steps.map(step => step?.stepId)).size !== input.action.steps.length) throw Error("Invalid sequence bounds");
      for (const step of input.action.steps) {
        if (!exact(step, ["stepId", "attack"]) || !validId(step.stepId) || !exact(step.attack, ["mode", "sceneId", "attackerTokenId", "actorId", "itemId", "activityId", "targetTokenId", "advantage", "attackMode", "ammunitionId", "abilityId"])) throw Error("Malformed sequence step");
        const a = step.attack;
        if (a.mode !== "roll" || ![a.sceneId, a.attackerTokenId, a.actorId, a.itemId, a.activityId, a.targetTokenId].every(validId) || !["normal", "advantage", "disadvantage"].includes(a.advantage)
          || [a.attackMode, a.ammunitionId, a.abilityId].some(value => value !== undefined && !validId(value))) throw Error("Invalid attack arguments");
      }
    }
    if (input.schemaVersion !== ATTACK_SEQUENCE_PROTOCOL || input.origin !== "ai-dm" || !validId(input.requestId) || !validId(input.correlationId)
      || !Number.isInteger(input.action.maxDurationMs) || input.action.maxDurationMs < 1000 || input.action.maxDurationMs > 8000) throw Error("Invalid bounded sequence");
    const scope = { schemaVersion: ATTACK_PROTOCOL, worldId: input.worldId, userId: input.userId };
    const doc = await attackSequenceLedgerDocument(scope);
    const flags = doc.toObject()["flags"] as Record<string, Record<string, unknown>>;
    const entries = structuredClone(flags[moduleId]?.["attackSequenceLedger"] ?? {}) as Record<string, Entry>;
    const key = `${input.userId}:${input.requestId}`;
    const prior = entries[key];
    if (prior) return equal(prior.input, input) ? prior.pending ? { ...prior.result, outcome: "uncertain", mutated: true, message: "Pending durable sequence; reconcile without retry" } : prior.result : { ...base, message: "Sequence ID reused with changed arguments" };
    if (Object.values(entries).some(value => value.pending)) throw Error("Prior sequence pending; reconcile without retry");
    if (Object.keys(entries).length >= 128) throw Error("Sequence ledger capacity reached");
    save = async () => {
      await attackSequenceLedgerDocument(scope);
      if (JSON.stringify(entries).length > 1_000_000) throw Error("Sequence ledger capacity reached");
      await doc.update({ [`flags.${moduleId}.attackSequenceLedger`]: structuredClone(entries) });
      const current = (doc.toObject()["flags"] as Record<string, Record<string, unknown>>)[moduleId]?.["attackSequenceLedger"];
      if (!equal(entries, current)) throw Error("Sequence persistence readback mismatch");
    };
    let state: NonNullable<AttackSequenceResult["state"]>;
    if (input.action.mode === "execute") {
      const plan = input.action.steps;
      if (!Array.isArray(plan) || plan.length < 1 || plan.length > 4 || new Set(plan.map(step => step.stepId)).size !== plan.length
        || plan.some(step => !validId(step.stepId) || step.attack.mode !== "roll") || new Set(plan.map(step => step.attack.targetTokenId)).size > 4) throw Error("Invalid explicit attack plan");
      for (const step of plan) {
        const attack = step.attack;
        if (Object.keys(step).some(key => !["stepId", "attack"].includes(key)) || Object.keys(attack).some(key => !["mode", "sceneId", "attackerTokenId", "actorId", "itemId", "activityId", "targetTokenId", "advantage", "attackMode", "ammunitionId", "abilityId"].includes(key))
          || ![attack.sceneId, attack.attackerTokenId, attack.actorId, attack.itemId, attack.activityId, attack.targetTokenId].every(validId)
          || !["normal", "advantage", "disadvantage"].includes(attack.advantage)
          || [attack.attackMode, attack.ammunitionId, attack.abilityId].some(value => value !== undefined && !validId(value))) throw Error("Invalid explicit attack identifiers");
      }
      attackSequenceObservation(scope, plan.map(step => step.attack));
      state = { sequenceRequestId: input.requestId, plan: structuredClone(plan), completedStepCount: 0, steps: [], continuation: null,
        limitations: ["Explicit GM-authorized list; no inferred Multiattack entitlement or action economy.", "Non-atomic. Budget checked between awaited native stages; in-flight native work cannot be cancelled.", "Reaction and uncertain outcomes require manual reconciliation."] };
    } else if (input.action.mode === "resume") {
      const previous = entries[`${input.userId}:${input.action.priorSequenceRequestId}`];
      const ticket = previous?.result.state?.continuation;
      if (!previous || previous.pending || previous.consumedBy || previous.result.outcome !== "partial" || ticket?.id !== input.action.continuationId) throw Error("Continuation unavailable");
      state = structuredClone(previous.result.state!);
      if (!equal(previous.observation, attackSequenceObservation(scope, state.plan.map(step => step.attack)))) throw Error("Continuation state drift; reconcile manually");
      previous.consumedBy = input.requestId; state.continuation = null;
    } else throw Error("Unsupported sequence mode");
    entry = { input: structuredClone(input), pending: true, result: { ...base, outcome: "uncertain", state } }; entries[key] = entry;
    await save();
    const deadline = performance.now() + input.action.maxDurationMs;
    for (let index = state.completedStepCount; index < state.plan.length; index++) {
      if (performance.now() >= deadline) {
        state.continuation = { id: crypto.randomUUID(), priorSequenceRequestId: input.requestId, nextStepIndex: index };
        entry.observation = attackSequenceObservation(scope, state.plan.map(step => step.attack));
        entry.result.outcome = "partial"; break;
      }
      const step = state.plan[index]!;
      const rollInput: AttackInput = { ...scope, requestId: await childId(state.sequenceRequestId, step.stepId, "roll"), correlationId: input.correlationId, origin: "ai-dm", action: step.attack };
      const rollReceipt = await executeAttack(rollInput, deadline, true);
      const row = { stepId: step.stepId, rollReceipt, applyReceipt: null as Awaited<ReturnType<typeof executeAttack>> | null }; state.steps.push(row);
      entry.result.mutated ||= rollReceipt.mutated; await save();
      if (rollReceipt.outcome !== "confirmed") { entry.result.outcome = rollReceipt.outcome; break; }
      if (rollReceipt.state?.["hit"]) {
        row.applyReceipt = await executeAttack({ ...rollInput, requestId: await childId(state.sequenceRequestId, step.stepId, "apply"), action: { mode: "apply", priorAttackRequestId: rollInput.requestId } }, deadline, true);
        entry.result.mutated ||= row.applyReceipt.mutated; await save();
        if (row.applyReceipt.outcome !== "confirmed") { entry.result.outcome = row.applyReceipt.outcome; break; }
      }
      state.completedStepCount++; await save();
      if (state.completedStepCount === state.plan.length) entry.result.outcome = "confirmed";
    }
    entry.pending = entry.result.outcome === "uncertain";
    await save(); return entry.result;
  } catch (error) {
    const result = { ...(entry?.result ?? base), outcome: entry ? "uncertain" as const : "failure" as const, mutated: entry ? true : false, message: error instanceof Error ? error.message : "Sequence unavailable" };
    if (entry) { entry.result = result; entry.pending = true; await save?.().catch(() => {}); }
    return result;
  }
}
registerCommand(ATTACK_SEQUENCE_COMMAND, (input: AttackSequenceInput) => inWorldMutationLane(game, () => executeAttackSequence(input)));
