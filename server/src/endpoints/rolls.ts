// Phase 14 — Dice Rolling.
//
// A single descriptor wrapping Foundry's `Roll` engine, which only exists
// module-side (the standalone Node server has no access to it) — see
// module/src/commands/rolls.ts for the actual evaluation.
import { z } from "zod";

import {
  ROLL_COMMANDS,
  type RollEvaluateInput,
  type RollEvaluateResult,
} from "@foundry-local-api/shared";

import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";

const rollEvaluateSchema = z.object({
  formula: z.string().min(1),
  data: z.record(z.string(), z.unknown()).optional(),
});

const evaluateRollDescriptor: EndpointDescriptor<RollEvaluateInput, RollEvaluateResult> = {
  name: "foundry_roll_dice",
  description:
    'Evaluates a dice roll formula (e.g. "2d6+3") against Foundry\'s Roll engine and returns the total, the resolved expression, and individual die results. Does not post to chat.',
  method: "post",
  path: "/rolls",
  inputSchema: rollEvaluateSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<RollEvaluateInput, RollEvaluateResult>(ROLL_COMMANDS.EVALUATE, input),
};

export const rollEndpointDescriptors: AnyEndpointDescriptor[] = [evaluateRollDescriptor];
