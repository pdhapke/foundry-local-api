// Phase 52 — Digital TableTops Integration (Battlemap Control).
//
// Four descriptors following the exact `EndpointDescriptor` pattern every
// core domain and dnd5e (Phase 34) use — only mounted through the Phase 32
// integration registry/router (../registry.ts -> ./index.ts's
// `dttIntegration`), active only when the connected world has the
// third-party `digital-tabletops` module active (../types.ts's `detect`).
//
// The target module's four own world settings (`hideUI`/`lockPan`/
// `display-width`/`port-number`, namespace `"digital-tabletops"`) are
// deliberately NOT wrapped here — they're already fully reachable via the
// existing generic `GET/PUT /api/settings/digital-tabletops/:key` endpoints
// (Phase 7); `dtt_get_status` below just surfaces them read-only alongside
// the "TV" user lookup so a caller doesn't have to know that namespace/those
// keys exist at all.
//
// No `annotations` on the write descriptors below, matching dnd5e's own
// precedent (server/src/integrations/dnd5e/endpoints.ts): none of dnd5e's
// seven write-action descriptors set `destructiveHint`/etc. either — that's
// reserved for genuinely dangerous actions like macro execution
// (server/src/endpoints/macros.ts), not an ordinary state-changing action
// like panning a display.
//
// Phase 54 added `mirrorGmViewDescriptor` (`dtt_mirror_gm_view`), the last
// remaining un-parity'd action from the module's own GM toolbar (the literal
// `TV2GM` button) — same no-input/`DttAckResult` shape as
// `scaleToPhysicalDescriptor`.
import { z } from "zod";

import {
  DTT_COMMANDS,
  type DttAckResult,
  type DttPanInput,
  type DttStatusResult,
} from "@foundry-local-api/shared";

import type { AnyEndpointDescriptor, EndpointDescriptor } from "../../endpoints/types.js";

const panSchema = z.object({
  x: z.number(),
  y: z.number(),
  targetWidth: z.number().optional(),
  targetHeight: z.number().optional(),
});

const panDescriptor: EndpointDescriptor<DttPanInput, DttAckResult> = {
  name: "dtt_pan_battlemap",
  description:
    "Pans (and, when both targetWidth and targetHeight are given, scales to fit that region) the digital-tabletops battlemap display's view — the connected Foundry user literally named \"TV\". Advisory only: this broadcasts over Foundry's own multiplayer socket (module.digital-tabletops) and does not read back whether the TV client actually applied it, or whether a TV client is even connected — call dtt_get_status first to check.",
  method: "post",
  path: "/digital-tabletops/pan",
  inputSchema: panSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<DttPanInput, DttAckResult>(DTT_COMMANDS.PAN, input),
};

const scaleToPhysicalDescriptor: EndpointDescriptor<void, DttAckResult> = {
  name: "dtt_scale_battlemap_to_physical",
  description:
    'Scales the digital-tabletops battlemap display (the "TV" Foundry user) so 1 grid unit = 1 real-world inch/mm, per the module\'s configured display-width setting. Advisory only, same caveat as dtt_pan_battlemap — call dtt_get_status first to confirm a TV display is actually connected.',
  method: "post",
  path: "/digital-tabletops/scale-to-physical",
  handler: (_input, { foundryClient }) =>
    foundryClient.call<undefined, DttAckResult>(DTT_COMMANDS.SCALE_TO_PHYSICAL),
};

const mirrorGmViewDescriptor: EndpointDescriptor<void, DttAckResult> = {
  name: "dtt_mirror_gm_view",
  description:
    "Mirrors the GM's current camera view (position and zoom) onto the digital-tabletops battlemap display (the \"TV\" Foundry user) — the literal TV2GM action from the module's own scene-control toolbar. Advisory only, same caveat as dtt_pan_battlemap: this broadcasts over Foundry's own multiplayer socket (module.digital-tabletops) and does not read back whether the TV client actually applied it, or whether a TV client is even connected, or whether the connected bridge client is actually the GM's own screen — call dtt_get_status first to confirm a TV display is actually connected.",
  method: "post",
  path: "/digital-tabletops/mirror-gm-view",
  handler: (_input, { foundryClient }) =>
    foundryClient.call<undefined, DttAckResult>(DTT_COMMANDS.MIRROR_GM_VIEW),
};

const getStatusDescriptor: EndpointDescriptor<void, DttStatusResult> = {
  name: "dtt_get_status",
  description:
    'Convenience composite read for the digital-tabletops integration: whether the module is active, whether a Foundry user named "TV" (case-insensitive, matching dtt.js\'s own check) exists and is currently online, and the module\'s four current world settings (namespace "digital-tabletops": hideUI, lockPan, display-width, port-number — also individually reachable via the generic GET/PUT /api/settings/digital-tabletops/:key endpoints). Call this before dtt_pan_battlemap/dtt_scale_battlemap_to_physical to confirm a display is actually connected.',
  method: "get",
  path: "/digital-tabletops/status",
  handler: (_input, { foundryClient }) =>
    foundryClient.call<undefined, DttStatusResult>(DTT_COMMANDS.GET_STATUS),
};

export const dttEndpointDescriptors: AnyEndpointDescriptor[] = [
  panDescriptor,
  scaleToPhysicalDescriptor,
  mirrorGmViewDescriptor,
  getStatusDescriptor,
];
