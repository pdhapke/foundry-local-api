// Phase 43 — World Time / Calendar.
//
// Two endpoints, both wrapping `game.time` (see shared/src/world-time.ts for
// why this stays scoped to `worldTime`/`advance()`). Advancing is GM-only,
// enforced module-side (module/src/commands/world-time.ts) — same
// convention as Phase 7/25's world-scope writes.
import { z } from "zod";

import {
  WORLD_TIME_COMMANDS,
  type AdvanceWorldTimeInput,
  type WorldTimeResult,
} from "@foundry-local-api/shared";

import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";

const advanceSchema = z.object({ seconds: z.number() });

const getWorldTimeDescriptor: EndpointDescriptor<void, WorldTimeResult> = {
  name: "foundry_get_world_time",
  description: "Reads the current world time (game.time.worldTime), in seconds.",
  method: "get",
  path: "/world-time",
  handler: (_input, { foundryClient }) =>
    foundryClient.call<undefined, WorldTimeResult>(WORLD_TIME_COMMANDS.GET),
};

const advanceWorldTimeDescriptor: EndpointDescriptor<AdvanceWorldTimeInput, WorldTimeResult> = {
  name: "foundry_advance_world_time",
  description:
    "Advances the world time by the given number of seconds (negative rewinds it). GM only.",
  method: "post",
  path: "/world-time/advance",
  inputSchema: advanceSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<AdvanceWorldTimeInput, WorldTimeResult>(WORLD_TIME_COMMANDS.ADVANCE, input),
};

export const worldTimeEndpointDescriptors: AnyEndpointDescriptor[] = [
  getWorldTimeDescriptor,
  advanceWorldTimeDescriptor,
];
