// Phase 52 — Digital TableTops Integration (Battlemap Control).
//
// Command names and payload/result shapes for the second optional
// integration (Phase 32/33's framework) and the first `kind: "module"` one
// (dnd5e, Phases 34-35, is `kind: "system"`). Shared between the server's
// integration endpoints (server/src/integrations/digital-tabletops/
// endpoints.ts) and the module's command handlers
// (module/src/commands/digital-tabletops.ts).
//
// Target: the third-party `digital-tabletops` module (installed locally at
// `Data/modules/digital-tabletops/dtt.js`, version 1.0.6 — read directly
// rather than guessed, per PLAN.md's Phase 52 text), which drives a physical
// TV/touch-frame battlemap display for in-person sessions via a Foundry user
// literally named "TV" and a broadcast on Foundry's own multiplayer socket,
// channel `"module.digital-tabletops"` (a third-party channel name, distinct
// from this project's own `MODULE_SOCKET_EVENT` in ./socket.ts — the literal
// string lives locally in module/src/commands/digital-tabletops.ts, not
// exported from here).
//
// The module's four world settings (`display-width`, `port-number`,
// `hideUI`, `lockPan`, namespace `"digital-tabletops"`) need no dedicated
// commands at all — they're already reachable via the existing generic
// `GET/PUT /api/settings/digital-tabletops/:key` endpoints (Phase 7). Only
// `dtt_get_status` reads them, as a read-only convenience composite (same
// role as dnd5e's `dnd5e_get_config`).
// Phase 54 added `MIRROR_GM_VIEW`, the literal `TV2GM` equivalent from the
// installed module's own scene-control toolbar (`dtt.js` lines 196-213): pans
// the TV client to whatever the currently-connected (GM) client's own camera
// is presently centered on. No input, same fire-and-forget-broadcast
// `DttAckResult` shape as `SCALE_TO_PHYSICAL`.
export const DTT_COMMANDS = {
  PAN: "dttPan",
  SCALE_TO_PHYSICAL: "dttScaleToPhysical",
  GET_STATUS: "dttGetStatus",
  MIRROR_GM_VIEW: "dttMirrorGmView",
} as const;

/**
 * `dtt.js`'s own `panCanvas` socket action (lines 90-104 of the installed
 * copy): pans the TV client's canvas to `x, y`. When both `targetWidth` and
 * `targetHeight` are also given, the TV computes a fit scale
 * (`min(screen.width / targetWidth, screen.height / targetHeight)`) instead
 * of keeping its current zoom — the generalized form of `dtt.js`'s own
 * `TV2GM` (mirror GM view) and `panTV` (click-to-location) buttons.
 */
export interface DttPanInput {
  x: number;
  y: number;
  targetWidth?: number | undefined;
  targetHeight?: number | undefined;
}

/**
 * `dtt_pan_battlemap`/`dtt_scale_battlemap_to_physical` are fire-and-forget
 * broadcasts over `game.socket` — Foundry's own socket relays an `emit()` to
 * every *other* connected client but never delivers a reply, so there is no
 * live confirmation that the TV client actually applied it (`dtt_get_status`
 * is the closest thing to a readback: whether a "TV" user is currently
 * online at all). This just acknowledges the emit was made.
 */
export interface DttAckResult {
  acknowledged: true;
}

/**
 * Convenience composite read for the digital-tabletops integration, mirroring
 * dnd5e's `dnd5e_get_config` precedent: not new capability so much as
 * reduced friction, so a caller can confirm a battlemap display is actually
 * connected before driving it without hand-composing four settings reads
 * plus a users-list-and-filter.
 */
export interface DttStatusResult {
  /** Always `true` when this result exists — this command only runs while the digital-tabletops integration is active. */
  moduleActive: boolean;
  tvUser: {
    /** Whether any connected Foundry user's name matches "tv" case-insensitively (`dtt.js`'s own check). */
    found: boolean;
    /** Whether that user is currently online (`FoundryUser#active`). `false` if `found` is `false`. */
    active: boolean;
    /** The matched user's actual (non-lowercased) name, if found. */
    name?: string | undefined;
  };
  /** The `"digital-tabletops"` namespace's four current world-scope settings values. */
  settings: {
    hideUI: boolean;
    lockPan: boolean;
    displayWidth: number;
    portNumber: number;
  };
}
